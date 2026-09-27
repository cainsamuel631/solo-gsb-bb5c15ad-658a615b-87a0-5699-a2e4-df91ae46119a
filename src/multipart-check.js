// multipart/byteranges response verification.
//
// Given the declared resource size, the set of expected byte intervals, the
// part Content-Type (carrying the boundary parameter) and the raw wire message
// (base64-encoded), parse the message strictly and report which byte intervals
// were actually received, which expected bytes are missing and which bytes
// arrived outside the expectation set.
//
// The wire format accepted here (RFC 9110 §14.6, CRLF throughout) is the exact
// shape produced by planner.js:
//
//   --boundary CRLF
//   part1-header-block CRLF CRLF
//   part1-data
//   CRLF --boundary CRLF
//   part2-header-block CRLF CRLF
//   part2-data
//   CRLF --boundary-- [CRLF]
//
// No preamble and no epilogue are permitted. Part data is consumed by the
// declared Content-Range length (end - start + 1), so a boundary byte sequence
// that happens to occur inside the data can never truncate a part.

export const MAX_CHECK_SEGMENTS = 16;
export const MAX_DECODED_BODY_BYTES = 1024 * 1024; // 1 MiB
export const MAX_BOUNDARY_LENGTH = 70;
export const MAX_PART_HEADER_BLOCK_BYTES = 8192;

// The JSON base64 string is bounded as well, so an oversized payload is
// rejected before the decoder allocates anything. ~4/3 of the decoded cap.
export const MAX_BASE64_CHARS = 1400000;

const CRLF = Buffer.of(0x0d, 0x0a);

// RFC 9110 token: visible US-ASCII minus separators.
const TOKEN_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
// RFC 9110 quoted-string value (between the quotes): VCHAR / SP / HTAB / obs-text
// minus quote and backslash; quoted-pair is intentionally not supported.
const QUOTED_VALUE_RE = /^[\t\x20\x21\x23-\x7e\x80-\xff]*$/;
const BOUNDARY_RE = new RegExp(`^[A-Za-z0-9-]{1,${MAX_BOUNDARY_LENGTH}}$`);
// Standard base64 alphabet with correct padding; no whitespace allowed.
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
// Header name token (RFC 9110 field-name).
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
// Header value: field-content minus CR/LF (HTAB, VCHAR, obs-text; leading/trailing OWS trimmed).
const HEADER_VALUE_RE = /^[\t\x21-\x7e\x80-\xff][\t\x20-\x7e\x80-\xff]*$/;
// Content-Range: bytes <start>-<end>/<complete-length>
const CONTENT_RANGE_RE = /^bytes\s+(\d+)\s*-\s*(\d+)\s*\/\s*(\d+)$/i;

/**
 * Verify a multipart/byteranges message.
 *
 * @returns a result object whose `statusCode` is 200 with the merged
 *          received/missing/extra interval sets, or 400 describing the first
 *          structural or input violation.
 */
export function checkMultipart(options) {
  const { size, expected, contentType, bodyBase64 } = options;

  if (!Number.isSafeInteger(size) || size < 0) {
    return fail('INVALID_SIZE', 'size must be a non-negative safe integer');
  }
  if (!Array.isArray(expected)) {
    return fail('INVALID_EXPECTED', 'expected must be an array of {start, end} intervals');
  }
  if (expected.length > MAX_CHECK_SEGMENTS) {
    return fail(
      'TOO_MANY_EXPECTED_RANGES',
      `expected carries ${expected.length} intervals; at most ${MAX_CHECK_SEGMENTS} are allowed`,
    );
  }
  for (let i = 0; i < expected.length; i += 1) {
    const interval = expected[i];
    if (interval === null || typeof interval !== 'object' || Array.isArray(interval)) {
      return fail('INVALID_EXPECTED_RANGE', `expected[${i}] must be an object with start and end`);
    }
    const { start, end } = interval;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
      return fail(
        'INVALID_EXPECTED_RANGE',
        `expected[${i}] endpoints must be non-negative safe integers satisfying 0 <= start <= end < size`,
      );
    }
    if (start < 0 || start > end || end >= size) {
      return fail(
        'EXPECTED_RANGE_OUT_OF_BOUNDS',
        `expected[${i}] must satisfy 0 <= start <= end < size (size is ${size})`,
      );
    }
  }

  const boundaryResult = extractBoundary(contentType);
  if (boundaryResult.error) return boundaryResult.error;
  const boundary = boundaryResult.value;

  const bodyResult = decodeBody(bodyBase64);
  if (bodyResult.error) return bodyResult.error;
  const body = bodyResult.value;

  const parseResult = parseBody({ body, boundary, size });
  if (parseResult.error) return parseResult.error;
  const ranges = parseResult.value;

  if (ranges.length > MAX_CHECK_SEGMENTS) {
    return fail(
      'TOO_MANY_SEGMENTS',
      `message has ${ranges.length} parts; at most ${MAX_CHECK_SEGMENTS} are allowed`,
    );
  }

  // Every part must carry a unique Content-Range.
  const seen = new Set();
  for (const range of ranges) {
    const key = `${range.start}-${range.end}`;
    if (seen.has(key)) {
      return fail(
        'DUPLICATE_CONTENT_RANGE',
        `Content-Range bytes ${range.start}-${range.end} is used by more than one part`,
      );
    }
    seen.add(key);
  }

  // The declared part lengths must account for exactly `size` bytes.
  const totalData = ranges.reduce((sum, range) => sum + (range.end - range.start + 1), 0);
  if (totalData !== size) {
    return fail(
      'TOTAL_SIZE_MISMATCH',
      `part payloads total ${totalData} bytes but size declares ${size}`,
    );
  }

  const received = mergeIntervals(ranges.map(({ start, end }) => ({ start, end })));
  const expectedMerged = mergeIntervals(expected.map(({ start, end }) => ({ start, end })));
  const missing = subtractIntervals(expectedMerged, received);
  const extra = subtractIntervals(received, expectedMerged);

  return {
    statusCode: 200,
    complete: missing.length === 0 && extra.length === 0,
    partsCount: ranges.length,
    receivedBytes: intervalBytes(received),
    missingBytes: intervalBytes(missing),
    extraBytes: intervalBytes(extra),
    received,
    missing,
    extra,
  };
}

