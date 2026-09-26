// RFC 9110 byte-range response planner.
//
// Parsing, endpoint clamping and overlap/adjacency merging are delegated to
// range-parser.  The only pre-processing done here is RFC 9110 §14.1.2
// suffix normalisation (a suffix longer than the resource covers the whole
// representation) and strict byte-unit / syntax validation, which
// range-parser does not perform.

import { createHash } from 'node:crypto';
import createRangeParser from 'range-parser';
import { evaluateIfRange } from './conditional.js';

const rangeParser = createRangeParser.default ?? createRangeParser;

export const DEFAULT_CONTENT_TYPE = 'application/octet-stream';
export const DEFAULT_MAX_SEGMENTS = 16;
export const DEFAULT_TRANSFER_SIZE_RATIO = 2;

const CRLF = '\r\n';

// One byte-range-spec: whitespace, digits, whitespace, '-', whitespace, digits, whitespace.
// At least one side must carry digits (checked separately).
const RANGE_SPEC_RE = /^\s*(\d*)\s*-\s*(\d*)\s*$/;

/**
 * Plan a byte-range response for the given resource size and Range header.
 *
 * @returns a result object whose `statusCode` is the status the origin would
 *          send: 206 (one segment), 206 + multipart plan (several segments),
 *          416 (nothing satisfiable) or 422 (plan rejected by a guard).
 *          A 400 result means the Range header itself was malformed/unsupported.
 */
