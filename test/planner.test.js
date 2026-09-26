import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';

const app = buildApp();
const url = '/plan';

function plan({ size, range, contentType }) {
  return app.inject({
    method: 'POST',
    url,
    headers: { Range: range ?? '', 'content-type': 'application/json' },
    payload: JSON.stringify({ size, ...(contentType ? { contentType } : {}) }),
  });
}

test('closed interval is accepted verbatim', async () => {
  const res = await plan({ size: 10000, range: 'bytes=0-499' });
  assert.equal(res.statusCode, 206);
  const body = res.json();
  assert.equal(body.segmentsCount, 1);
  assert.deepEqual(body.segments[0], {
    index: 1,
    start: 0,
    end: 499,
    bytes: 500,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Range': 'bytes 0-499/10000',
    },
    partHeaderBlock:
      'Content-Type: application/octet-stream\r\n' +
      'Content-Range: bytes 0-499/10000\r\n\r\n',
  });
  assert.deepEqual(body.responseHeaders, {
    'Accept-Ranges': 'bytes',
    'Content-Type': 'application/octet-stream',
    'Content-Range': 'bytes 0-499/10000',
    'Content-Length': '500',
  });
  assert.equal(body.multipart, null);
  assert.equal(body.bytes.total, 500);
});

test('open tail range extends to the last byte', async () => {
  const res = await plan({ size: 100, range: 'bytes=95-' });
  assert.equal(res.statusCode, 206);
  const segment = res.json().segments[0];
  assert.deepEqual([segment.start, segment.end], [95, 99]);
  assert.equal(segment.bytes, 5);
});

test('suffix range returns the last N bytes', async () => {
  const res = await plan({ size: 100, range: 'bytes=-25' });
  assert.equal(res.statusCode, 206);
  const segment = res.json().segments[0];
  assert.deepEqual([segment.start, segment.end], [75, 99]);
  assert.equal(segment.bytes, 25);
});

test('suffix longer than the resource clamps to the whole representation (RFC 9110)', async () => {
  const res = await plan({ size: 50, range: 'bytes=-200' });
  assert.equal(res.statusCode, 206);
  const segment = res.json().segments[0];
  assert.deepEqual([segment.start, segment.end], [0, 49]);
  assert.equal(segment.bytes, 50);
  assert.equal(res.json().responseHeaders['Content-Range'], 'bytes 0-49/50');
});

test('suffix equal to the resource covers the whole representation', async () => {
  const res = await plan({ size: 50, range: 'bytes=-50' });
  assert.equal(res.statusCode, 206);
  const segment = res.json().segments[0];
  assert.deepEqual([segment.start, segment.end], [0, 49]);
});

test('end beyond the resource is clamped to the last byte', async () => {
  const res = await plan({ size: 100, range: 'bytes=90-500' });
  assert.equal(res.statusCode, 206);
  const segment = res.json().segments[0];
  assert.deepEqual([segment.start, segment.end], [90, 99]);
});

test('reversed closed interval is dropped as unsatisfiable per spec', async () => {
  const res = await plan({ size: 100, range: 'bytes=50-10' });
  assert.equal(res.statusCode, 416);
});

test('range starting at or beyond size is unsatisfiable', async () => {
  let res = await plan({ size: 100, range: 'bytes=100-200' });
  assert.equal(res.statusCode, 416);
  assert.equal(res.json().responseHeaders['Content-Range'], 'bytes */100');
  res = await plan({ size: 100, range: 'bytes=200-' });
  assert.equal(res.statusCode, 416);
});

test('suffix -0 on a non-empty resource is unsatisfiable', async () => {
  const res = await plan({ size: 100, range: 'bytes=-0' });
  assert.equal(res.statusCode, 416);
  assert.equal(res.json().responseHeaders['Content-Range'], 'bytes */100');
});

test('empty resource cannot satisfy any range', async () => {
  let res = await plan({ size: 0, range: 'bytes=0-' });
  assert.equal(res.statusCode, 416);
  assert.equal(res.json().responseHeaders['Content-Range'], 'bytes */0');
  res = await plan({ size: 0, range: 'bytes=-1' });
  assert.equal(res.statusCode, 416);
});

test('overlapping ranges merge into one segment and skip multipart', async () => {
  const res = await plan({ size: 100, range: 'bytes=0-10,5-20' });
  assert.equal(res.statusCode, 206);
  const body = res.json();
  assert.equal(body.segmentsCount, 1);
  assert.deepEqual([body.segments[0].start, body.segments[0].end], [0, 20]);
  assert.equal(body.bytes.total, 21);
});

test('adjacent ranges merge into one segment', async () => {
  const res = await plan({ size: 100, range: 'bytes=0-9,10-19,20-29' });
  assert.equal(res.statusCode, 206);
  const body = res.json();
  assert.equal(body.segmentsCount, 1);
  assert.deepEqual([body.segments[0].start, body.segments[0].end], [0, 29]);
});