/**
 * Parse the multipart Content-Type and return the boundary parameter.
 * The media type must be multipart/byteranges (case-insensitive); exactly one
 * boundary parameter is required, its value 1..70 alphanumerics/hyphens,
 * optionally quoted.
 */
function extractBoundary(contentType) {
  if (typeof contentType !== 'string' || contentType.length === 0 || /[\r\n]/.test(contentType)) {
    return { error: fail('INVALID_CONTENT_TYPE', 'contentType must be a non-empty header-safe string') };
  }

  const semi = contentType.indexOf(';');
  const mediaType = (semi === -1 ? contentType : contentType.slice(0, semi)).trim().toLowerCase();
  if (mediaType !== 'multipart/byteranges') {
    return {
      error: fail(
        'UNSUPPORTED_CONTENT_TYPE',
        "contentType media type must be 'multipart/byteranges'",
      ),
    };
  }

  let boundary;
  const params = semi === -1 ? '' : contentType.slice(semi + 1);
  for (const rawParam of params.split(';')) {
    const param = rawParam.trim();
    if (param === '') {
      return { error: fail('INVALID_CONTENT_TYPE', 'contentType contains an empty parameter') };
    }
    const eq = param.indexOf('=');
    if (eq === -1 || !TOKEN_RE.test(param.slice(0, eq).trim())) {
      return { error: fail('INVALID_CONTENT_TYPE', 'contentType has a malformed parameter') };
    }
    const name = param.slice(0, eq).trim().toLowerCase();
    const rawValue = param.slice(eq + 1).trim();

    let value;
    if (rawValue.startsWith('"')) {
      if (!rawValue.endsWith('"') || rawValue.length < 2 || !QUOTED_VALUE_RE.test(rawValue.slice(1, -1))) {
        return { error: fail('INVALID_CONTENT_TYPE', 'contentType has a malformed quoted parameter') };
      }
      value = rawValue.slice(1, -1);
    } else {
      if (!TOKEN_RE.test(rawValue)) {
        return { error: fail('INVALID_CONTENT_TYPE', 'contentType has a malformed parameter value') };
      }
      value = rawValue;
    }

    if (name === 'boundary') {
      if (boundary !== undefined) {
        return { error: fail('INVALID_CONTENT_TYPE', 'contentType carries more than one boundary parameter') };
      }
      boundary = value;
    }
  }

  if (boundary === undefined) {
    return { error: fail('MISSING_BOUNDARY', 'contentType must include a boundary parameter') };
  }
  if (!BOUNDARY_RE.test(boundary)) {
    return {
      error: fail(
        'INVALID_BOUNDARY',
        'boundary must be 1 to 70 ASCII alphanumeric characters or hyphens',
      ),
    };
  }
  return { value: boundary };
}

/**
 * Strictly decode the base64 payload and enforce the 1 MiB decoded cap.
 */
