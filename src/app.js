import Fastify from 'fastify';
import Ajv from 'ajv';
import {
  planRanges,
  DEFAULT_MAX_SEGMENTS,
  DEFAULT_TRANSFER_SIZE_RATIO,
} from './planner.js';
import {
  planResume,
  MAX_COMPLETED_INTERVALS,
  MAX_RESUME_REQUESTS,
} from './resume.js';
import {
  checkMultipart,
  MAX_CHECK_SEGMENTS,
  MAX_BASE64_CHARS,
} from './multipart-check.js';
import { ENTITY_TAG_RE, parseHttpDate } from './conditional.js';

const MEDIA_TYPE_RE =
  /^[A-Za-z0-9][A-Za-z0-9!#$%&'*+.^_`|~-]*\/[A-Za-z0-9][A-Za-z0-9!#$%&'*+.^_`|~-]*(?:\s*;\s*[A-Za-z0-9!#$%&'*+.^_`|~-]+=(?:[A-Za-z0-9!#$%&'*+.^_`|~-]+|"(?:[^"\\\r\n]|\\.)*"))*$/;

const planBodySchema = {
  type: 'object',
  required: ['size'],
  additionalProperties: false,
  properties: {
    size: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    contentType: { type: 'string', minLength: 1, maxLength: 255 },
    etag: { type: 'string', minLength: 1, maxLength: 1024 },
    lastModified: { type: 'string', minLength: 1, maxLength: 255 },
  },
};

const completedIntervalSchema = {
  type: 'object',
  required: ['start', 'end'],
  additionalProperties: false,
  properties: {
    start: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    end: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  },
};

const resumePlanBodySchema = {
  type: 'object',
  required: ['size', 'completed', 'chunkBytes', 'limit'],
  additionalProperties: false,
  properties: {
    size: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    completed: {
      type: 'array',
      maxItems: MAX_COMPLETED_INTERVALS,
      items: completedIntervalSchema,
    },
    chunkBytes: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    limit: { type: 'integer', minimum: 1, maximum: MAX_RESUME_REQUESTS },
  },
};

const expectedIntervalSchema = {
  type: 'object',
  required: ['start', 'end'],
  additionalProperties: false,
  properties: {
    start: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    end: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  },
};

const multipartCheckBodySchema = {
  type: 'object',
  required: ['size', 'expected', 'contentType', 'bodyBase64'],
  additionalProperties: false,
  properties: {
    size: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    expected: {
      type: 'array',
      maxItems: MAX_CHECK_SEGMENTS,
      items: expectedIntervalSchema,
    },
    contentType: { type: 'string', minLength: 1, maxLength: 512 },
    bodyBase64: { type: 'string', minLength: 1, maxLength: MAX_BASE64_CHARS },
  },
};

// Resume planning demands strict types: Fastify's default ajv setup coerces
// scalar types and silently strips unknown properties, which would let a
// string like "1000" pass as a byte count. This route therefore validates
// with coercion and property removal disabled.
const strictBodyAjv = new Ajv({
  coerceTypes: false,
  removeAdditional: false,
  useDefaults: false,
  allErrors: false,
});
const strictBodyValidatorCompiler = ({ schema }) => strictBodyAjv.compile(schema);

const MAX_HEADER_LENGTH = 4096;
const MAX_METADATA_LENGTH = { etag: 1024, lastModified: 255 };
// The wire message may be 1 MiB decoded; its JSON envelope (base64 + framing)
// is therefore allowed up to 2 MiB.
const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024;

export function buildApp(config = {}) {
  const app = Fastify({
    logger: config.logger ?? false,
    trustProxy: true,
    bodyLimit: MAX_JSON_BODY_BYTES,
  });

  const maxSegments = config.maxSegments ?? DEFAULT_MAX_SEGMENTS;
  const transferSizeRatio = config.transferSizeRatio ?? DEFAULT_TRANSFER_SIZE_RATIO;

  app.setErrorHandler((error, _request, reply) => {
    // Oversized JSON envelopes are bad input for this API, not a server
    // capacity problem: report them as a uniform 400.
    if (error.statusCode === 413) {
      return reply.status(400).send({
        statusCode: 400,
        code: 'BODY_TOO_LARGE',
        error: 'Bad Request',
        message: error.message,
      });
    }
    const statusCode = error.statusCode ?? 500;
    reply.status(statusCode).send({
      statusCode,
      code: error.code ?? 'REQUEST_ERROR',
      error: error.name ?? 'Error',
      message: error.message,
    });
  });

  app.get('/healthz', async () => ({ status: 'ok' }));

  // Primary endpoint: POST /plan with a JSON body, Range carried as a header
  // exactly as it would arrive on a real origin request.
  app.post('/plan', { schema: { body: planBodySchema } }, async (request, reply) => {
    const rangeError = checkRangeHeader(request);
    if (rangeError) return reply.status(400).send(rangeError);

    const ifRangeError = checkIfRangeHeader(request);
    if (ifRangeError) return reply.status(400).send(ifRangeError);

    if (request.body.contentType !== undefined && !MEDIA_TYPE_RE.test(request.body.contentType)) {
      return reply.status(400).send(invalidContentType());
    }

    const metadataError = checkMetadata({
      etag: request.body.etag,
      lastModified: request.body.lastModified,
    });
    if (metadataError) return reply.status(400).send(metadataError);

    const result = planRanges({
      size: request.body.size,
      contentType: request.body.contentType,
      rangeHeader: request.headers.range,
      maxSegments,
      transferSizeRatio,
      etag: request.body.etag,
      lastModified: request.body.lastModified,
      ifRange: request.headers['if-range'],
    });

    return reply.status(result.statusCode).send(result);
  });

  // Resumable-download gap planning: POST /resume-plan with the persisted
  // intervals in the JSON body; no Range header involved.
  app.post(
    '/resume-plan',
    {
      schema: { body: resumePlanBodySchema },
      validatorCompiler: strictBodyValidatorCompiler,
    },
    async (request, reply) => {
      const result = planResume({
        size: request.body.size,
        completed: request.body.completed,
        chunkBytes: request.body.chunkBytes,
        limit: request.body.limit,
      });

      return reply.status(result.statusCode).send(result);
    },
  );

  // multipart/byteranges verification: POST /multipart-check with the declared
  // size, expected intervals, part media type (carrying the boundary) and the
  // raw wire message base64-encoded in the JSON body.
  app.post(
    '/multipart-check',
    {
      schema: { body: multipartCheckBodySchema },
      validatorCompiler: strictBodyValidatorCompiler,
    },
    async (request, reply) => {
      const result = checkMultipart({
        size: request.body.size,
        expected: request.body.expected,
        contentType: request.body.contentType,
        bodyBase64: request.body.bodyBase64,
      });

      return reply.status(result.statusCode).send(result);
    },
  );

  // Convenience endpoint so the API is probeable with a bare curl:
  //   curl 'http://localhost:3000/plan?size=1000' -H 'Range: bytes=0-99'
  app.get('/plan', async (request, reply) => {
    const { size: sizeRaw, contentType, etag, lastModified } = request.query;

    const size = Number(sizeRaw);
    if (sizeRaw === undefined || !Number.isSafeInteger(size) || size < 0 || String(size) !== String(sizeRaw).trim()) {
      return reply.status(400).send({
        statusCode: 400,
        code: 'INVALID_SIZE',
        error: 'Bad Request',
        message: 'query parameter size is required and must be a non-negative integer',
      });
    }
    if (contentType !== undefined && !MEDIA_TYPE_RE.test(contentType)) {
      return reply.status(400).send(invalidContentType());
    }

    // Repeated query params arrive as arrays.
    const duplicateCodes = {
      etag: 'DUPLICATE_ETAG_PARAMETER',
      lastModified: 'DUPLICATE_LAST_MODIFIED_PARAMETER',
    };
    for (const [name, value] of [['etag', etag], ['lastModified', lastModified]]) {
      if (Array.isArray(value)) {
        return reply.status(400).send({
          statusCode: 400,
          code: duplicateCodes[name],
          error: 'Bad Request',
          message: `exactly one ${name} query parameter is allowed`,
        });
      }
    }

    const metadataError = checkMetadata({ etag, lastModified });
    if (metadataError) return reply.status(400).send(metadataError);

    const rangeError = checkRangeHeader(request);
    if (rangeError) return reply.status(400).send(rangeError);

    const ifRangeError = checkIfRangeHeader(request);
    if (ifRangeError) return reply.status(400).send(ifRangeError);

    const result = planRanges({
      size,
      contentType,
      rangeHeader: request.headers.range,
      maxSegments,
      transferSizeRatio,
      etag,
      lastModified,
      ifRange: request.headers['if-range'],
    });

    return reply.status(result.statusCode).send(result);
  });

  return app;
}

function invalidContentType() {
  return {
    statusCode: 400,
    code: 'INVALID_CONTENT_TYPE',
    error: 'Bad Request',
    message: 'contentType must be a valid media type, e.g. application/pdf',
  };
}

/**
 * Validate current-resource metadata that an If-Range header is evaluated
 * against. Fields are optional, but a present field must be a well-formed
 * entity-tag / HTTP-date and contain no CR/LF.
 */
function checkMetadata({ etag, lastModified }) {
  if (etag !== undefined) {
    if (etag.length > MAX_METADATA_LENGTH.etag || /[\r\n]/.test(etag) || !ENTITY_TAG_RE.test(etag)) {
      return {
        statusCode: 400,
        code: 'INVALID_ETAG',
        error: 'Bad Request',
        message: "etag must be a valid entity-tag, e.g. '\"abc123\"' or 'W/\"abc123\"'",
      };
    }
  }
  if (lastModified !== undefined) {
    if (
      lastModified.length > MAX_METADATA_LENGTH.lastModified ||
      /[\r\n]/.test(lastModified) ||
      parseHttpDate(lastModified) === null
    ) {
      return {
        statusCode: 400,
        code: 'INVALID_LAST_MODIFIED',
        error: 'Bad Request',
        message:
          'lastModified must be a valid HTTP-date (IMF-fixdate, RFC 850 or asctime format), ' +
          'e.g. Tue, 15 Nov 1994 08:12:31 GMT',
      };
    }
  }
  return null;
}

function checkRangeHeader(request) {
  // Reject duplicate Range headers explicitly; Node would otherwise silently
  // join them with a comma and produce a confusing parse error.
  let occurrences = 0;
  for (let i = 0; i < request.raw.rawHeaders.length; i += 2) {
    if (request.raw.rawHeaders[i].toLowerCase() === 'range') occurrences += 1;
  }
  if (occurrences > 1) {
    return {
      statusCode: 400,
      code: 'DUPLICATE_RANGE_HEADER',
      error: 'Bad Request',
      message: 'exactly one Range header is allowed',
    };
  }

  const rangeHeader = request.headers.range;
  if (rangeHeader === undefined) {
    return {
      statusCode: 400,
      code: 'MISSING_RANGE',
      error: 'Bad Request',
      message: 'a Range request header is required',
    };
  }
  if (rangeHeader.length > MAX_HEADER_LENGTH) {
    return {
      statusCode: 400,
      code: 'MALFORMED_RANGE',
      error: 'Bad Request',
      message: `Range header exceeds the ${MAX_HEADER_LENGTH}-byte limit`,
    };
  }
  return null;
}

function checkIfRangeHeader(request) {
  // Reject duplicate If-Range headers; a conditional field must carry exactly
  // one validator (one entity-tag or one HTTP-date, never a comma-joined list).
  let occurrences = 0;
  for (let i = 0; i < request.raw.rawHeaders.length; i += 2) {
    if (request.raw.rawHeaders[i].toLowerCase() === 'if-range') occurrences += 1;
  }
  if (occurrences > 1) {
    return {
      statusCode: 400,
      code: 'DUPLICATE_IF_RANGE_HEADER',
      error: 'Bad Request',
      message: 'exactly one If-Range header is allowed',
    };
  }

  const ifRange = request.headers['if-range'];
  if (ifRange === undefined) return null;

  // CR/LF must never reach a value even though the HTTP parser forbids them
  // in folded header content; reject unconditionally to rule out injection.
  if (/[\r\n]/.test(ifRange)) {
    return {
      statusCode: 400,
      code: 'INVALID_IF_RANGE',
      error: 'Bad Request',
      message: 'If-Range must not contain CR or LF characters',
    };
  }
  if (ifRange.length > MAX_HEADER_LENGTH) {
    return {
      statusCode: 400,
      code: 'INVALID_IF_RANGE',
      error: 'Bad Request',
      message: `If-Range header exceeds the ${MAX_HEADER_LENGTH}-byte limit`,
    };
  }
  return null;
}
