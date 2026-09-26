import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';

const app = buildApp();
const url = '/plan';

function plan({
  size = 1000,
  range = 'bytes=0-99',
  contentType,
  etag,
  lastModified,
  ifRange,
  headers: extraHeaders,
  query,
  method = 'POST',
}) {
  const headers = { 'content-type': 'application/json' };
  if (range !== undefined) headers.Range = range;
  if (ifRange !== undefined) headers['If-Range'] = ifRange;
  Object.assign(headers, extraHeaders ?? {});

  const body = {
    size,
    ...(contentType ? { contentType } : {}),
    ...(etag !== undefined ? { etag } : {}),
    ...(lastModified !== undefined ? { lastModified } : {}),
  };

  return app.inject({
    method,
    url: query ?? url,
    headers,
    payload: method === 'POST' ? JSON.stringify(body) : undefined,
  });
}

const ETAG = '"v1-a1b2c3"';
const LM = 'Wed, 21 Oct 2015 07:28:00 GMT';

// ---------- If-Range with an entity-tag validator ----------

test('If-Range equal to the current strong ETag preserves 206 partial planning', async () => {
  const res = await plan({ size: 1000, etag: ETAG, ifRange: ETAG });
  assert.equal(res.statusCode, 206);
  const body = res.json();
  assert.equal(body.decision, 'partial');
  assert.equal(body.condition.outcome, 'passed');
  assert.equal(body.condition.reason, 'etag-match');
  assert.equal(body.condition.validatorKind, 'etag');
  assert.equal(body.responseHeaders['Content-Length'], '100');
  assert.equal(body.responseHeaders.ETag, ETAG);
  assert.equal(body.resource.etag, ETAG);
});

test('If-Range ETag is compared verbatim (no trimming, no case folding)', async () => {
  const res = await plan({ size: 1000, etag: ETAG, ifRange: ` ${ETAG}` });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().decision, 'full');
  assert.equal(res.json().condition.reason, 'invalid-validator');
});

test('If-Range ETag mismatch returns 200 full plan and ignores Range', async () => {
  const res = await plan({ size: 1000, etag: ETAG, ifRange: '"something-else"' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.decision, 'full');
  assert.equal(body.condition.reason, 'etag-mismatch');
  assert.equal(body.condition.outcome, 'failed');
  assert.equal(body.segmentsCount, null);
  assert.equal(body.segments, null);
  assert.equal(body.responseHeaders['Content-Length'], '1000');
  assert.equal(body.responseHeaders['Content-Type'], 'application/octet-stream');
  assert.equal(body.responseHeaders['Accept-Ranges'], 'bytes');
  assert.equal(body.responseHeaders['Content-Range'], undefined);
  assert.equal(body.bytes.total, 1000);
  assert.equal(body.bytes.selected, 1000);
  assert.equal(body.bytes.ratio, 1);
});

test('failed If-Range downgrades even when Range itself is malformed', async () => {
  const res = await plan({ size: 1000, etag: ETAG, ifRange: '"other"', range: 'bytes=nonsense' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().decision, 'full');
});

test('If-Range ETag without current etag metadata returns 200 full', async () => {
  const res = await plan({ size: 1000, ifRange: ETAG });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.decision, 'full');
  assert.equal(body.condition.reason, 'resource-metadata-missing');
});

test('weak If-Range ETag can never authorise a partial response', async () => {
  const res = await plan({ size: 1000, etag: ETAG, ifRange: `W/${ETAG}` });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().condition.reason, 'weak-validator');
});

test('strong If-Range ETag against a weak current ETag mismatches', async () => {
  const res = await plan({ size: 1000, etag: `W/${ETAG}`, ifRange: ETAG });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().condition.reason, 'etag-mismatch');
});

test('malformed If-Range entity-tag is treated as failed precondition, not 400', async () => {
  for (const bad of ['"unterminated', '"x"extra', '"bad char""]) ', '"', 'W/unquoted']) {
    const res = await plan({ size: 1000, etag: ETAG, ifRange: bad });
    assert.equal(res.statusCode, 200, `expected 200 for ${JSON.stringify(bad)}`);
    assert.equal(res.json().decision, 'full');
    assert.ok(
      ['invalid-validator', 'weak-validator'].includes(res.json().condition.reason),
      `unexpected reason for ${JSON.stringify(bad)}`,
    );
  }
});

// ---------- If-Range with an HTTP-date validator ----------