function decodeBody(bodyBase64) {
  if (typeof bodyBase64 !== 'string' || bodyBase64.length === 0) {
    return { error: fail('INVALID_BODY_BASE64', 'bodyBase64 must be a non-empty standard base64 string') };
  }
  // Cheap guard before any decoding work; an empty resource uses the degenerate
  // body "--b--\r\n", which is always tiny.
  if (bodyBase64.length > MAX_BASE64_CHARS) {
    return {
      error: fail(
        'BODY_TOO_LARGE',
        `decoded message must not exceed ${MAX_DECODED_BODY_BYTES} bytes (1 MiB)`,
      ),
    };
  }
  if (!BASE64_RE.test(bodyBase64)) {
    return { error: fail('INVALID_BODY_BASE64', 'bodyBase64 is not valid standard base64') };
  }

  const body = Buffer.from(bodyBase64, 'base64');
  if (body.length > MAX_DECODED_BODY_BYTES) {
    return {
      error: fail(
        'BODY_TOO_LARGE',
        `decoded message must not exceed ${MAX_DECODED_BODY_BYTES} bytes (1 MiB)`,
      ),
    };
  }
  return { value: body };
}

/**
 * Parse the wire message into a list of declared byte ranges. Each range has
 * already been validated against the resource size and matched against the
 * exact number of payload bytes.
 */
function parseBody({ body, boundary, size }) {
  const dashBoundary = Buffer.from(`--${boundary}`, 'ascii');

  let pos = 0;

  // No preamble: the message must open with the first dash-boundary. Every
  // subsequent boundary line is introduced by a CRLF (RFC 2046 delimiter).
  if (!body.subarray(0, dashBoundary.length).equals(dashBoundary)) {
    return { error: fail('MALFORMED_MESSAGE', 'message must start with the boundary delimiter (no preamble)') };
  }
  pos = dashBoundary.length;

  const ranges = [];

  for (;;) {
    // The close delimiter may appear directly (degenerate zero-part message)
    // or after any number of parts.
    if (isCloseDelimiter(body, pos)) {
      pos += 2;
      break;
    }

    // A transport-padding CRLF terminates the delimiter line.
    if (!body.subarray(pos, pos + 2).equals(CRLF)) {
      return { error: fail('MALFORMED_MESSAGE', 'boundary delimiter must be terminated by CRLF') };
    }
    pos += 2;

    const headerResult = parsePartHeaders(body, pos, size);
    if (headerResult.error) return headerResult;
    pos = headerResult.value.nextPos;
    const range = headerResult.value.range;

    const dataLength = range.end - range.start + 1;
    if (pos + dataLength > body.length) {
      return { error: fail('TRUNCATED_PART', `part bytes ${range.start}-${range.end} is shorter than its Content-Range declares`) };
    }
    // Consume precisely the declared byte count; boundary-like sequences inside
    // the data are therefore never treated as delimiters.
    pos += dataLength;
    ranges.push(range);

    // The body-part is followed by a delimiter: CRLF dash-boundary, and then
    // either "--" (close) or CRLF (another part).
    if (!body.subarray(pos, pos + 2).equals(CRLF)) {
      return { error: fail('MALFORMED_MESSAGE', 'part data must be followed by a CRLF boundary line') };
    }
    pos += 2;
    if (!body.subarray(pos, pos + dashBoundary.length).equals(dashBoundary)) {
      return { error: fail('MALFORMED_MESSAGE', 'expected boundary delimiter after part data') };
    }
    pos += dashBoundary.length;
  }

  // No epilogue: either nothing or a single terminating CRLF may remain.
  if (body.length - pos === 2 && body.subarray(pos).equals(CRLF)) {
    pos = body.length;
  }
  if (pos !== body.length) {
    return { error: fail('MALFORMED_MESSAGE', 'message contains trailing data after the closing boundary (no epilogue)') };
  }

  return { value: ranges };
}

function isCloseDelimiter(body, pos) {
  return body[pos] === 0x2d && body[pos + 1] === 0x2d;
}

/**
 * Parse one part header block starting at `start`. A header block is one or
 * more CRLF-terminated header lines followed by a blank line (CRLF CRLF).
 * Exactly one Content-Range header is required; Content-Type and any other
 * well-formed headers are tolerated and ignored.
 */
