// multipart/byteranges response verifier.
//
// Given the resource size, the byte intervals the client expected, the
// multipart/byteranges media type (carrying the boundary) and the raw response
// body (base64 encoded by the caller), strictly parse the wire message and
// account for the bytes that actually arrived.
//
// The accepted wire layout is the canonical RFC 2046 framing, CRLF throughout,
// with no preamble and no epilogue:
//
//   --boundary CRLF
//   part-headers CRLF
//   CRLF
//   part-data CRLF
//   --boundary CRLF
//   part-headers CRLF
//   CRLF
//   part-data CRLF
//   --boundary-- CRLF
//
// A boundary line inside a part only terminates the part when it is preceded by
// CRLF and followed by either CRLF (next part) or "--" plus CRLF (close), so a
// byte sequence that merely looks like a boundary can never truncate a part.

export const MAX_EXPECTED_INTERVALS = 16;
export const MAX_PARTS = 16;
export const MAX_MESSAGE_BYTES = 1024 * 1024; // 1 MiB decoded
// Headroom for the framing bytes an oversized-but-near-limit message carries;
// the semantic MESSAGE_TOO_LARGE check rejects anything decoding past 1 MiB.
export const MAX_BODY_BASE64_LENGTH = 1_400_000;
export const MAX_CONTENT_TYPE_LENGTH = 255;

const MAX_HEADER_BLOCK_BYTES = 8192;

const CR = 0x0d;
const LF = 0x0a;
const HYPHEN = 0x2d;

const CRLF_BUF = Buffer.from('\r\n');
const DASH_DASH_BUF = Buffer.from('--');
const HEADER_TERMINATOR_BUF = Buffer.from('\r\n\r\n');

// RFC 9110 token, used for media-type parameter and part header names.
const TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// Quoted-string contents: HTAB, space, VCHAR minus '"' and '\', plus obs-text.
const QUOTED_VALUE_RE = /^[\t\x20\x21\x23-\x5b\x5d-\x7e\x80-\xff]*$/;
// Field value contents: HTAB / SP / VCHAR / obs-text.
const FIELD_VALUE_RE = /^[\t\x20-\x7e\x80-\xff]*$/;

// The only boundary spelling accepted here: 1..70 alphanumerics or hyphens.
const BOUNDARY_RE = /^[A-Za-z0-9-]{1,70}$/;

// RFC 9110 byte-range Content-Range: bytes first-last/complete, one SP.
const CONTENT_RANGE_RE = /^bytes (\d{1,16})-(\d{1,16})\/(\d{1,16})$/i;

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Verify a multipart/byteranges message.
 *
 * @returns a result object with `statusCode` 200 and the merged
 *          received/missing/extra intervals, or a 400 result describing the
 *          first validation failure.
 */
export function checkMultipartMessage(options) {
  const { size, expected, contentType, bodyBase64 } = options;

  if (!Number.isSafeInteger(size) || size < 0) {
    return fail('INVALID_SIZE', 'size must be a non-negative safe integer');
  }
  if (!Array.isArray(expected) || expected.length > MAX_EXPECTED_INTERVALS) {
    return fail(
      'INVALID_EXPECTED',
      `expected must be an array of at most ${MAX_EXPECTED_INTERVALS} {start, end} intervals`,
    );
  }
  for (let i = 0; i < expected.length; i += 1) {
    const interval = expected[i];
    if (interval === null || typeof interval !== 'object' || Array.isArray(interval)) {
      return fail('INVALID_EXPECTED_RANGE', `expected[${i}] must be an object with start and end`);
    }
    const { start, end } = interval;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end) {
      return fail(
        'INVALID_EXPECTED_RANGE',
        `expected[${i}] must satisfy 0 <= start <= end`,
      );
    }
    if (end >= size) {
      return fail(
        'EXPECTED_RANGE_OUT_OF_BOUNDS',
        `expected[${i}] end ${end} lies outside the ${size}-byte resource`,
      );
    }
  }

  const boundaryResult = parseBoundary(contentType);
  if (boundaryResult.error) return boundaryResult.error;
  const boundary = boundaryResult.value;

  const body = decodeBase64(bodyBase64);
  if (body === null) {
    return fail(
      'INVALID_BODY_BASE64',
      'bodyBase64 must be a non-empty, canonically padded standard base64 string',
    );
  }
  if (body.length > MAX_MESSAGE_BYTES) {
    return fail(
      'MESSAGE_TOO_LARGE',
      `decoded message is ${body.length} bytes; at most ${MAX_MESSAGE_BYTES} (1 MiB) are allowed`,
    );
  }

  const parsed = parseMultipart(body, boundary, size);
  if (parsed.error) return parsed.error;

  const received = mergeIntervals(parsed.parts);
  const wanted = mergeIntervals(expected);
  const missing = subtractIntervals(wanted, received);
  const extra = subtractIntervals(received, wanted);

  return {
    statusCode: 200,
    received,
    missing,
    extra,
    complete: missing.length === 0 && extra.length === 0,
  };
}