test('separate ranges produce a deterministic multipart plan', async () => {
  const first = await plan({ size: 1000, range: 'bytes=0-99, 200-299' });
  const second = await plan({ size: 1000, range: 'bytes=200-299, 0-99' });
  assert.equal(first.statusCode, 206);
  assert.equal(second.statusCode, 206);

  const a = first.json();
  const b = second.json();

  // Same merged plan => same deterministic boundary and same segments order
  // (first appearance order, per range-parser combine semantics).
  assert.equal(a.multipart.boundary, b.multipart.boundary);
  assert.match(a.multipart.boundary, /^brp-[0-9a-f]{48}$/);
  assert.equal(a.segmentsCount, 2);
  assert.deepEqual(
    a.segments.map((s) => [s.start, s.end]),
    [
      [0, 99],
      [200, 299],
    ],
  );
  assert.deepEqual(
    b.segments.map((s) => [s.start, s.end]),
    [
      [200, 299],
      [0, 99],
    ],
  );

  assert.equal(a.responseHeaders['Content-Type'], `multipart/byteranges; boundary=${a.multipart.boundary}`);

  // Byte accounting: two 100-byte payloads plus the multipart framing.
  assert.equal(a.bytes.selected, 200);
  const boundary = a.multipart.boundary;
  const expectedFraming =
    (`--${boundary}\r\n`.length + a.segments[0].partHeaderBlock.length + 2) +
    (`--${boundary}\r\n`.length + a.segments[1].partHeaderBlock.length + 2) +
    `--${boundary}--\r\n`.length;
  assert.equal(a.bytes.framing, expectedFraming);
  assert.equal(a.bytes.total, 200 + expectedFraming);
  assert.equal(a.responseHeaders['Content-Length'], String(a.bytes.total));
});

test('unsatisfiable specs in a mixed list are dropped, rest are served', async () => {
  const res = await plan({ size: 10000, range: 'bytes=0-9,500-600,9000-' });
  assert.equal(res.statusCode, 206);
  const body = res.json();
  assert.deepEqual(
    body.segments.map((s) => [s.start, s.end]),
    [
      [0, 9],
      [500, 600],
      [9000, 9999],
    ],
  );
  assert.equal(body.segmentsCount, 3);
});

test('whitespace and multiple spaces around commas are tolerated', async () => {
  const res = await plan({ size: 10000, range: 'bytes = 0-9 , 9000 - 9099' });
  assert.equal(res.statusCode, 206);
  assert.equal(res.json().segmentsCount, 2);
});

test('more than 16 merged segments yields 422 TOO_MANY_SEGMENTS', async () => {
  const specs = Array.from({ length: 17 }, (_, i) => `${i * 10}-${i * 10 + 1}`).join(',');
  const res = await plan({ size: 1000, range: `bytes=${specs}` });
  assert.equal(res.statusCode, 422);
  const body = res.json();
  assert.equal(body.code, 'TOO_MANY_SEGMENTS');
  assert.equal(body.segmentsCount, 17);
  assert.equal(body.maxSegments, 16);
});

test('exactly 16 merged segments are allowed', async () => {
  const specs = Array.from({ length: 16 }, (_, i) => `${i * 100}-${i * 100 + 1}`).join(',');
  const res = await plan({ size: 10000, range: `bytes=${specs}` });
  assert.equal(res.statusCode, 206);
  assert.equal(res.json().segmentsCount, 16);
});

test('planned transfer over 2x the resource size yields 422 TRANSFER_LIMIT_EXCEEDED', async () => {
  // size=50, 16 single-byte segments: 16 payload bytes but long part headers.
  const specs = Array.from({ length: 16 }, (_, i) => `${i * 3}-${i * 3}`).join(',');
  const res = await plan({
    size: 50,
    range: `bytes=${specs}`,
    contentType: 'application/x-very-long-mediatype-name-for-overhead-v1',
  });
  assert.equal(res.statusCode, 422);
  const body = res.json();
  assert.equal(body.code, 'TRANSFER_LIMIT_EXCEEDED');
  assert.equal(body.segmentsCount, 16);
  assert.ok(body.transferBytes > 100);
  assert.equal(body.limitBytes, 100);
});

test('planned transfer at or below 2x the resource size is accepted', async () => {
  // Two far-apart ranges: 2 payload bytes plus multipart framing, which fits
  // comfortably under 2 * 200 = 400.
  const res = await plan({ size: 200, range: 'bytes=0-0,199-199', contentType: 'a/b' });
  assert.equal(res.statusCode, 206);
  const body = res.json();
  assert.ok(body.bytes.total <= 400, `total ${body.bytes.total} should be <= 2x resource`);
});

test('syntactically malformed Range headers yield 400', async () => {
  for (const range of ['0-99', 'bytes', 'bytes=', 'bytes=-', 'bytes=abc-5', 'bytes=1,', 'bytes=1-2-3', '']) {
    const res = await plan({ size: 100, range });
    assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(range)}`);
    assert.equal(res.json().code, 'MALFORMED_RANGE');
  }
});

test('non-byte range units yield 400 UNSUPPORTED_RANGE_UNIT', async () => {
  const res = await plan({ size: 100, range: 'items=0-9' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'UNSUPPORTED_RANGE_UNIT');
});

test('missing Range header yields 400 MISSING_RANGE', async () => {
  const res = await app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ size: 100 }),
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'MISSING_RANGE');
});

test('invalid size is rejected by schema validation', async () => {
  const res = await app.inject({
    method: 'POST',
    url,
    headers: { Range: 'bytes=0-1', 'content-type': 'application/json' },
    payload: JSON.stringify({ size: -1 }),
  });
  assert.equal(res.statusCode, 400);
});

test('invalid contentType is rejected', async () => {
  const res = await plan({ size: 100, range: 'bytes=0-1', contentType: 'not a media type' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'INVALID_CONTENT_TYPE');
});

test('GET endpoint supports query-based planning', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/plan?size=1000&contentType=application/pdf',
    headers: { Range: 'bytes=-100' },
  });
  assert.equal(res.statusCode, 206);
  const body = res.json();
  assert.deepEqual([body.segments[0].start, body.segments[0].end], [900, 999]);
  assert.equal(body.responseHeaders['Content-Type'], 'application/pdf');
});

test('health endpoint', async () => {
  const res = await app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: 'ok' });
});