function parsePartHeaders(body, start, size) {
  // Bound the search so a missing terminator cannot scan a whole 1 MiB body.
  const maxStart = Math.min(start + MAX_PART_HEADER_BLOCK_BYTES, body.length - 4);
  let terminator = -1;
  for (let i = start; i <= maxStart; i += 1) {
    if (body[i] === 0x0d && body[i + 1] === 0x0a && body[i + 2] === 0x0d && body[i + 3] === 0x0a) {
      terminator = i;
      break;
    }
  }
  if (terminator === -1) {
    return {
      error: fail(
        'MALFORMED_PART_HEADERS',
        `part header block is missing its blank-line terminator or exceeds ${MAX_PART_HEADER_BLOCK_BYTES} bytes`,
      ),
    };
  }

  const block = body.subarray(start, terminator);
  for (const byte of block) {
    if (byte > 126) {
      return { error: fail('MALFORMED_PART_HEADERS', 'part headers must be 7-bit ASCII (use RFC 2047 encoding for non-ASCII values)') };
    }
  }

  const lines = block.toString('ascii').split('\r\n');
  let contentRangeValue;

  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon <= 0 || !HEADER_NAME_RE.test(line.slice(0, colon))) {
      return { error: fail('MALFORMED_PART_HEADERS', 'part contains a malformed header line') };
    }
    const name = line.slice(0, colon).trim().toLowerCase();
    const rawValue = line.slice(colon + 1);
    const value = rawValue.trim();
    if (value.length === 0 || !HEADER_VALUE_RE.test(rawValue.trim())) {
      return { error: fail('MALFORMED_PART_HEADERS', `part header '${name}' has an empty or malformed value`) };
    }

    if (name === 'content-range') {
      if (contentRangeValue !== undefined) {
        return { error: fail('DUPLICATE_CONTENT_RANGE', 'a part carries more than one Content-Range header') };
      }
      contentRangeValue = value;
    }
  }

  if (contentRangeValue === undefined) {
    return { error: fail('MISSING_CONTENT_RANGE', 'every part must carry a Content-Range header') };
  }

  const range = parseContentRange(contentRangeValue);
  if (range === null) {
    return {
      error: fail(
        'INVALID_CONTENT_RANGE',
        `Content-Range '${contentRangeValue}' must look like 'bytes 0-99/${'<size>'}' with complete-length equal to size`,
      ),
    };
  }
  if (range.completeLength !== size) {
    return {
      error: fail(
        'CONTENT_RANGE_SIZE_MISMATCH',
        `Content-Range complete-length ${range.completeLength} does not equal size ${size}`,
      ),
    };
  }
  if (range.start > range.end || range.end >= size) {
    return {
      error: fail(
        'CONTENT_RANGE_OUT_OF_BOUNDS',
        `Content-Range bytes ${range.start}-${range.end} does not satisfy 0 <= start <= end < size (size is ${size})`,
      ),
    };
  }

  return { value: { range, nextPos: terminator + 4 } };
}

function parseContentRange(value) {
  const match = CONTENT_RANGE_RE.exec(value);
  if (!match) return null;

  const start = Number(match[1]);
  const end = Number(match[2]);
  const completeLength = Number(match[3]);
  // Compare through BigInt: digit strings can exceed safe-integer range.
  if (
    BigInt(match[1]) > BigInt(Number.MAX_SAFE_INTEGER) ||
    BigInt(match[2]) > BigInt(Number.MAX_SAFE_INTEGER) ||
    BigInt(match[3]) > BigInt(Number.MAX_SAFE_INTEGER) ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(completeLength)
  ) {
    return null;
  }
  if (start > end) return null;
  return { start, end, completeLength };
}

/**
 * Sort intervals by start offset and merge overlapping or adjacent ones.
 */
function mergeIntervals(intervals) {
  const sorted = intervals
    .map((interval) => ({ start: interval.start, end: interval.end }))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const merged = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end + 1) {
      if (interval.end > last.end) last.end = interval.end;
    } else {
      merged.push({ start: interval.start, end: interval.end });
    }
  }
  return merged;
}

/**
 * Remove every byte covered by `b` from the merged, ascending interval set
 * `a`; returns a merged, ascending interval set.
 */
function subtractIntervals(a, b) {
  const result = [];
  for (const interval of a) {
    let cursor = interval.start;
    let k = 0;
    while (cursor <= interval.end) {
      while (k < b.length && b[k].end < cursor) k += 1;
      if (k >= b.length || b[k].start > interval.end) {
        result.push({ start: cursor, end: interval.end });
        break;
      }
      if (b[k].start > cursor) {
        result.push({ start: cursor, end: Math.min(b[k].start - 1, interval.end) });
      }
      cursor = Math.max(cursor, b[k].end + 1);
      k += 1;
    }
  }
  return result;
}

function intervalBytes(intervals) {
  return intervals.reduce((sum, interval) => sum + (interval.end - interval.start + 1), 0);
}

function fail(code, message) {
  return {
    statusCode: 400,
    code,
    error: 'Bad Request',
    message,
  };
}
