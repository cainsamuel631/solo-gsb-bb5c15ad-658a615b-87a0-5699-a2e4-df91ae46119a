import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';

const app = buildApp();
const url = '/multipart-check';

function multipartCheck(payload) {
  return app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });
}

const CRLF = '\r\n';

// Build a canonical multipart/byteranges wire body from [range, data] parts.
function buildMessage(boundary, parts) {
  let body = '';
  for (const [{ start, end, size }, data] of parts) {
    body += `--${boundary}${CRLF}`;
    body += `Content-Range: bytes ${start}-${end}/${size}${CRLF}${CRLF}`;
    body += data;
    body += CRLF;
  }
  body += `--${boundary}--${CRLF}`;
  return Buffer.from(body, 'latin1');
}

function check({ size, expected, boundary = 'bnd-123', parts, extraParams = '', body }) {
  const buffer = body ?? buildMessage(boundary, parts);
  return multipartCheck({
    size,
    expected,
    contentType: `multipart/byteranges; boundary=${boundary}${extraParams}`,
    bodyBase64: buffer.toString('base64'),
  });
}

const dataFor = (length, fill = 0x61) => Buffer.alloc(length, fill).toString('latin1');

test('exact parts covering the expected ranges report complete with merged received', async () => {
  const res = await check({
    size: 100,
    expected: [{ start: 0, end: 49 }],
    parts: [
      [{ start: 0, end: 9, size: 100 }, dataFor(10)],
      [{ start: 10, end: 49, size: 100 }, dataFor(40, 0x62)],
    ],
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    statusCode: 200,
    received: [{ start: 0, end: 49 }],
    missing: [],
    extra: [],
    complete: true,
  });
});

test('unordered overlapping parts merge; expected gaps and extra bytes are reported', async () => {
  const res = await check({
    size: 100,
    expected: [{ start: 0, end: 30 }, { start: 90, end: 99 }],
    parts: [
      [{ start: 90, end: 99, size: 100 }, dataFor(10)],
      [{ start: 20, end: 60, size: 100 }, dataFor(41)],
      [{ start: 0, end: 25, size: 100 }, dataFor(26)],
    ],
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    statusCode: 200,
    received: [{ start: 0, end: 60 }, { start: 90, end: 99 }],
    missing: [],
    extra: [{ start: 31, end: 60 }],
    complete: false,
  });
});

test('missing bytes are the expected intervals minus received', async () => {
  const res = await check({
    size: 100,
    expected: [{ start: 0, end: 99 }],
    parts: [
      [{ start: 10, end: 19, size: 100 }, dataFor(10)],
      [{ start: 80, end: 99, size: 100 }, dataFor(20)],
    ],
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    statusCode: 200,
    received: [{ start: 10, end: 19 }, { start: 80, end: 99 }],
    missing: [{ start: 0, end: 9 }, { start: 20, end: 79 }],
    extra: [],
    complete: false,
  });
});

