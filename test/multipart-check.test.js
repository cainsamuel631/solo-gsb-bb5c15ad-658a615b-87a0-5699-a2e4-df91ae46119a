import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { MAX_DECODED_BODY_BYTES } from '../src/multipart-check.js';

const app = buildApp();
const url = '/multipart-check';

function buildMessage(boundary, parts, { trailingCrlf = true } = {}) {
  const chunks = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`, 'ascii'));
    const headers = part.headers ?? [
      'Content-Type: application/octet-stream',
      `Content-Range: bytes ${part.start}-${part.end}/` + part.sizeDeclared,
    ];
    chunks.push(Buffer.from(`${headers.join('\r\n')}\r\n\r\n`, 'ascii'));
    chunks.push(part.data);
    chunks.push(Buffer.from('\r\n', 'ascii'));
  }
  chunks.push(Buffer.from(`--${boundary}--`, 'ascii'));
  if (trailingCrlf) chunks.push(Buffer.from('\r\n', 'ascii'));
  return Buffer.concat(chunks);
}

function part(start, end, size, byte) {
  const fill = byte ?? (start & 0xff);
  return {
    start,
    end,
    sizeDeclared: size,
    data: Buffer.alloc(end - start + 1, fill),
  };
}

function multipartCheck(payload) {
  return app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });
}

function check({ size, expected, boundary = 'BOUNDARY', contentType, body, parts, trailingCrlf }) {
  const message = body ?? buildMessage(boundary, parts ?? [], { trailingCrlf });
  return multipartCheck({
    size,
    expected,
    contentType: contentType ?? `multipart/byteranges; boundary=${boundary}`,
    bodyBase64: message.toString('base64'),
  });
}

test('parts covering exactly the expected ranges are complete', async () => {
  const res = await check({
    size: 100,
    expected: [{ start: 0, end: 49 }, { start: 50, end: 99 }],
    parts: [part(0, 49, 100), part(50, 99, 100)],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.complete, true);
  assert.equal(body.partsCount, 2);
  assert.deepEqual(body.received, [{ start: 0, end: 99 }]);
  assert.deepEqual(body.missing, []);
  assert.deepEqual(body.extra, []);
  assert.equal(body.receivedBytes, 100);
  assert.equal(body.missingBytes, 0);
  assert.equal(body.extraBytes, 0);
});

test('missing middle interval is reported as missing', async () => {
  // Lengths total size (30 + 40 + 30 = 100) but [20,59] overlaps [0,29],
  // leaving gap [60,69] uncovered: received union is [0,59] and [70,99].
  const res = await check({
    size: 100,
    expected: [{ start: 0, end: 99 }],
    parts: [part(0, 29, 100), part(20, 59, 100), part(70, 99, 100)],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.complete, false);
  assert.deepEqual(body.received, [
    { start: 0, end: 59 },
    { start: 70, end: 99 },
  ]);
  assert.deepEqual(body.missing, [{ start: 60, end: 69 }]);
  assert.deepEqual(body.extra, []);
  assert.equal(body.missingBytes, 10);
});

test('received bytes outside the expectation set are reported as extra', async () => {
  // All 100 bytes are sent, but the client only expected the first 80.
  const res = await check({
    size: 100,
    expected: [{ start: 0, end: 79 }],
    parts: [part(0, 79, 100), part(80, 99, 100, 7)],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.complete, false);
  assert.deepEqual(body.received, [{ start: 0, end: 99 }]);
  assert.deepEqual(body.missing, []);
  assert.deepEqual(body.extra, [{ start: 80, end: 99 }]);
  assert.equal(body.extraBytes, 20);
});

test('expected-but-not-received and unexpected bytes are both reported', async () => {
  // Parts tile size in length: [0,29](30) + [20,49](30, overlaps) +
  // [60,89](30) + [90,99](10) -> received union [0,49] and [60,99],
  // missing [50,59]. Expectation is [0,59] only, so [60,99] is extra while
  // [50,59] stays missing.
  const res = await check({
    size: 100,
    expected: [{ start: 0, end: 59 }],
    parts: [part(0, 29, 100), part(20, 49, 100), part(60, 89, 100), part(90, 99, 100)],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.received, [
    { start: 0, end: 49 },
    { start: 60, end: 99 },
  ]);
  assert.deepEqual(body.missing, [{ start: 50, end: 59 }]);
  assert.deepEqual(body.extra, [{ start: 60, end: 99 }]);
  assert.equal(body.complete, false);
});

test('overlapping, adjacent and unordered parts merge into ascending received intervals', async () => {
  // [0,29] + [20,49] (overlap) + [50,59] (adjacent) = [0,59], plus [70,99];
  // lengths total size, the overlap leaves [60,69] uncovered.
  const res = await check({
    size: 100,
    expected: [],
    parts: [
      part(20, 49, 100, 1),
      part(0, 29, 100, 2),
      part(50, 59, 100, 3),
      part(70, 99, 100, 4),
    ],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.received, [
    { start: 0, end: 59 },
    { start: 70, end: 99 },
  ]);
  assert.deepEqual(body.extra, [
    { start: 0, end: 59 },
    { start: 70, end: 99 },
  ]);
});

test('partial overlap with expected intervals yields both missing and extra pieces', async () => {
  // Delivered tiles [0,49] + [50,99]; expected [10,59] only.
  const res = await check({
    size: 100,
    expected: [{ start: 10, end: 59 }],
    parts: [part(0, 49, 100), part(50, 99, 100)],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.received, [{ start: 0, end: 99 }]);
  assert.deepEqual(body.missing, []);
  assert.deepEqual(body.extra, [
    { start: 0, end: 9 },
    { start: 60, end: 99 },
  ]);
  assert.equal(body.complete, false);
});

test('expected gap combined with unexpected tiles yields both sides', async () => {
  // Received [0,59] and [70,99] (overlap in parts totals size), expected
  // [0,99]: missing [60,69]. Then restrict the expectation to [0,59]: the
  // second received tile becomes extra while the gap stays missing.
  const res = await check({
    size: 100,
    expected: [{ start: 0, end: 59 }],
    parts: [part(0, 29, 100), part(20, 59, 100), part(70, 99, 100)],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.received, [
    { start: 0, end: 59 },
    { start: 70, end: 99 },
  ]);
  assert.deepEqual(body.missing, []);
  assert.deepEqual(body.extra, [{ start: 70, end: 99 }]);
});

test('multiple disjoint expected intervals are classified independently', async () => {
  // Received tiles total size: [0,19](20), [40,59](20), [80,99](20), plus
  // [20,39](20) and [60,79](20) -> received is the whole resource. Expect only
  // the first, middle and last 20-byte windows.
  const res = await check({
    size: 100,
    expected: [
      { start: 0, end: 19 },
      { start: 40, end: 59 },
      { start: 80, end: 99 },
    ],
    parts: [
      part(0, 19, 100),
      part(20, 39, 100),
      part(40, 59, 100),
      part(60, 79, 100),
      part(80, 99, 100),
    ],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.complete, false);
  assert.deepEqual(body.received, [{ start: 0, end: 99 }]);
  assert.deepEqual(body.missing, []);
  assert.deepEqual(body.extra, [
    { start: 20, end: 39 },
    { start: 60, end: 79 },
  ]);
});

test('size 0 resource with a degenerate zero-part body is complete', async () => {
  const message = Buffer.from('--BOUNDARY--\r\n', 'ascii');
  const res = await check({ size: 0, expected: [], body: message });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.complete, true);
  assert.equal(body.partsCount, 0);
  assert.deepEqual(body.received, []);
  assert.deepEqual(body.missing, []);
  assert.deepEqual(body.extra, []);
});

test('closing boundary without a trailing CRLF is accepted', async () => {
  const res = await check({
    size: 10,
    expected: [{ start: 0, end: 9 }],
    parts: [part(0, 9, 10)],
    trailingCrlf: false,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().complete, true);
});

test('boundary-looking bytes inside part data never truncate the part', async () => {
  const decoy = Buffer.from('--BOUNDARY\r\nContent-Range: bytes 999-999/100\r\n\r\n', 'ascii');
  const data = Buffer.concat([decoy, Buffer.alloc(50 - decoy.length, 0x41)]);
  assert.equal(data.length, 50);
  const message = buildMessage('BOUNDARY', [
    { start: 0, end: 49, sizeDeclared: 100, data },
    { start: 50, end: 99, sizeDeclared: 100, data: Buffer.alloc(50, 0x42) },
  ]);
  const res = await check({
    size: 100,
    expected: [{ start: 0, end: 99 }],
    body: message,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().complete, true);
});

test('duplicate Content-Range across parts is rejected', async () => {
  const res = await check({
    size: 20,
    expected: [],
    parts: [part(0, 9, 20), part(0, 9, 20)],
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'DUPLICATE_CONTENT_RANGE');
});

test('part lengths that do not total size are rejected', async () => {
  const res = await check({
    size: 100,
    expected: [],
    parts: [part(0, 49, 100), part(50, 98, 100)],
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'TOTAL_SIZE_MISMATCH');
});

test('a part truncated before its declared length is rejected', async () => {
  const message = Buffer.from(
    '--B\r\nContent-Range: bytes 0-99/100\r\n\r\nshort\r\n--B--\r\n',
    'ascii',
  );
  const res = await check({ size: 100, expected: [], body: message, boundary: 'B' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'TRUNCATED_PART');
});

test('a boundary of exactly 1 and 70 chars is accepted', async () => {
  for (const boundary of ['x', 'A'.repeat(70)]) {
    const res = await check({
      size: 10,
      expected: [{ start: 0, end: 9 }],
      boundary,
      parts: [part(0, 9, 10)],
    });
    assert.equal(res.statusCode, 200, `expected 200 for boundary length ${boundary.length}`);
  }
});

test('a quoted boundary parameter is accepted', async () => {
  const message = buildMessage('B-1', [part(0, 9, 10)]);
  const res = await multipartCheck({
    size: 10,
    expected: [{ start: 0, end: 9 }],
    contentType: 'multipart/byteranges; boundary="B-1"',
    bodyBase64: message.toString('base64'),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().complete, true);
});

test('media type matching is case insensitive and parameter OWS tolerated', async () => {
  const message = buildMessage('B', [part(0, 9, 10)]);
  const res = await multipartCheck({
    size: 10,
    expected: [{ start: 0, end: 9 }],
    contentType: 'Multipart/ByteRanges ; boundary=B ; charset=x',
    bodyBase64: message.toString('base64'),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().complete, true);
});

test('invalid boundaries are rejected', async () => {
  const message = buildMessage('B', [part(0, 9, 10)]);
  for (const contentType of [
    'multipart/byteranges; boundary=B_1', // underscore
    'multipart/byteranges; boundary=B 1', // space unquoted
    'multipart/byteranges; boundary=' + 'A'.repeat(71), // too long
    'multipart/byteranges; boundary=""', // empty quoted
    'multipart/byteranges', // missing parameter
    'multipart/form-data; boundary=B', // wrong media type
    'multipart/byteranges; boundary=B; boundary=X', // duplicate
    'multipart/byteranges; boundary="B', // unterminated quote
  ]) {
    const res = await multipartCheck({
      size: 10,
      expected: [],
      contentType,
      bodyBase64: message.toString('base64'),
    });
    assert.equal(res.statusCode, 400, `expected 400 for ${contentType}`);
  }
});

test('message that does not open with the boundary is rejected (preamble)', async () => {
  const message = Buffer.concat([
    Buffer.from('preamble\r\n', 'ascii'),
    buildMessage('B', [part(0, 9, 10)]),
  ]);
  const res = await check({ size: 10, expected: [], body: message, boundary: 'B' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'MALFORMED_MESSAGE');
});

test('trailing data after the closing boundary is rejected (epilogue)', async () => {
  const message = Buffer.concat([
    buildMessage('B', [part(0, 9, 10)], { trailingCrlf: false }),
    Buffer.from('epilogue', 'ascii'),
  ]);
  const res = await check({ size: 10, expected: [], body: message, boundary: 'B' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'MALFORMED_MESSAGE');
});

test('a boundary line terminated by bare LF instead of CRLF is rejected', async () => {
  const message = Buffer.from('--B\nContent-Range: bytes 0-9/10\r\n\r\n' + 'x'.repeat(10) + '\r\n--B--\r\n', 'ascii');
  const res = await check({ size: 10, expected: [], body: message, boundary: 'B' });
  assert.equal(res.statusCode, 400);
});

test('the close delimiter must be preceded by CRLF', async () => {
  const message = Buffer.from('--B\r\nContent-Range: bytes 0-9/10\r\n\r\n' + 'x'.repeat(10) + '--B--\r\n', 'ascii');
  const res = await check({ size: 10, expected: [], body: message, boundary: 'B' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'MALFORMED_MESSAGE');
});

test('a part missing Content-Range is rejected', async () => {
  const message = Buffer.from('--B\r\nContent-Type: application/octet-stream\r\n\r\n' + 'x'.repeat(10) + '\r\n--B--\r\n', 'ascii');
  const res = await check({ size: 10, expected: [], body: message, boundary: 'B' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'MISSING_CONTENT_RANGE');
});

test('Content-Range complete-length differing from size is rejected', async () => {
  const res = await check({
    size: 10,
    expected: [],
    parts: [{ ...part(0, 9, 10), sizeDeclared: 11 }],
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'CONTENT_RANGE_SIZE_MISMATCH');
});

test('Content-Range reaching past the resource end is rejected', async () => {
  const message = Buffer.from(
    '--B\r\nContent-Range: bytes 0-10/10\r\n\r\n' + 'x'.repeat(11) + '\r\n--B--\r\n',
    'ascii',
  );
  const res = await check({ size: 10, expected: [], body: message, boundary: 'B' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'CONTENT_RANGE_OUT_OF_BOUNDS');
});

test('malformed Content-Range syntax is rejected', async () => {
  for (const value of [
    'bytes 0-9',
    'bytes 9-0/10',
    'bytes abc/10',
    'items 0-9/10',
    'bytes 0-9/x',
  ]) {
    const message = Buffer.from(`--B\r\nContent-Range: ${value}\r\n\r\n` + 'x'.repeat(10) + '\r\n--B--\r\n', 'ascii');
    const res = await check({ size: 10, expected: [], body: message, boundary: 'B' });
    assert.equal(res.statusCode, 400, `expected 400 for ${value}`);
    assert.equal(res.json().code, 'INVALID_CONTENT_RANGE');
  }
});

test('duplicate Content-Range header within one part is rejected', async () => {
  const message = Buffer.from(
    '--B\r\nContent-Range: bytes 0-9/10\r\nContent-Range: bytes 0-9/10\r\n\r\n' +
      'x'.repeat(10) +
      '\r\n--B--\r\n',
    'ascii',
  );
  const res = await check({ size: 10, expected: [], body: message, boundary: 'B' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'DUPLICATE_CONTENT_RANGE');
});

test('malformed part header lines are rejected', async () => {
  for (const head of ['Bogus-Line\r\n', ': novalue\r\n', 'Content-Range\r\n', 'X: \r\n']) {
    const message = Buffer.from(`--B\r\n${head}Content-Range: bytes 0-9/10\r\n\r\n` + 'x'.repeat(10) + '\r\n--B--\r\n', 'ascii');
    const res = await check({ size: 10, expected: [], body: message, boundary: 'B' });
    assert.equal(res.statusCode, 400, `expected 400 for head=${JSON.stringify(head)}`);
  }
});

test('more than 16 parts is rejected', async () => {
  const res = await check({
    size: 17,
    expected: [],
    parts: Array.from({ length: 17 }, (_v, i) => part(i, i, 17)),
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'TOO_MANY_SEGMENTS');
});

test('invalid bodyBase64 is rejected', async () => {
  for (const bodyBase64 of ['', 'not base64!', 'AAAA', 'A=AA']) {
    const res = await multipartCheck({
      size: 0,
      expected: [],
      contentType: 'multipart/byteranges; boundary=B',
      bodyBase64,
    });
    assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(bodyBase64)}`);
  }
});