export function planRanges(options) {
  const {
    size,
    rangeHeader,
    contentType = DEFAULT_CONTENT_TYPE,
    maxSegments = DEFAULT_MAX_SEGMENTS,
    transferSizeRatio = DEFAULT_TRANSFER_SIZE_RATIO,
    etag,
    lastModified,
    ifRange,
  } = options;

  if (!Number.isSafeInteger(size) || size < 0) {
    return fail(400, 'INVALID_SIZE', 'size must be a non-negative safe integer');
  }
  if (typeof rangeHeader !== 'string') {
    return fail(400, 'MISSING_RANGE', 'a Range request header is required');
  }
  if (typeof contentType !== 'string' || /[\r\n]/.test(contentType) || contentType.length === 0) {
    return fail(400, 'INVALID_CONTENT_TYPE', 'contentType must be a single header-safe string');
  }
  if (etag !== undefined && (typeof etag !== 'string' || /[\r\n]/.test(etag) || etag.length === 0)) {
    return fail(400, 'INVALID_ETAG', 'etag must be a single header-safe entity-tag string');
  }
  if (
    lastModified !== undefined &&
    (typeof lastModified !== 'string' || /[\r\n]/.test(lastModified) || lastModified.length === 0)
  ) {
    return fail(400, 'INVALID_LAST_MODIFIED', 'lastModified must be a single header-safe HTTP-date string');
  }
  if (ifRange !== undefined && (typeof ifRange !== 'string' || /[\r\n]/.test(ifRange))) {
    return fail(400, 'INVALID_IF_RANGE', 'If-Range must be one entity-tag or one HTTP-date');
  }

  // RFC 9110 §13.1.3: a failed If-Range precondition downgrades the response
  // to the full representation. The Range header is not even parsed, so a
  // malformed Range paired with a failing If-Range still yields 200.
  const condition = ifRange !== undefined ? evaluateIfRange({ ifRange, etag, lastModified }) : null;
  if (condition && !condition.satisfied) {
    return buildFullRepresentation({ size, contentType, etag, lastModified, condition });
  }

  if (rangeHeader.length === 0) {
    return fail(400, 'MALFORMED_RANGE', "Range header must look like 'bytes=0-99'");
  }

  const normalizedHeaderResult = normalizeRangeHeader(rangeHeader, size);
  if (normalizedHeaderResult.error) return normalizedHeaderResult.error;

  const parsed = rangeParser(size, normalizedHeaderResult.value, { combine: true });

  if (parsed === -2) {
    // Defensive: strict validation above should already have caught this.
    return fail(400, 'MALFORMED_RANGE', 'Range header is not a syntactically valid byte-ranges value');
  }
  if (parsed === -1 || parsed.length === 0) {
    const responseHeaders = {
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes */${size}`,
    };
    if (etag !== undefined) responseHeaders.ETag = etag;
    if (lastModified !== undefined) responseHeaders['Last-Modified'] = lastModified;
    return {
      statusCode: 416,
      decision: 'partial',
      code: 'RANGE_NOT_SATISFIABLE',
      error: 'Range Not Satisfiable',
      message: `none of the requested ranges intersect the ${size}-byte resource`,
      resource: buildResource({ size, contentType, etag, lastModified }),
      responseHeaders,
      ...(condition ? {
        condition: {
          header: 'If-Range',
          validatorKind: condition.kind,
          outcome: 'passed',
          reason: condition.reason,
        },
      } : {}),
    };
  }

  return buildPlan({
    ranges: parsed,
    size,
    contentType,
    maxSegments,
    transferSizeRatio,
    etag,
    lastModified,
    condition,
  });
}

/**
 * Build the 200 plan for a full representation: If-Range failed (or the
 * request would otherwise be downgraded), so Range is ignored and the whole
 * resource would be sent with Content-Length: size.
 */
function buildFullRepresentation({ size, contentType, etag, lastModified, condition }) {
  const responseHeaders = {
    'Accept-Ranges': 'bytes',
    'Content-Type': contentType,
    'Content-Length': String(size),
  };
  if (etag !== undefined) responseHeaders.ETag = etag;
  if (lastModified !== undefined) responseHeaders['Last-Modified'] = lastModified;

  return {
    statusCode: 200,
    decision: 'full',
    resource: buildResource({ size, contentType, etag, lastModified }),
    segmentsCount: null,
    segments: null,
    bytes: {
      selected: size,
      framing: 0,
      total: size,
      resource: size,
      ratio: 1,
    },
    multipart: null,
    responseHeaders,
    condition: {
      header: 'If-Range',
      validatorKind: condition.kind,
      outcome: 'failed',
      reason: condition.reason,
    },
  };
}

/**
 * Resource descriptor shared by every plan; ETag/Last-Modified are only
 * echoed when the client supplied them.
 */
function buildResource({ size, contentType, etag, lastModified }) {
  const resource = { size, contentType };
  if (etag !== undefined) resource.etag = etag;
  if (lastModified !== undefined) resource.lastModified = lastModified;
  return resource;
}

/**
 * Validate the Range header and rewrite it into an equivalent header made
 * solely of absolute byte positions, so range-parser semantics match RFC 9110.
 */
function normalizeRangeHeader(header, size) {
  const eqIndex = header.indexOf('=');
  if (eqIndex === -1) {
    return { error: fail(400, 'MALFORMED_RANGE', "Range header must look like 'bytes=0-99'") };
  }

  const unit = header.slice(0, eqIndex).trim().toLowerCase();
  if (unit !== 'bytes') {
    return {
      error: fail(
        400,
        'UNSUPPORTED_RANGE_UNIT',
        `only byte ranges are supported, received range unit '${unit}'`,
      ),
    };
  }

  const specs = header
    .slice(eqIndex + 1)
    .split(',')
    .map((spec) => normalizeSpec(spec, size));

  if (specs.some((spec) => spec === null)) {
    return {
      error: fail(400, 'MALFORMED_RANGE', 'Range header contains an invalid byte-range-spec'),
    };
  }

  return { value: `bytes=${specs.join(',')}` };
}

/**
 * Normalise one byte-range-spec into absolute digits.
 * Returns null when the spec is syntactically invalid.
 * Unsatisfiable specs are encoded as `${size}-${size}`, which range-parser
 * always rejects (start === size, end clamped to size-1).
 */
function normalizeSpec(rawSpec, size) {
  const match = RANGE_SPEC_RE.exec(rawSpec);
  if (!match) return null;

  const startDigits = match[1];
  const endDigits = match[2];
  if (startDigits === '' && endDigits === '') return null;

  const sizeBig = BigInt(size);

  if (startDigits === '') {
    // Suffix range: bytes=-N  -> last N bytes; N >= size covers everything.
    const suffixLen = BigInt(endDigits);
    if (suffixLen === 0n) return `${size}-${size}`; // zero-length suffix: unsat
    if (size === 0 || suffixLen >= sizeBig) return size === 0 ? `${size}-${size}` : `0-${size - 1}`;
    return `${size - Number(suffixLen)}-${size - 1}`;
  }

  const start = BigInt(startDigits);
  if (start >= sizeBig) return `${size}-${size}`; // starts at/past end: unsat

  if (endDigits === '') {
    // Open-ended range: bytes=N- -> N..size-1.
    return `${Number(start)}-${size - 1}`;
  }

  const end = BigInt(endDigits);
  if (end < start) return `${size}-${size}`; // reversed closed range: unsat
  return `${Number(start)}-${end >= sizeBig ? size - 1 : Number(end)}`;
}

function buildPlan({ ranges, size, contentType, maxSegments, transferSizeRatio, etag, lastModified, condition }) {
  const boundary = makeBoundary({ size, contentType, ranges });

  const segments = ranges.map((range, index) => {
    const bytes = range.end - range.start + 1;
    const contentRange = `bytes ${range.start}-${range.end}/${size}`;
    return {
      index: index + 1,
      start: range.start,
      end: range.end,
      bytes,
      headers: {
        'Content-Type': contentType,
        'Content-Range': contentRange,
      },
      partHeaderBlock:
        `Content-Type: ${contentType}${CRLF}` +
        `Content-Range: ${contentRange}${CRLF}${CRLF}`,
    };
  });

  const selectedBytes = segments.reduce((sum, segment) => sum + segment.bytes, 0);
  const isMultipart = segments.length > 1;

  let framingBytes = 0;
  if (isMultipart) {
    // Wire layout (CRLF explicit):
    //   --boundary CRLF part1-headers data1 CRLF
    //   --boundary CRLF part2-headers data2 CRLF
    //   --boundary-- CRLF
    const delimiterLine = `--${boundary}${CRLF}`;
    const closingLine = `--${boundary}--${CRLF}`;
    framingBytes =
      segments.reduce(
        (sum, segment) => sum + delimiterLine.length + segment.partHeaderBlock.length + CRLF.length,
        0,
      ) + closingLine.length;
  }

  const totalBytes = selectedBytes + framingBytes;

  if (segments.length > maxSegments) {
    return {
      statusCode: 422,
      decision: 'partial',
      code: 'TOO_MANY_SEGMENTS',
      error: 'Unprocessable Entity',
      message: `range plan has ${segments.length} segments; at most ${maxSegments} are allowed`,
      resource: buildResource({ size, contentType, etag, lastModified }),
      segmentsCount: segments.length,
      maxSegments,
      selectedBytes,
      framingBytes,
      transferBytes: totalBytes,
    };
  }

  if (size > 0 && totalBytes > size * transferSizeRatio) {
    return {
      statusCode: 422,
      decision: 'partial',
      code: 'TRANSFER_LIMIT_EXCEEDED',
      error: 'Unprocessable Entity',
      message:
        `planned transfer of ${totalBytes} bytes exceeds ` +
        `${transferSizeRatio}x the ${size}-byte resource`,
      resource: buildResource({ size, contentType, etag, lastModified }),
      segmentsCount: segments.length,
      selectedBytes,
      framingBytes,
      transferBytes: totalBytes,
      limitBytes: size * transferSizeRatio,
    };
  }

  const base = {
    statusCode: 206,
    decision: 'partial',
    resource: buildResource({ size, contentType, etag, lastModified }),
    segmentsCount: segments.length,
    segments,
    bytes: {
      selected: selectedBytes,
      framing: framingBytes,
      total: totalBytes,
      resource: size,
      ratio: size === 0 ? null : totalBytes / size,
    },
  };

  const validatorHeaders = {};
  if (etag !== undefined) validatorHeaders.ETag = etag;
  if (lastModified !== undefined) validatorHeaders['Last-Modified'] = lastModified;

  // Why the range was honoured; present only when the client asked via If-Range.
  const conditionBlock =
    condition === null
      ? null
      : {
          header: 'If-Range',
          validatorKind: condition.kind,
          outcome: 'passed',
          reason: condition.reason,
        };

  if (!isMultipart) {
    const only = segments[0];
    return {
      ...base,
      multipart: null,
      responseHeaders: {
        'Accept-Ranges': 'bytes',
        ...validatorHeaders,
        'Content-Type': contentType,
        'Content-Range': `bytes ${only.start}-${only.end}/${size}`,
        'Content-Length': String(only.bytes),
      },
      ...(conditionBlock ? { condition: conditionBlock } : {}),
    };
  }

  const multipartContentType = `multipart/byteranges; boundary=${boundary}`;
  return {
    ...base,
    multipart: {
      boundary,
      boundaryDelimiter: `--${boundary}`,
      closingBoundary: `--${boundary}--`,
      lineTerminator: 'CRLF',
    },
    responseHeaders: {
      'Accept-Ranges': 'bytes',
      ...validatorHeaders,
      'Content-Type': multipartContentType,
      'Content-Length': String(totalBytes),
    },
    ...(conditionBlock ? { condition: conditionBlock } : {}),
  };
}

/**
 * Deterministic boundary: identical merged plans always get the same boundary.
 * 52 chars total, well within the 70-char HTTP token budget.
 */
function makeBoundary({ size, contentType, ranges }) {
  // Order-independent: the boundary identifies the covered byte set, not the
  // order the ranges happened to be listed in.
  const ordered = ranges.map((range) => [range.start, range.end]).sort((a, b) => a[0] - b[0]);
  const canonical = JSON.stringify({ size, contentType, ranges: ordered });
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 48);
  return `brp-${hash}`;
}

function fail(statusCode, code, message) {
  return {
    statusCode,
    code,
    error: statusCode === 400 ? 'Bad Request' : 'Unprocessable Entity',
    message,
  };
}