test('empty expected intervals still allow parts; every byte is extra', async () => {
  const res = await check({
    size: 10,
    expected: [],
    parts: [[{ start: 0, end: 9, size: 10 }, dataFor(10)]],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.received, [{ start: 0, end: 9 }]);
  assert.deepEqual(body.missing, []);
  assert.deepEqual(body.extra, [{ start: 0, end: 9 }]);
  assert.equal(body.complete, false);
});

test('a valid zero-part body and zero-length resource are accepted', async () => {
  const boundary = 'x';
  const res = await check({
    size: 0,
    expected: [],
    boundary,
    body: Buffer.from(`--${boundary}--${CRLF}`, 'latin1'),
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    statusCode: 200,
    received: [],
    missing: [],
    extra: [],
    complete: true,
  });
});

test('quoted boundary and extra media-type parameters are accepted', async () => {
  const boundary = 'My-Boundary-42';
  const res = await check({
    size: 10,
    expected: [{ start: 0, end: 9 }],
    boundary,
    body: buildMessage(boundary, [[{ start: 0, end: 9, size: 10 }, dataFor(10)]]),
  });
  // Build the request manually to quote the boundary.
  const direct = await multipartCheck({
    size: 10,
    expected: [{ start: 0, end: 9 }],
    contentType: 'multipart/byteranges; charset=utf-8; boundary="My-Boundary-42"; foo=bar',
    bodyBase64: buildMessage(boundary, [[{ start: 0, end: 9, size: 10 }, dataFor(10)]]).toString('base64'),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(direct.statusCode, 200);
  assert.equal(direct.json().complete, true);
});

test('a boundary-shaped byte sequence that is not a valid delimiter does not truncate the part', async () => {
  const boundary = 'b';
  const payload = `foo${CRLF}--${boundary}X${CRLF}bar`; // "--bX" cannot start a delimiter
  assert.equal(payload.length, 14);
  const wire =
    `--${boundary}${CRLF}Content-Range: bytes 0-13/14${CRLF}${CRLF}` +
    payload +
    `${CRLF}--${boundary}--${CRLF}`;
  const res = await multipartCheck({
    size: 14,
    expected: [{ start: 0, end: 13 }],
    contentType: 'multipart/byteranges; boundary=b',
    bodyBase64: Buffer.from(wire, 'latin1').toString('base64'),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().complete, true);
});

test('boundary at the very start of part data preceded only by header CRLF is parsed', async () => {
  const boundary = 'b';
  const payload = `--${boundary}x`; // "--bx" is not a delimiter
  const wire =
    `--${boundary}${CRLF}Content-Range: bytes 0-3/4${CRLF}${CRLF}` +
    payload +
    `${CRLF}--${boundary}--${CRLF}`;
  const res = await multipartCheck({
    size: 4,
    expected: [{ start: 0, end: 3 }],
    contentType: 'multipart/byteranges; boundary=b',
    bodyBase64: Buffer.from(wire, 'latin1').toString('base64'),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().complete, true);
});

test('extra part headers such as Content-Type are allowed and case-insensitive', async () => {
  const boundary = 'b';
  const wire =
    `--${boundary}${CRLF}` +
    `content-type: application/octet-stream${CRLF}` +
    `CONTENT-RANGE: bytes 0-2/3${CRLF}${CRLF}` +
    'abc' +
    `${CRLF}--${boundary}--${CRLF}`;
  const res = await multipartCheck({
    size: 3,
    expected: [{ start: 0, end: 2 }],
    contentType: 'multipart/byteranges; boundary=b',
    bodyBase64: Buffer.from(wire, 'latin1').toString('base64'),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().complete, true);
});

test('LF-only line endings are rejected', async () => {
  const boundary = 'b';
  const res = await check({
    size: 3,
    expected: [{ start: 0, end: 2 }],
    boundary,
    body: Buffer.from(`--${boundary}\nContent-Range: bytes 0-2/3\n\nabc\n--${boundary}--\n`),
  });
  assert.equal(res.statusCode, 400);
});

test('a preamble before the first boundary is rejected', async () => {
  const boundary = 'b';
  const res = await check({
    size: 3,
    expected: [{ start: 0, end: 2 }],
    boundary,
    body: Buffer.from(`junk${CRLF}--${boundary}${CRLF}Content-Range: bytes 0-2/3${CRLF}${CRLF}abc${CRLF}--${boundary}--${CRLF}`),
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /no preamble/);
});

test('an epilogue after the closing boundary is rejected', async () => {
  const boundary = 'b';
  const res = await check({
    size: 3,
    expected: [{ start: 0, end: 2 }],
    boundary,
    body: Buffer.from(`--${boundary}${CRLF}Content-Range: bytes 0-2/3${CRLF}${CRLF}abc${CRLF}--${boundary}--${CRLF}tail`),
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /no epilogue/);
});

test('a missing closing boundary is rejected', async () => {
  const boundary = 'b';
  const res = await check({
    size: 3,
    expected: [{ start: 0, end: 2 }],
    boundary,
    // First part is complete; the second opens a boundary and headers but is
    // never closed, so the error is structural rather than a header problem.
    body: Buffer.from(
      `--${boundary}${CRLF}Content-Range: bytes 0-2/3${CRLF}${CRLF}abc${CRLF}` +
        `--${boundary}${CRLF}Content-Range: bytes 0-2/3${CRLF}${CRLF}abc`,
    ),
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'MALFORMED_MULTIPART');
});

test('boundary without terminating CRLF is rejected', async () => {
  const boundary = 'b';
  const res = await check({
    size: 3,
    expected: [{ start: 0, end: 2 }],
    boundary,
    body: Buffer.from(`--${boundary}Content-Range: bytes 0-2/3${CRLF}${CRLF}abc${CRLF}--${boundary}--${CRLF}`),
  });
  assert.equal(res.statusCode, 400);
});

test('part without Content-Range is rejected', async () => {
  const boundary = 'b';
  const wire = `--${boundary}${CRLF}Content-Type: text/plain${CRLF}${CRLF}abc${CRLF}--${boundary}--${CRLF}`;
  const res = await multipartCheck({
    size: 3,
    expected: [{ start: 0, end: 2 }],
    contentType: 'multipart/byteranges; boundary=b',
    bodyBase64: Buffer.from(wire, 'latin1').toString('base64'),
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'MISSING_CONTENT_RANGE');
});

test('duplicate Content-Range headers within a part are rejected', async () => {
  const boundary = 'b';
  const wire =
    `--${boundary}${CRLF}Content-Range: bytes 0-2/3${CRLF}Content-Range: bytes 0-2/3${CRLF}${CRLF}` +
    `abc${CRLF}--${boundary}--${CRLF}`;
  const res = await multipartCheck({
    size: 3,
    expected: [{ start: 0, end: 2 }],
    contentType: 'multipart/byteranges; boundary=b',
    bodyBase64: Buffer.from(wire, 'latin1').toString('base64'),
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'DUPLICATE_CONTENT_RANGE');
});

test('the same Content-Range in two parts is rejected', async () => {
  const res = await check({
    size: 100,
    expected: [{ start: 0, end: 9 }],
    boundary: 'b',
    parts: [
      [{ start: 0, end: 4, size: 100 }, dataFor(5)],
      [{ start: 0, end: 4, size: 100 }, dataFor(5)],
    ],
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'DUPLICATE_CONTENT_RANGE');
});

test('a wrong complete-length in Content-Range is rejected', async () => {
  const res = await check({
    size: 100,
    expected: [{ start: 0, end: 2 }],
    boundary: 'b',
    parts: [[{ start: 0, end: 2, size: 99 }, dataFor(3)]],
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'CONTENT_RANGE_COMPLETE_LENGTH_MISMATCH');
});

test('an out-of-resource Content-Range is rejected', async () => {
  const res = await check({
    size: 10,
    expected: [{ start: 0, end: 9 }],
    boundary: 'b',
    parts: [[{ start: 9, end: 10, size: 10 }, dataFor(2)]],
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'CONTENT_RANGE_OUT_OF_BOUNDS');
});

test('declared range length differing from actual bytes is rejected', async () => {
  const res = await check({
    size: 100,
    expected: [{ start: 0, end: 4 }],
    boundary: 'b',
    parts: [[{ start: 0, end: 4, size: 100 }, dataFor(4)]], // declared 5, 4 present
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'PART_BYTE_LENGTH_MISMATCH');
});

test('malformed Content-Range values are rejected', async () => {
  const boundary = 'b';
  for (const value of ['bytes 0-2', 'bytes 0-2/', '0-2/3', 'bytes 2-0/3', 'bytes  0-2/3', 'bytes 0-2/3 extra']) {
    const wire = `--${boundary}${CRLF}Content-Range: ${value}${CRLF}${CRLF}abc${CRLF}--${boundary}--${CRLF}`;
    const res = await multipartCheck({
      size: 3,
      expected: [{ start: 0, end: 2 }],
      contentType: 'multipart/byteranges; boundary=b',
      bodyBase64: Buffer.from(wire, 'latin1').toString('base64'),
    });
    assert.equal(res.statusCode, 400, `expected 400 for Content-Range '${value}'`);
  }
});

test('more than 16 parts is rejected', async () => {
  const parts = Array.from({ length: 17 }, (_, i) => [{ start: i, end: i, size: 17 }, 'x']);
  const res = await check({
    size: 17,
    expected: [{ start: 0, end: 16 }],
    boundary: 'b',
    parts,
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'TOO_MANY_PARTS');
});

test('wrong media type and missing boundary parameter are rejected', async () => {
  const payload = {
    size: 3,
    expected: [{ start: 0, end: 2 }],
    contentType: 'multipart/mixed; boundary=b',
    bodyBase64: Buffer.from('abc').toString('base64'),
  };
  const wrongType = await multipartCheck(payload);
  assert.equal(wrongType.statusCode, 400);
  assert.equal(wrongType.json().code, 'INVALID_CONTENT_TYPE');

  const noBoundary = await multipartCheck({ ...payload, contentType: 'multipart/byteranges' });
  assert.equal(noBoundary.statusCode, 400);
  assert.equal(noBoundary.json().code, 'MISSING_BOUNDARY');
});

test('invalid boundaries are rejected', async () => {
  const body = {
    size: 1,
    expected: [{ start: 0, end: 0 }],
    bodyBase64: Buffer.from('x').toString('base64'),
  };
  for (const boundary of ['', 'bad space', 'bad"quote', 'a_b', 'é', 'a'.repeat(71)]) {
    const res = await multipartCheck({
      ...body,
      contentType: `multipart/byteranges; boundary=${JSON.stringify(boundary)}`,
    });
    assert.equal(res.statusCode, 400, `expected 400 for boundary '${boundary}'`);
  }
});

test('a 70-character boundary is accepted', async () => {
  const boundary = 'a'.repeat(70);
  const res = await check({
    size: 1,
    expected: [{ start: 0, end: 0 }],
    boundary,
    parts: [[{ start: 0, end: 0, size: 1 }, 'x']],
  });
  assert.equal(res.statusCode, 200);
});

test('duplicate boundary parameters are rejected', async () => {
  const res = await multipartCheck({
    size: 1,
    expected: [{ start: 0, end: 0 }],
    contentType: 'multipart/byteranges; boundary=a; boundary=b',
    bodyBase64: Buffer.from('x').toString('base64'),
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'INVALID_CONTENT_TYPE');
});

test('invalid base64 is rejected', async () => {
  const base = { size: 1, expected: [{ start: 0, end: 0 }], contentType: 'multipart/byteranges; boundary=b' };
  for (const bodyBase64 of ['====', 'abcd!', 'YWJ===', 'AA==AAAA']) {
    const res = await multipartCheck({ ...base, bodyBase64 });
    assert.equal(res.statusCode, 400, `expected 400 for base64 '${bodyBase64}'`);
    assert.equal(res.json().code, 'INVALID_BODY_BASE64');
  }
});

test('a decoded body above 1 MiB is rejected', async () => {
  const boundary = 'b';
  const size = 1024 * 1024 + 1;
  const payload = Buffer.alloc(size, 0x61);
  const wire = Buffer.concat([
    Buffer.from(`--${boundary}${CRLF}Content-Range: bytes 0-${size - 1}/${size}${CRLF}${CRLF}`),
    payload,
    Buffer.from(`${CRLF}--${boundary}--${CRLF}`),
  ]);
  const res = await multipartCheck({
    size,
    expected: [{ start: 0, end: size - 1 }],
    contentType: 'multipart/byteranges; boundary=b',
    bodyBase64: wire.toString('base64'),
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'MESSAGE_TOO_LARGE');
});

test('strict schema rejects non-integers, negatives, unknown fields and bad types', async () => {
  const valid = {
    size: 10,
    expected: [{ start: 0, end: 9 }],
    contentType: 'multipart/byteranges; boundary=b',
    bodyBase64: Buffer.from('x').toString('base64'),
  };
  const variants = [
    { ...valid, size: '10' },
    { ...valid, size: 1.5 },
    { ...valid, size: -1 },
    { ...valid, expected: [{ start: -1, end: 9 }] },
    { ...valid, expected: [{ start: 5, end: 9, extra: 1 }] },
    { ...valid, expected: 'x' },
    { ...valid, contentType: 1 },
    { ...valid, bodyBase64: 123 },
    { ...valid, bodyBase64: '' },
    { ...valid, unknown: true },
    { size: 10, expected: [{ start: 0, end: 9 }], contentType: 'multipart/byteranges; boundary=b' },
  ];
  for (const payload of variants) {
    const res = await multipartCheck(payload);
    assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(payload)}`);
  }
});

test('expected intervals outside the resource are rejected', async () => {
  const res = await multipartCheck({
    size: 10,
    expected: [{ start: 0, end: 10 }],
    contentType: 'multipart/byteranges; boundary=b',
    bodyBase64: Buffer.from('x').toString('base64'),
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'EXPECTED_RANGE_OUT_OF_BOUNDS');
});

test('reversed expected intervals are rejected', async () => {
  const res = await multipartCheck({
    size: 10,
    expected: [{ start: 9, end: 8 }],
    contentType: 'multipart/byteranges; boundary=b',
    bodyBase64: Buffer.from('x').toString('base64'),
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'INVALID_EXPECTED_RANGE');
});

test('more than 16 expected intervals is rejected', async () => {
  const res = await multipartCheck({
    size: 100,
    expected: Array.from({ length: 17 }, (_, i) => ({ start: i, end: i })),
    contentType: 'multipart/byteranges; boundary=b',
    bodyBase64: Buffer.from('x').toString('base64'),
  });
  assert.equal(res.statusCode, 400);
});
