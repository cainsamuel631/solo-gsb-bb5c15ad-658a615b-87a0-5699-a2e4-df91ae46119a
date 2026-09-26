// Resumable-download gap planner.
//
// Given a resource size and the byte intervals the client has already
// persisted (closed intervals, both endpoints inclusive, possibly unordered,
// overlapping or adjacent), compute which bytes are still missing and split
// the gaps into a bounded list of Range requests of at most `chunkBytes`
// each, ascending by offset.

export const MAX_COMPLETED_INTERVALS = 10000;
export const MAX_RESUME_REQUESTS = 10000;

/**
 * Plan the remaining Range requests needed to complete a download.
 *
 * @returns a result object with `statusCode` 200 carrying the request list,
 *          byte accounting and `hasMore`, or a 400 result describing the
 *          first validation failure.
 */
export function planResume(options) {
  const { size, completed, chunkBytes, limit } = options;

  if (!Number.isSafeInteger(size) || size < 0) {
    return fail('INVALID_SIZE', 'size must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) {
    return fail('INVALID_CHUNK_BYTES', 'chunkBytes must be a positive safe integer');
  }
  if (!Number.isSafeInteger(limit) || limit < 1) {
    return fail('INVALID_LIMIT', 'limit must be a positive safe integer');
  }
  if (limit > MAX_RESUME_REQUESTS) {
    return fail(
      'LIMIT_TOO_LARGE',
      `limit is ${limit}; at most ${MAX_RESUME_REQUESTS} requests are returned per call`,
    );
  }
  if (!Array.isArray(completed)) {
    return fail('INVALID_COMPLETED', 'completed must be an array of {start, end} intervals');
  }
  if (completed.length > MAX_COMPLETED_INTERVALS) {
    return fail(
      'TOO_MANY_INTERVALS',
      `completed carries ${completed.length} intervals; at most ${MAX_COMPLETED_INTERVALS} are allowed`,
    );
  }

  for (let i = 0; i < completed.length; i += 1) {
    const interval = completed[i];
    if (interval === null || typeof interval !== 'object' || Array.isArray(interval)) {
      return fail('INVALID_COMPLETED_RANGE', `completed[${i}] must be an object with start and end`);
    }
    const { start, end } = interval;
    if (!Number.isSafeInteger(start) || start < 0) {
      return fail(
        'INVALID_COMPLETED_RANGE',
        `completed[${i}].start must be a non-negative safe integer`,
      );
    }
    if (!Number.isSafeInteger(end) || end < 0) {
      return fail(
        'INVALID_COMPLETED_RANGE',
        `completed[${i}].end must be a non-negative safe integer`,
      );
    }
    if (start > end) {
      return fail(
        'INVALID_COMPLETED_RANGE',
        `completed[${i}] has start ${start} after end ${end}`,
      );
    }
    if (end >= size) {
      return fail(
        'COMPLETED_RANGE_OUT_OF_BOUNDS',
        `completed[${i}] end ${end} lies outside the ${size}-byte resource`,
      );
    }
  }

  const merged = mergeIntervals(completed);

  const completedBytes = merged.reduce((sum, interval) => sum + (interval.end - interval.start + 1), 0);
  const remainingBytes = size - completedBytes;

  // Missing byte gaps between the merged intervals, ascending by offset.
  const gaps = [];
  let cursor = 0;
  for (const interval of merged) {
    if (interval.start > cursor) gaps.push({ start: cursor, end: interval.start - 1 });
    cursor = interval.end + 1;
  }
  if (cursor < size) gaps.push({ start: cursor, end: size - 1 });

  // Split each gap into requests of at most chunkBytes, capped at limit.
  const requests = [];
  let plannedBytes = 0;
  outer: for (const gap of gaps) {
    for (let start = gap.start; start <= gap.end; start += chunkBytes) {
      if (requests.length >= limit) break outer;
      const end = Math.min(start + chunkBytes - 1, gap.end);
      requests.push({
        index: requests.length + 1,
        start,
        end,
        bytes: end - start + 1,
        rangeHeader: `bytes=${start}-${end}`,
      });
      plannedBytes += end - start + 1;
    }
  }

  return {
    statusCode: 200,
    resource: { size },
    completedBytes,
    remainingBytes,
    hasMore: plannedBytes < remainingBytes,
    requestsCount: requests.length,
    requests,
  };
}

/**
 * Sort intervals by start offset and merge overlapping or adjacent ones
 * ([0-9] and [10-19] are adjacent: no byte sits between them).
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

function fail(code, message) {
  return {
    statusCode: 400,
    code,
    error: 'Bad Request',
    message,
  };
}
