// RFC 9110 §13.1.3 If-Range precondition handling.
//
// An If-Range validator is either a single entity-tag or one HTTP-date.
// Range processing continues only when:
//   - the validator is a *strong* entity-tag verbatim-equal to the current
//     strong ETag of the representation (If-Match-style strong comparison),
//     or
//   - the validator is an HTTP-date that is not earlier than the current
//     Last-Modified instant (earlier-than comparison per RFC 9110 §13.1.3).
// Anything else (mismatch, missing resource metadata, weak validator,
// unparseable validator) makes the precondition fail: the recipient then
// ignores Range and sends the full representation.

// RFC 9110 §8.8.3:
//   entity-tag = [ weak ] opaque-tag
//   weak       = %x57.2F   ; "W/", case-sensitive
//   opaque-tag = DQUOTE *etagc DQUOTE
//   etagc      = %x21 / %x23-7E / obs-text
// CR, LF, other controls, DEL and a bare DQUOTE can therefore never occur
// inside a well-formed entity-tag.
const ETAGC_SOURCE = '\\x21\\x23-\\x7e\\x80-\\xff';
export const ENTITY_TAG_RE = new RegExp(`^(?:W/)?"(?:[${ETAGC_SOURCE}])*"$`);
export const STRONG_ENTITY_TAG_RE = new RegExp(`^"(?:[${ETAGC_SOURCE}])*"$`);

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_INDEX = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

// A recipient MUST accept all three HTTP-date formats (RFC 9110 §5.6.7):
//
//   IMF-fixdate (the only shape senders generate):
//     Sun, 06 Nov 1994 08:49:37 GMT
const IMF_FIXDATE_RE =
  /^(?<weekday>Sun|Mon|Tue|Wed|Thu|Fri|Sat), (?<day>\d{2}) (?<month>Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?<year>\d{4}) (?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2}) GMT$/;
//
//   obs-date — RFC 850 (full weekday name, 2-digit year):
//     Sunday, 06-Nov-94 08:49:37 GMT
const RFC850_DATE_RE =
  /^(?<weekday>Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), (?<day>\d{2})-(?<month>Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(?<year>\d{2}) (?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2}) GMT$/;
//
//   obs-date — ANSI C asctime (single-digit days are SP-padded):
//     Sun Nov  6 08:49:37 1994
const ASCTIME_DATE_RE =
  /^(?<weekday>Sun|Mon|Tue|Wed|Thu|Fri|Sat) (?<month>Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?<day>\d{2}| \d) (?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2}) (?<year>\d{4})$/;

/**
 * Parse a strict HTTP-date into a millisecond timestamp.
 *
 * Accepts all three standard formats (IMF-fixdate, RFC 850, asctime).
 * Returns null for anything that is not a syntactically and semantically
 * valid HTTP-date: the shape is matched with a strict regex, then the value
 * is reconstructed via Date.UTC to reject impossible dates (e.g. Feb 30),
 * out-of-range time fields and weekdays that do not match the calendar date.
 *
 * @param {string} value the received date string
 * @param {Date} [now] reception time, used to resolve RFC 850 two-digit
 *   years; defaults to the current instant.
 */
export function parseHttpDate(value, now = new Date()) {
  if (typeof value !== 'string') return null;

  const imf = IMF_FIXDATE_RE.exec(value);
  if (imf) {
    return buildInstant(toParts(imf.groups, imf.groups.weekday, Number(imf.groups.year)));
  }

  const rfc850 = RFC850_DATE_RE.exec(value);
  if (rfc850) {
    return buildInstant(
      toParts(
        rfc850.groups,
        // Full weekday name -> the 3-letter form used for the round-trip check.
        rfc850.groups.weekday.slice(0, 3),
        resolveRfc850Year(Number(rfc850.groups.year), now),
      ),
    );
  }

  const asctime = ASCTIME_DATE_RE.exec(value);
  if (asctime) {
    // Number() absorbs the SP padding of a single-digit day (" 6" -> 6).
    return buildInstant(toParts(asctime.groups, asctime.groups.weekday, Number(asctime.groups.year)));
  }

  return null;
}