test('a decoded message larger than 1 MiB is rejected', async () => {
  // 3 'A' chars decode to 2 bytes; size the canonical string to decode to
  // exactly 1 MiB (already at the limit), then add another full quartet.
  const quartets = Math.ceil((MAX_DECODED_BODY_BYTES + 1) / 3);
  const bodyBase64 = 'A'.repeat(quartets * 4);
  assert.ok(Buffer.byteLength(bodyBase64, 'base64') > MAX_DECODED_BODY_BYTES);
  const res = await multipartCheck({
    size: 0,
    expected: [],
    contentType: 'multipart/byteranges; boundary=B',
    bodyBase64,
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'BODY_TOO_LARGE');
});

test('a decoded message at the 1 MiB limit is accepted', async () => {
  // One part declaring the whole resource; size the payload so the whole wire
  // message lands exactly on the 1 MiB cap. The header length depends on the
  // digit count of `size`, so converge within a fixed digit-count band.
  const partHeaders = (s) => [`Content-Range: bytes 0-${s - 1}/${s}`];
  const framingFor = (s) =>
    Buffer.byteLength('--B\r\n') +
    Buffer.byteLength(`${partHeaders(s).join('\r\n')}\r\n\r\n`) +
    Buffer.byteLength('\r\n--B--\r\n');

  let size = MAX_DECODED_BODY_BYTES - 64;
  for (let i = 0; i < 10; i += 1) {
    size = MAX_DECODED_BODY_BYTES - framingFor(size);
  }
  // The exact fixed point may sit across a digit-count band; in that case
  // step back until framing + size is within the cap.
  let framing = framingFor(size);
  while (size + framing > MAX_DECODED_BODY_BYTES) {
    size -= 1;
    framing = framingFor(size);
  }
  assert.equal(size + framing, MAX_DECODED_BODY_BYTES);

  const message = buildMessage('B', [
    {
      start: 0,
      end: size - 1,
      sizeDeclared: size,
      data: Buffer.alloc(size, 0x41),
      headers: partHeaders(size),
    },
  ]);
  assert.equal(message.length, MAX_DECODED_BODY_BYTES);
  const res = await multipartCheck({
    size,
    expected: [{ start: 0, end: size - 1 }],
    contentType: 'multipart/byteranges; boundary=B',
    bodyBase64: message.toString('base64'),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().complete, true);
});

test('size must be a non-negative safe integer', async () => {
  for (const size of [-1, 1.5, '10', Number.MAX_SAFE_INTEGER + 1]) {
    const res = await multipartCheck({
      size,
      expected: [],
      contentType: 'multipart/byteranges; boundary=B',
      bodyBase64: Buffer.from('--B--\r\n').toString('base64'),
    });
    assert.equal(res.statusCode, 400, `expected 400 for size=${size}`);
  }
});

test('expected intervals must satisfy 0 <= start <= end < size', async () => {
  for (const expected of [
    [{ start: -1, end: 9 }],
    [{ start: 0, end: 10 }],
    [{ start: 5, end: 4 }],
    [{ start: 0.5, end: 9 }],
    [{ start: '0', end: 9 }],
    [null],
  ]) {
    const res = await multipartCheck({
      size: 10,
      expected,
      contentType: 'multipart/byteranges; boundary=B',
      bodyBase64: Buffer.from('--B--\r\n').toString('base64'),
    });
    assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(expected)}`);
  }
});

test('more than 16 expected intervals is rejected', async () => {
  const res = await multipartCheck({
    size: 100,
    expected: Array.from({ length: 17 }, (_v, i) => ({ start: i, end: i })),
    contentType: 'multipart/byteranges; boundary=B',
    bodyBase64: Buffer.from('--B--\r\n').toString('base64'),
  });
  assert.equal(res.statusCode, 400);
});

test('missing or mistyped fields and extra properties are rejected', async () => {
  const valid = {
    size: 10,
    expected: [],
    contentType: 'multipart/byteranges; boundary=B',
    bodyBase64: Buffer.from('--B--\r\n').toString('base64'),
  };
  for (const payload of [
    {},
    { ...valid, size: undefined },
    { ...valid, expected: undefined },
    { ...valid, contentType: undefined },
    { ...valid, bodyBase64: undefined },
    { ...valid, extra: 1 },
  ]) {
    const res = await multipartCheck(payload);
    assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(payload).slice(0, 80)}`);
  }
});

test('size 0 body carrying a part is rejected', async () => {
  const message = buildMessage('B', [
    { start: 0, end: 0, sizeDeclared: 0, data: Buffer.from('x') },
  ]);
  const res = await check({ size: 0, expected: [], body: message, boundary: 'B' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'CONTENT_RANGE_OUT_OF_BOUNDS');
});

test('error responses carry the shared error shape', async () => {
  const res = await multipartCheck({
    size: 10,
    expected: [],
    contentType: 'multipart/byteranges',
    bodyBase64: Buffer.from('--B--\r\n').toString('base64'),
  });
  assert.equal(res.statusCode, 400);
  const body = res.json();
  assert.equal(body.statusCode, 400);
  assert.equal(body.error, 'Bad Request');
  assert.equal(typeof body.code, 'string');
  assert.equal(typeof body.message, 'string');
});

test('existing endpoints are unaffected', async () => {
  const health = await app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(health.statusCode, 200);

  const plan = await app.inject({
    method: 'POST',
    url: '/plan',
    headers: { Range: 'bytes=0-99', 'content-type': 'application/json' },
    payload: JSON.stringify({ size: 10000 }),
  });
  assert.equal(plan.statusCode, 206);
});