test('If-Range date equal to Last-Modified passes (not earlier)', async () => {
  const res = await plan({ size: 1000, lastModified: LM, ifRange: LM });
  assert.equal(res.statusCode, 206);
  assert.equal(res.json().decision, 'partial');
  assert.equal(res.json().condition.reason, 'date-not-earlier');
  assert.equal(res.json().condition.validatorKind, 'date');
  assert.equal(res.json().responseHeaders['Last-Modified'], LM);
});

test('If-Range date newer than Last-Modified passes', async () => {
  const res = await plan({
    size: 1000,
    lastModified: LM,
    ifRange: 'Thu, 22 Oct 2015 07:28:00 GMT',
  });
  assert.equal(res.statusCode, 206);
  assert.equal(res.json().condition.reason, 'date-not-earlier');
});

test('If-Range date earlier than Last-Modified returns 200 full', async () => {
  const res = await plan({
    size: 1000,
    lastModified: LM,
    ifRange: 'Tue, 20 Oct 2015 07:28:00 GMT',
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().decision, 'full');
  assert.equal(res.json().condition.reason, 'date-earlier');
  assert.equal(res.json().responseHeaders['Content-Length'], '1000');
});

test('If-Range date without lastModified metadata returns 200 full', async () => {
  const res = await plan({ size: 1000, ifRange: LM });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().condition.reason, 'resource-metadata-missing');
});

test('invalid If-Range date formats return 200 full', async () => {
  for (const bad of [
    '21 Oct 2015 07:28:00 GMT',            // no weekday
    'Wed, 21 Oct 2015 07:28:00',          // no GMT
    'Wed, 21 October 2015 07:28:00 GMT',  // full month name
    'wed, 21 Oct 2015 07:28:00 GMT',      // lowercase weekday
    'Wed, 21 Oct 15 07:28:00 GMT',        // 2-digit year
    'Mon, 21 Oct 2015 07:28:00 GMT',      // wrong weekday for the date
    'Tue, 31 Feb 2015 07:28:00 GMT',      // impossible date
    'Wed, 21 Oct 2015 25:28:00 GMT',      // bad hour
  ]) {
    const res = await plan({ size: 1000, lastModified: LM, ifRange: bad });
    assert.equal(res.statusCode, 200, `expected 200 for ${JSON.stringify(bad)}`);
    assert.equal(res.json().condition.reason, 'invalid-validator');
  }
});