function toParts(groups, weekday, year) {
  return {
    weekday,
    day: Number(groups.day),
    month: MONTH_INDEX[groups.month],
    year,
    hour: Number(groups.hour),
    minute: Number(groups.minute),
    second: Number(groups.second),
  };
}

/**
 * RFC 9110 §5.6.7: a two-digit year is interpreted relative to the UTC year
 * in which the message is received; if the result would be more than 50
 * years in the future, it is moved back one century. Received in 2026,
 * "94" therefore means 1994 while "26" means 2026.
 */
function resolveRfc850Year(twoDigitYear, now) {
  const currentYear = now.getUTCFullYear();
  const year = Math.floor(currentYear / 100) * 100 + twoDigitYear;
  return year - currentYear > 50 ? year - 100 : year;
}

/**
 * Reconstruct the instant from the parsed fields and round-trip it: rejects
 * impossible calendar dates (e.g. "31 Feb"), out-of-range time fields and
 * weekdays that do not match the calendar date.
 */
function buildInstant({ weekday, day, month, year, hour, minute, second }) {
  if (hour > 23 || minute > 59 || second > 59) return null;

  const time = Date.UTC(year, month, day, hour, minute, second);
  const date = new Date(time);

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day ||
    WEEKDAYS[date.getUTCDay()] !== weekday
  ) {
    return null;
  }
  return time;
}

/**
 * Evaluate an If-Range header against the current representation metadata.
 *
 * @param {string} ifRange      received If-Range field value
 * @param {string} [etag]       current ETag of the resource (strong or weak)
 * @param {string} [lastModified] current Last-Modified as an HTTP-date
 * @returns {{satisfied: boolean, kind: 'etag'|'date', reason: string}}
 *   reason is one of etag-match / etag-mismatch / weak-validator /
 *   date-not-earlier / date-earlier / resource-metadata-missing /
 *   invalid-validator.
 */
export function evaluateIfRange({ ifRange, etag, lastModified } = {}) {
  const value = ifRange;
  if (typeof value !== 'string' || value.length === 0) {
    return { satisfied: false, kind: 'etag', reason: 'invalid-validator' };
  }

  // An entity-tag validator starts with DQUOTE (weak ones with the case-
  // sensitive "W/"); anything else must parse as an HTTP-date.
  if (value.charCodeAt(0) === 0x22) {
    if (!STRONG_ENTITY_TAG_RE.test(value)) {
      return { satisfied: false, kind: 'etag', reason: 'invalid-validator' };
    }
    if (typeof etag !== 'string') {
      return { satisfied: false, kind: 'etag', reason: 'resource-metadata-missing' };
    }
    // Verbatim strong comparison: a weak current validator can never match,
    // and no normalisation (whitespace, case, weak prefix) is performed.
    if (!STRONG_ENTITY_TAG_RE.test(etag) || value !== etag) {
      return { satisfied: false, kind: 'etag', reason: 'etag-mismatch' };
    }
    return { satisfied: true, kind: 'etag', reason: 'etag-match' };
  }

  if (value.startsWith('W/')) {
    // RFC 9110: a weak validator in If-Range cannot authorise a partial
    // response; ignore the field entirely.
    return { satisfied: false, kind: 'etag', reason: 'weak-validator' };
  }

  // Both dates are interpreted relative to one reception instant so the
  // parsed-millisecond comparison stays consistent across year boundaries.
  const now = new Date();
  const requestTime = parseHttpDate(value, now);
  if (requestTime === null) {
    return { satisfied: false, kind: 'date', reason: 'invalid-validator' };
  }
  const currentTime = typeof lastModified === 'string' ? parseHttpDate(lastModified, now) : null;
  if (currentTime === null) {
    return { satisfied: false, kind: 'date', reason: 'resource-metadata-missing' };
  }

  // Earlier-than comparison: equal or fresher validators still select the
  // range (the common case is the client echoing Last-Modified verbatim).
  return requestTime < currentTime
    ? { satisfied: false, kind: 'date', reason: 'date-earlier' }
    : { satisfied: true, kind: 'date', reason: 'date-not-earlier' };
}
