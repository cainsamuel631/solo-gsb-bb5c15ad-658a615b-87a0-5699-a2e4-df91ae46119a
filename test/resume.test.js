import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';

const app = buildApp();
const url = '/resume-plan';

function resumePlan(payload) {
  return app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });
}

test('no completed intervals splits the whole resource into chunks', async () => {
  const res = await resumePlan({ size: 1000, completed: [], chunkBytes: 400, limit: 10 });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.completedBytes, 0);
  assert.equal(body.remainingBytes, 1000);
  assert.equal(body.hasMore, false);
  assert.equal(body.requestsCount, 3);
  assert.deepEqual(
    body.requests.map((r) => [r.start, r.end, r.rangeHeader]),
    [
      [0, 399, 'bytes=0-399'],
      [400, 799, 'bytes=400-799'],
      [800, 999, 'bytes=800-999'],
    ],
  );
  assert.deepEqual(body.requests.map((r) => r.index), [1, 2, 3]);
  assert.deepEqual(body.requests.map((r) => r.bytes), [400, 400, 200]);
});

test('gaps between completed intervals are planned ascending by offset', async () => {
  const res = await resumePlan({
    size: 1000,
    completed: [{ start: 200, end: 299 }, { start: 600, end: 699 }],
    chunkBytes: 1000,
    limit: 10,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.completedBytes, 200);
  assert.equal(body.remainingBytes, 800);
  assert.equal(body.hasMore, false);
  assert.deepEqual(
    body.requests.map((r) => [r.start, r.end]),
    [
      [0, 199],
      [300, 599],
      [700, 999],
    ],
  );
});

test('unordered, overlapping and adjacent intervals merge before gap planning', async () => {
  const res = await resumePlan({
    size: 100,
    completed: [
      { start: 40, end: 59 }, // overlaps and extends [30,49]
      { start: 10, end: 19 }, // adjacent to [0,9]
      { start: 30, end: 49 },
      { start: 0, end: 9 },
      { start: 80, end: 99 },
    ],
    chunkBytes: 1000,
    limit: 10,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  // Merged: [0,19], [30,59], [80,99] -> gaps [20,29] and [60,79].
  assert.equal(body.completedBytes, 70);
  assert.equal(body.remainingBytes, 30);
  assert.deepEqual(
    body.requests.map((r) => [r.start, r.end]),
    [
      [20, 29],
      [60, 79],
    ],
  );
});

test('duplicate and nested intervals are not double counted', async () => {
  const res = await resumePlan({
    size: 100,
    completed: [
      { start: 0, end: 49 },
      { start: 0, end: 49 },
      { start: 10, end: 20 },
    ],
    chunkBytes: 1000,
    limit: 10,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.completedBytes, 50);
  assert.equal(body.remainingBytes, 50);
  assert.deepEqual(body.requests.map((r) => [r.start, r.end]), [[50, 99]]);
});

test('limit caps the request list and sets hasMore', async () => {
  const res = await resumePlan({ size: 1000, completed: [], chunkBytes: 100, limit: 3 });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.requestsCount, 3);
  assert.equal(body.hasMore, true);
  assert.deepEqual(
    body.requests.map((r) => [r.start, r.end]),
    [
      [0, 99],
      [100, 199],
      [200, 299],
    ],
  );
  assert.equal(body.remainingBytes, 1000);
});

test('hasMore is false when the limit covers every missing byte', async () => {
  const res = await resumePlan({ size: 250, completed: [], chunkBytes: 100, limit: 3 });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.requestsCount, 3);
  assert.equal(body.hasMore, false);
  assert.deepEqual(body.requests.map((r) => r.bytes), [100, 100, 50]);
});

test('limit larger than the needed chunk count returns every chunk', async () => {
  const res = await resumePlan({ size: 10, completed: [], chunkBytes: 4, limit: 100 });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.requestsCount, 3);
  assert.equal(body.hasMore, false);
  assert.deepEqual(
    body.requests.map((r) => r.rangeHeader),
    ['bytes=0-3', 'bytes=4-7', 'bytes=8-9'],
  );
});

test('chunkBytes larger than a gap returns the whole gap as one request', async () => {
  const res = await resumePlan({
    size: 500,
    completed: [{ start: 0, end: 199 }],
    chunkBytes: 1000,
    limit: 5,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.requests.map((r) => [r.start, r.end]), [[200, 499]]);
  assert.equal(body.requests[0].bytes, 300);
});

test('empty resource yields an empty request list', async () => {
  const res = await resumePlan({ size: 0, completed: [], chunkBytes: 100, limit: 10 });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.completedBytes, 0);
  assert.equal(body.remainingBytes, 0);
  assert.equal(body.hasMore, false);
  assert.equal(body.requestsCount, 0);
  assert.deepEqual(body.requests, []);
});

test('fully downloaded resource yields an empty request list', async () => {
  const res = await resumePlan({
    size: 100,
    completed: [{ start: 0, end: 99 }],
    chunkBytes: 10,
    limit: 10,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.completedBytes, 100);
  assert.equal(body.remainingBytes, 0);
  assert.equal(body.hasMore, false);
  assert.deepEqual(body.requests, []);
});

test('adjacent completed intervals covering the resource merge into full coverage', async () => {
  const res = await resumePlan({
    size: 30,
    completed: [
      { start: 20, end: 29 },
      { start: 0, end: 9 },
      { start: 10, end: 19 },
    ],
    chunkBytes: 10,
    limit: 10,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.completedBytes, 30);
  assert.equal(body.remainingBytes, 0);
  assert.deepEqual(body.requests, []);
});

test('single missing byte is planned exactly', async () => {
  const res = await resumePlan({
    size: 100,
    completed: [
      { start: 0, end: 49 },
      { start: 51, end: 99 },
    ],
    chunkBytes: 1000,
    limit: 10,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.remainingBytes, 1);
  assert.deepEqual(body.requests.map((r) => [r.start, r.end, r.rangeHeader]), [[50, 50, 'bytes=50-50']]);
});

test('large offsets stay within safe-integer precision', async () => {
  const size = Number.MAX_SAFE_INTEGER;
  const res = await resumePlan({
    size,
    completed: [{ start: 0, end: size - 2 }],
    chunkBytes: 1000,
    limit: 10,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.remainingBytes, 1);
  assert.deepEqual(body.requests.map((r) => [r.start, r.end]), [[size - 1, size - 1]]);
});

test('non-integer or negative size is rejected', async () => {
  for (const size of [-1, 1.5, '1000', Number.MAX_SAFE_INTEGER + 1]) {
    const res = await resumePlan({ size, completed: [], chunkBytes: 100, limit: 10 });
    assert.equal(res.statusCode, 400, `expected 400 for size=${size}`);
  }
});

test('chunkBytes must be a positive safe integer', async () => {
  for (const chunkBytes of [0, -5, 1.5, '100']) {
    const res = await resumePlan({ size: 100, completed: [], chunkBytes, limit: 10 });
    assert.equal(res.statusCode, 400, `expected 400 for chunkBytes=${chunkBytes}`);
  }
  const res = await resumePlan({ size: 100, completed: [], chunkBytes: 0.5, limit: 10 });
  assert.equal(res.statusCode, 400);
});

test('limit must be a positive safe integer within the server cap', async () => {
  for (const limit of [0, -1, 2.5, '10', 10001]) {
    const res = await resumePlan({ size: 100, completed: [], chunkBytes: 10, limit });
    assert.equal(res.statusCode, 400, `expected 400 for limit=${limit}`);
  }
});

test('completed must be an array of interval objects', async () => {
  for (const completed of [null, {}, '0-9', [null], [1], [['0', '9']], [{ start: 0 }], [{ start: 0, end: 9, extra: 1 }]]) {
    const res = await resumePlan({ size: 100, completed, chunkBytes: 10, limit: 10 });
    assert.equal(res.statusCode, 400, `expected 400 for completed=${JSON.stringify(completed)}`);
  }
});

test('interval boundaries must be non-negative safe integers', async () => {
  for (const interval of [
    { start: -1, end: 9 },
    { start: 0, end: -1 },
    { start: 0.5, end: 9 },
    { start: 0, end: 9.5 },
    { start: '0', end: 9 },
  ]) {
    const res = await resumePlan({ size: 100, completed: [interval], chunkBytes: 10, limit: 10 });
    assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(interval)}`);
  }
});

test('interval with start after end is rejected', async () => {
  const res = await resumePlan({
    size: 100,
    completed: [{ start: 50, end: 10 }],
    chunkBytes: 10,
    limit: 10,
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'INVALID_COMPLETED_RANGE');
});

test('interval reaching past the resource end is rejected', async () => {
  const res = await resumePlan({
    size: 100,
    completed: [{ start: 90, end: 100 }],
    chunkBytes: 10,
    limit: 10,
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'COMPLETED_RANGE_OUT_OF_BOUNDS');
});

test('any completed interval is out of bounds on an empty resource', async () => {
  const res = await resumePlan({
    size: 0,
    completed: [{ start: 0, end: 0 }],
    chunkBytes: 10,
    limit: 10,
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'COMPLETED_RANGE_OUT_OF_BOUNDS');
});

test('missing required fields are rejected by schema validation', async () => {
  for (const payload of [
    {},
    { size: 100 },
    { size: 100, completed: [] },
    { size: 100, completed: [], chunkBytes: 10 },
  ]) {
    const res = await resumePlan(payload);
    assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(payload)}`);
  }
});

test('error responses carry the shared error shape', async () => {
  const res = await resumePlan({
    size: 100,
    completed: [{ start: 5, end: 1 }],
    chunkBytes: 10,
    limit: 10,
  });
  assert.equal(res.statusCode, 400);
  const body = res.json();
  assert.equal(body.statusCode, 400);
  assert.equal(body.error, 'Bad Request');
  assert.equal(typeof body.code, 'string');
  assert.equal(typeof body.message, 'string');
});

test('existing /plan endpoint is unaffected', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/plan',
    headers: { Range: 'bytes=0-99', 'content-type': 'application/json' },
    payload: JSON.stringify({ size: 10000 }),
  });
  assert.equal(res.statusCode, 206);
  assert.equal(res.json().segmentsCount, 1);
});