/**
 * Parse the multipart/byteranges media type and extract its boundary.
 * Accepts `multipart/byteranges; boundary=token` and the quoted form
 * `boundary="token"`; the boundary itself must be 1..70 alnum/hyphen chars.
 */
function parseBoundary(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_CONTENT_TYPE_LENGTH ||
    /[\r\n]/.test(value)
  ) {
    return { error: fail('INVALID_CONTENT_TYPE', 'contentType is required and must not contain CR or LF') };
  }

  const semicolon = value.indexOf(';');
  const mediaType = (semicolon === -1 ? value : value.slice(0, semicolon)).trim().toLowerCase();
  if (mediaType !== 'multipart/byteranges') {
    return {
      error: fail(
        'INVALID_CONTENT_TYPE',
        "contentType must be 'multipart/byteranges' with a boundary parameter",
      ),
    };
  }

  let boundary;
  if (semicolon !== -1) {
    for (const rawParam of value.slice(semicolon + 1).split(';')) {
      const eq = rawParam.indexOf('=');
      if (eq === -1) {
        return { error: fail('INVALID_CONTENT_TYPE', `malformed parameter '${rawParam.trim()}'`) };
      }
      const name = rawParam.slice(0, eq).trim().toLowerCase();
      const quotedRaw = rawParam.slice(eq + 1).trim();
      if (!TOKEN_RE.test(name)) {
        return { error: fail('INVALID_CONTENT_TYPE', `malformed parameter name '${name}'`) };
      }

      let paramValue;
      if (quotedRaw.startsWith('"')) {
        if (quotedRaw.length < 2 || !quotedRaw.endsWith('"')) {
          return { error: fail('INVALID_CONTENT_TYPE', `parameter '${name}' has an unterminated quoted value`) };
        }
        const inner = quotedRaw.slice(1, -1);
        if (!QUOTED_VALUE_RE.test(inner)) {
          return { error: fail('INVALID_CONTENT_TYPE', `parameter '${name}' has an invalid quoted value`) };
        }
        paramValue = inner;
      } else {
        if (!TOKEN_RE.test(quotedRaw)) {
          return { error: fail('INVALID_CONTENT_TYPE', `parameter '${name}' must be a token or a quoted string`) };
        }
        paramValue = quotedRaw;
      }

      if (name === 'boundary') {
        if (boundary !== undefined) {
          return { error: fail('INVALID_CONTENT_TYPE', 'contentType carries more than one boundary parameter') };
        }
        boundary = paramValue;
      }
    }
  }

  if (boundary === undefined) {
    return { error: fail('MISSING_BOUNDARY', "contentType must include a 'boundary' parameter") };
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
 * Decode strictly canonical standard-alphabet base64. Returns null for empty
 * input, illegal characters, missing/extra padding or any non-canonical
 * quantum (round-tripping through Node's lenient decoder detects the rest).
 */
function decodeBase64(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) return null;
  if (!BASE64_RE.test(value)) return null;
  const buffer = Buffer.from(value, 'base64');
  if (buffer.length === 0 || buffer.toString('base64') !== value) return null;
  return buffer;
}

/**
 * Walk the wire message and collect one {start, end} per part, enforcing
 * framing, header and Content-Range rules.
 */
function parseMultipart(body, boundary, size) {
  const boundaryBytes = Buffer.from(boundary, 'ascii');
  const openPrefix = Buffer.concat([DASH_DASH_BUF, boundaryBytes]); // "--boundary"

  if (body.length < openPrefix.length + 2 || !body.subarray(0, openPrefix.length).equals(openPrefix)) {
    return {
      error: fail(
        'MALFORMED_MULTIPART',
        'message has no preamble and must begin with "--<boundary>"',
      ),
    };
  }

  const parts = [];
  const seenRanges = new Set();
  let pos = openPrefix.length;

  // A closing boundary at the very start encodes zero parts; nothing may
  // follow it but the terminating CRLF (no epilogue).
  if (body[pos] === HYPHEN && body[pos + 1] === HYPHEN) {
    if (body.length !== pos + 4 || body[pos + 2] !== CR || body[pos + 3] !== LF) {
      return { error: fail('MALFORMED_MULTIPART', 'closing boundary must be followed only by CRLF') };
    }
    return { parts };
  }
  if (body[pos] !== CR || body[pos + 1] !== LF) {
    return { error: fail('MALFORMED_MULTIPART', 'boundary line must be terminated by CRLF') };
  }
  pos += 2;

  for (;;) {
    if (parts.length >= MAX_PARTS) {
      return {
        error: fail('TOO_MANY_PARTS', `message has more than ${MAX_PARTS} parts`),
      };
    }

    // The delimiter is located first so the header block can never spill into
    // a previous part's data when the final part is unterminated.
    const delimiter = findDelimiter(body, boundaryBytes, pos);
    if (delimiter === null) {
      return { error: fail('MALFORMED_MULTIPART', 'part is not terminated by a closing boundary line') };
    }

    const headerEnd = body.indexOf(HEADER_TERMINATOR_BUF, pos);
    if (headerEnd === -1 || headerEnd > delimiter.pos || headerEnd - pos > MAX_HEADER_BLOCK_BYTES) {
      return { error: fail('INVALID_PART_HEADERS', 'part header block is missing or exceeds its size limit') };
    }
    const headerBlock = body.subarray(pos, headerEnd).toString('latin1');
    const headersResult = parsePartHeaders(headerBlock);
    if (headersResult.error) return headersResult;

    const dataStart = headerEnd + HEADER_TERMINATOR_BUF.length;

    // The CRLF preceding the boundary is transport padding, not part data.
    const dataLength = delimiter.pos - dataStart;
    const rangeError = evaluateContentRange(headersResult.contentRange, {
      size,
      dataLength,
      seenRanges,
    });
    if (rangeError) return { error: rangeError };

    const match = CONTENT_RANGE_RE.exec(headersResult.contentRange);
    parts.push({ start: Number(match[1]), end: Number(match[2]) });

    const afterBoundary = delimiter.pos + CRLF_BUF.length + openPrefix.length;
    if (delimiter.closing) {
      if (
        body.length !== afterBoundary + 4 ||
        body[afterBoundary] !== HYPHEN ||
        body[afterBoundary + 1] !== HYPHEN ||
        body[afterBoundary + 2] !== CR ||
        body[afterBoundary + 3] !== LF
      ) {
        return { error: fail('MALFORMED_MULTIPART', 'message has no epilogue; closing boundary must end the body') };
      }
      return { parts };
    }

    if (body[afterBoundary] !== CR || body[afterBoundary + 1] !== LF) {
      return { error: fail('MALFORMED_MULTIPART', 'boundary line must be terminated by CRLF') };
    }
    pos = afterBoundary + 2;
  }
}

/**
 * Locate the next boundary delimiter at or after `from`. A delimiter is the
 * byte sequence CRLF "--" boundary followed by either CRLF (next part) or
 * "--" (close). A boundary-looking sequence without that exact shape is part
 * of the data and never terminates the part.
 */
function findDelimiter(body, boundaryBytes, from) {
  const needle = Buffer.concat([CRLF_BUF, DASH_DASH_BUF, boundaryBytes]);
  let search = from;
  for (;;) {
    const idx = body.indexOf(needle, search);
    if (idx === -1) return null;
    const tail = idx + needle.length; // first byte after "--boundary"
    if (tail + 1 < body.length) {
      if (body[tail] === HYPHEN && body[tail + 1] === HYPHEN) {
        return { pos: idx, closing: true };
      }
      if (body[tail] === CR && body[tail + 1] === LF) {
        return { pos: idx, closing: false };
      }
    }
    search = idx + CRLF_BUF.length;
  }
}

function parsePartHeaders(block) {
  let contentRange;
  for (const line of block.split('\r\n')) {
    if (line.length === 0 || line[0] === ' ' || line[0] === '\t') {
      return { error: fail('INVALID_PART_HEADERS', 'empty header line or obsolete folding is not allowed') };
    }
    const colon = line.indexOf(':');
    if (colon <= 0 || !TOKEN_RE.test(line.slice(0, colon))) {
      return { error: fail('INVALID_PART_HEADERS', `malformed header line '${line}'`) };
    }
    const name = line.slice(0, colon);
    const value = line.slice(colon + 1).replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
    if (!FIELD_VALUE_RE.test(value)) {
      return { error: fail('INVALID_PART_HEADERS', `header '${name}' contains an illegal character`) };
    }
    if (name.toLowerCase() === 'content-range') {
      if (contentRange !== undefined) {
        return { error: fail('DUPLICATE_CONTENT_RANGE', 'each part must carry exactly one Content-Range header') };
      }
      contentRange = value;
    }
  }
  if (contentRange === undefined) {
    return { error: fail('MISSING_CONTENT_RANGE', 'each part must carry a Content-Range header') };
  }
  return { contentRange };
}

function evaluateContentRange(value, { size, dataLength, seenRanges }) {
  const match = CONTENT_RANGE_RE.exec(value);
  if (!match) {
    return fail('INVALID_CONTENT_RANGE', `Content-Range '${value}' must look like 'bytes 0-99/1000'`);
  }
  const [, startRaw, endRaw, totalRaw] = match;
  const start = Number(startRaw);
  const end = Number(endRaw);
  const total = Number(totalRaw);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !Number.isSafeInteger(total)) {
    return fail('INVALID_CONTENT_RANGE', 'Content-Range numbers must be safe integers');
  }
  if (start > end) {
    return fail('INVALID_CONTENT_RANGE', `Content-Range '${value}' has start after end`);
  }
  if (end >= size) {
    return fail(
      'CONTENT_RANGE_OUT_OF_BOUNDS',
      `Content-Range '${value}' lies outside the ${size}-byte resource`,
    );
  }
  if (total !== size) {
    return fail(
      'CONTENT_RANGE_COMPLETE_LENGTH_MISMATCH',
      `Content-Range '${value}' reports complete length ${total} but size is ${size}`,
    );
  }
  const key = `${start}-${end}`;
  if (seenRanges.has(key)) {
    return fail('DUPLICATE_CONTENT_RANGE', `Content-Range bytes ${key} is used by more than one part`);
  }
  seenRanges.add(key);
  const expectedLength = end - start + 1;
  if (dataLength !== expectedLength) {
    return fail(
      'PART_BYTE_LENGTH_MISMATCH',
      `part bytes ${key} declares ${expectedLength} bytes but carries ${dataLength}`,
    );
  }
  return null;
}

/**
 * Sort closed intervals by start offset and merge overlapping or adjacent
 * ones ([0-9] and [10-19] merge into [0-19]).
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
 * Set difference `minuend - subtrahend` of two merged, ascending interval
 * lists; result is merged and ascending.
 */
function subtractIntervals(minuend, subtrahend) {
  const result = [];
  let j = 0;
  for (const interval of minuend) {
    while (j < subtrahend.length && subtrahend[j].end < interval.start) j += 1;
    let cursor = interval.start;
    for (let k = j; k < subtrahend.length && subtrahend[k].start <= interval.end; k += 1) {
      if (subtrahend[k].end < cursor) continue;
      if (subtrahend[k].start > cursor) {
        result.push({ start: cursor, end: subtrahend[k].start - 1 });
      }
      cursor = Math.max(cursor, subtrahend[k].end + 1);
      if (cursor > interval.end) break;
    }
    if (cursor <= interval.end) result.push({ start: cursor, end: interval.end });
  }
  return result;
}

function fail(code, message) {
  return {
    statusCode: 400,
    code,
    error: 'Bad Request',
    message,
  };
}
