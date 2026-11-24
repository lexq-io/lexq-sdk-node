import { BACKOFF, KEY_IN_USE_WAIT, RATE_LIMIT_WAIT } from "./contract.ts";

// IMF-fixdate, the date form RFC 9110 has servers send, such as "Tue, 10 Nov 2026 00:00:05 GMT".
// Date.parse alone also accepts text such as "-1".
const HTTP_DATE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), [0-9]{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/;

/** A random time in the range. The random part keeps many clients from retrying at the same moment. */
function within(range: { readonly minMs: number; readonly maxMs: number }, random: () => number): number {
  return range.minMs + random() * (range.maxMs - range.minMs);
}

/** The wait after `failedAttempts` attempts have failed. */
export function backoff(failedAttempts: number, random: () => number = Math.random): number {
  const range = BACKOFF[failedAttempts - 1];
  if (range === undefined) {
    throw new RangeError(`there is no backoff after ${failedAttempts} failed attempts`);
  }
  return within(range, random);
}

/**
 * The wait after `I-002`. The request holding the key can run for seconds, so a backoff's
 * short waits would only get `I-002` again.
 */
export function keyInUseWait(random: () => number = Math.random): number {
  return within(KEY_IN_USE_WAIT, random);
}

/** The wait after a 429: what `Retry-After` asks for, or else a longer wait than a backoff. */
export function rateLimitWait(retryAfter: string | null, nowMs: number, random: () => number = Math.random): number {
  return parseRetryAfter(retryAfter, nowMs) ?? within(RATE_LIMIT_WAIT, random);
}

/** Reads `Retry-After` as seconds or as an HTTP date, in milliseconds from `nowMs`. */
export function parseRetryAfter(header: string | null, nowMs: number): number | undefined {
  if (header === null) {
    return undefined;
  }
  const value = header.trim();
  if (/^[0-9]+$/.test(value)) {
    return Number(value) * 1000;
  }
  if (!HTTP_DATE.test(value)) {
    return undefined;
  }
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - nowMs);
}