test('If-Range date compared against invalid current metadata', async () => {
  // current metadata format is validated at the edge, so exercise the planner
  // directly for its defensive path.
  const { planRanges } = await import('../src/planner.js');
  const result = planRanges({
    size: 1000,
    rangeHeader: 'bytes=0-9',
    ifRange: LM,
    lastModified: 'not-a-date',
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.decision, 'full');
  assert.equal(result.condition.reason, 'resource-metadata-missing');
});

// ---------- obs-date formats: RFC 850 and asctime (RFC 9110 §5.6.7) ----------

const LM_RFC850 = 'Wednesday, 21-Oct-15 07:28:00 GMT';
const LM_ASCTIME = 'Wed Oct 21 07:28:00 2015';

test('If-Range accepts an RFC 850 date for the same instant and keeps 206', async () => {
  const res = await plan({ size: 1000, lastModified: LM, ifRange: LM_RFC850 });
  assert.equal(res.statusCode, 206);
  assert.equal(res.json().decision, 'partial');
  assert.equal(res.json().condition.reason, 'date-not-earlier');
  assert.equal(res.json().condition.validatorKind, 'date');
});

test('If-Range accepts an asctime date for the same instant and keeps 206', async () => {
  const res = await plan({ size: 1000, lastModified: LM, ifRange: LM_ASCTIME });
  assert.equal(res.statusCode, 206);
  assert.equal(res.json().condition.reason, 'date-not-earlier');
});

test('asctime single-digit day is SP-padded and still accepted', async () => {
  const res = await plan({
    size: 1000,
    lastModified: 'Sun, 06 Nov 1994 08:49:37 GMT',
    ifRange: 'Sun Nov  6 08:49:37 1994',
  });
  assert.equal(res.statusCode, 206);
  assert.equal(res.json().condition.reason, 'date-not-earlier');
});

test('lastModified metadata accepts RFC 850 and asctime instead of 400', async () => {
  for (const lastModified of [LM_RFC850, LM_ASCTIME]) {
    const res = await plan({ size: 1000, lastModified, ifRange: LM });
    assert.equal(res.statusCode, 206, `expected 206 for ${JSON.stringify(lastModified)}`);
    assert.equal(res.json().condition.reason, 'date-not-earlier');
    assert.equal(res.json().responseHeaders['Last-Modified'], lastModified);
  }
});

test('comparison always uses the parsed instant, even across mixed formats', async () => {
  // lastModified supplied as RFC 850, If-Range as asctime one second later.
  let res = await plan({
    size: 1000,
    lastModified: LM_RFC850,
    ifRange: 'Wed Oct 21 07:28:01 2015',
  });
  assert.equal(res.statusCode, 206);
  assert.equal(res.json().condition.reason, 'date-not-earlier');

  // Same instant both sides passes regardless of format.
  res = await plan({ size: 1000, lastModified: LM_ASCTIME, ifRange: LM_RFC850 });
  assert.equal(res.statusCode, 206);
  assert.equal(res.json().condition.reason, 'date-not-earlier');

  // An obs-date one second earlier is stale -> full plan.
  res = await plan({
    size: 1000,
    lastModified: LM_RFC850,
    ifRange: 'Wed Oct 21 07:27:59 2015',
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().decision, 'full');
  assert.equal(res.json().condition.reason, 'date-earlier');
});

test('RFC 850 two-digit years are resolved against the reception UTC year', async () => {
  const { parseHttpDate } = await import('../src/conditional.js');
  const now = new Date(Date.UTC(2026, 8, 26, 12, 0, 0)); // received 26 Sep 2026

  // "94" would land in 2094, 68 years in the future -> rolled back to 1994.
  assert.equal(
    parseHttpDate('Sunday, 06-Nov-94 08:49:37 GMT', now),
    Date.UTC(1994, 10, 6, 8, 49, 37),
  );
  // "26" is the current year.
  assert.equal(
    parseHttpDate('Thursday, 15-Jan-26 00:00:00 GMT', now),
    Date.UTC(2026, 0, 15, 0, 0, 0),
  );
  // Exactly 50 years ahead stays in the future.
  assert.equal(
    parseHttpDate('Saturday, 26-Sep-76 12:00:00 GMT', now),
    Date.UTC(2076, 8, 26, 12, 0, 0),
  );
  // 51 years ahead rolls back one century.
  assert.equal(
    parseHttpDate('Monday, 26-Sep-77 12:00:00 GMT', now),
    Date.UTC(1977, 8, 26, 12, 0, 0),
  );
});

test('obs-date weekday, calendar and time fields are still validated', async () => {
  for (const bad of [
    'Monday, 21-Oct-15 07:28:00 GMT',     // wrong weekday for 21 Oct 2015
    'Wednesday, 32-Oct-15 07:28:00 GMT', // impossible day-of-month
    'Wednesday, 21-Oct-15 24:00:00 GMT', // bad hour
    'Sunday, 31-Feb-94 08:49:37 GMT',    // impossible calendar date
    'Wed Nov 31 07:28:00 2015',          // November has 30 days
    'Sun Nov  6 08:60:37 1994',          // bad minute
  ]) {
    const res = await plan({ size: 1000, lastModified: LM, ifRange: bad });
    assert.equal(res.statusCode, 200, `expected 200 for ${JSON.stringify(bad)}`);
    assert.equal(res.json().condition.reason, 'invalid-validator');
  }
});

test('syntactically wrong obs-date shapes are invalid validators', async () => {
  for (const bad of [
    'Wednesday, 21-Oct-2015 07:28:00 GMT', // RFC 850 requires a 2-digit year
    'Wed, 21-Oct-15 07:28:00 GMT',         // RFC 850 requires the full weekday
    'Wednesday, 21 Oct 15 07:28:00 GMT',   // RFC 850 separates date fields with '-'
    'sunday, 21-Oct-15 07:28:00 GMT',      // lowercase weekday
    'Wed Oct 21 07:28:00 15',              // asctime requires a 4-digit year
    'Wed Oct 21 07:28:00 2015 GMT',        // asctime has no GMT suffix
    'Sun Nov 6 08:49:37 1994',             // single-digit day must be SP-padded
    'Sun, 06 Nov 94 08:49:37 GMT',         // IMF-fixdate requires a 4-digit year
  ]) {
    const res = await plan({ size: 1000, lastModified: LM, ifRange: bad });
    assert.equal(res.statusCode, 200, `expected 200 for ${JSON.stringify(bad)}`);
    assert.equal(res.json().condition.reason, 'invalid-validator');
  }
});

// ---------- Preserved 206/416/422 semantics when precondition passes ----------

test('passing If-Range still yields 416 for an unsatisfiable range', async () => {
  const res = await plan({ size: 100, range: 'bytes=500-600', etag: ETAG, ifRange: ETAG });
  assert.equal(res.statusCode, 416);
  const body = res.json();
  assert.equal(body.decision, 'partial');
  assert.equal(body.code, 'RANGE_NOT_SATISFIABLE');
  assert.equal(body.responseHeaders['Content-Range'], 'bytes */100');
  assert.equal(body.responseHeaders.ETag, ETAG);
});

test('passing If-Range still yields 422 for too many segments', async () => {
  const specs = Array.from({ length: 17 }, (_, i) => `${i * 10}-${i * 10 + 1}`).join(',');
  const res = await plan({ size: 1000, range: `bytes=${specs}`, etag: ETAG, ifRange: ETAG });
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().decision, 'partial');
  assert.equal(res.json().code, 'TOO_MANY_SEGMENTS');
});

test('without If-Range there is no decision condition block at all', async () => {
  const res = await plan({ size: 1000, etag: ETAG, lastModified: LM });
  assert.equal(res.statusCode, 206);
  const body = res.json();
  assert.equal(body.decision, 'partial');
  assert.equal(body.condition, undefined);
  assert.equal(body.responseHeaders.ETag, ETAG);
  assert.equal(body.responseHeaders['Last-Modified'], LM);
});

// ---------- Edge / request-level validation ----------

test('If-Range containing CR is rejected with 400', async () => {
  const res = await plan({
    size: 1000,
    etag: ETAG,
    ifRange: '"x"\r',
    range: 'bytes=0-9',
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'INVALID_IF_RANGE');
});

test('If-Range containing LF is rejected with 400', async () => {
  const res = await plan({
    size: 1000,
    etag: ETAG,
    ifRange: 'Wed, 21 Oct 2015 07:28:00 GMT\n',
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'INVALID_IF_RANGE');
});

test('malformed resource etag metadata yields 400 INVALID_ETAG', async () => {
  for (const bad of ['no-quotes', 'W/"unbalanced', '"with\r\n"']) {
    const res = await plan({ size: 1000, etag: bad, ifRange: ETAG });
    assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(bad)}`);
    assert.equal(res.json().code, 'INVALID_ETAG');
  }
});

test('malformed lastModified metadata yields 400 INVALID_LAST_MODIFIED', async () => {
  for (const bad of [
    '21 Oct 2015',
    'Wed, 31 Feb 2015 07:28:00 GMT',
    'Wed, 21 Oct 2015 07:28:00 GMT\r\n',
    'Wednesday, 21-Oct-15 07:28:00',      // RFC 850 without GMT
    'Wednesday, 21-Oct-2015 07:28:00 GMT', // RFC 850 with a 4-digit year
    'Wed Oct 21 07:28:00 2015 GMT',        // asctime with a GMT suffix
  ]) {
    const res = await plan({ size: 1000, lastModified: bad });
    assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(bad)}`);
    assert.equal(res.json().code, 'INVALID_LAST_MODIFIED');
  }
});

test('GET endpoint accepts obs-date lastModified and If-Range headers', async () => {
  const res = await plan({
    method: 'GET',
    query: `/plan?size=1000&lastModified=${encodeURIComponent(LM_RFC850)}`,
    range: 'bytes=-100',
    ifRange: LM_ASCTIME,
  });
  assert.equal(res.statusCode, 206);
  assert.equal(res.json().decision, 'partial');
  assert.equal(res.json().segments[0].start, 900);
  assert.equal(res.json().condition.reason, 'date-not-earlier');
});

test('GET endpoint accepts etag and lastModified query params with If-Range', async () => {
  const res = await plan({
    method: 'GET',
    query: `/plan?size=1000&etag=${encodeURIComponent(ETAG)}&lastModified=${encodeURIComponent(LM)}`,
    range: 'bytes=-100',
    ifRange: ETAG,
  });
  assert.equal(res.statusCode, 206);
  assert.equal(res.json().decision, 'partial');
  assert.equal(res.json().segments[0].start, 900);
});

test('GET endpoint downgrades to 200 on stale If-Range date', async () => {
  const res = await plan({
    method: 'GET',
    query: `/plan?size=1000&lastModified=${encodeURIComponent(LM)}`,
    range: 'bytes=-100',
    ifRange: 'Mon, 19 Oct 2015 00:00:00 GMT',
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().decision, 'full');
});

test('GET endpoint rejects invalid etag query parameter', async () => {
  const res = await plan({
    method: 'GET',
    query: '/plan?size=1000&etag=not-an-etag',
    range: 'bytes=0-9',
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'INVALID_ETAG');
});

test('empty resource with failed If-Range returns Content-Length 0 full plan', async () => {
  const res = await plan({ size: 0, range: 'bytes=0-', etag: ETAG, ifRange: '"other"' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.decision, 'full');
  assert.equal(body.responseHeaders['Content-Length'], '0');
  assert.equal(body.bytes.total, 0);
});
