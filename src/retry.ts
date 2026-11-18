/** Attempts per call, counting the first. */
export const MAX_ATTEMPTS = 4;

/**
 * The base of the wait between attempts, in milliseconds. After the first failed
 * attempt the wait is 50 to 100 ms, then 100 to 200 ms, then 200 to 400 ms. The random
 * part keeps many clients from retrying at the same moment.
 */
export const BACKOFF_MS = 100;

/** The wait after a 429 without `Retry-After`, in milliseconds: 1000 to 1500 ms. */
export const RATE_LIMITED_MS = 1000;

/**
 * The wait after a 409 with `I-002`, in milliseconds: 1000 to 1500 ms. The request
 * holding the key can run for seconds, so a backoff's short waits would only get `I-002`
 * again.
 */
export const IN_PROGRESS_MS = 1000;

// IMF-fixdate, the date form RFC 9110 has servers send, such as "Tue, 10 Nov 2026 00:00:05 GMT".
// Date.parse alone also accepts text such as "-1".
const HTTP_DATE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), [0-9]{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/;

/** The wait after `failedAttempts` attempts have failed. */
export function backoff(failedAttempts: number, random: () => number = Math.random): number {
  const ceiling = BACKOFF_MS * 2 ** (failedAttempts - 1);
  return ceiling / 2 + random() * (ceiling / 2);
}

/** The wait after a 409 with `I-002`. */
export function inProgressWait(random: () => number = Math.random): number {
  return IN_PROGRESS_MS + random() * (IN_PROGRESS_MS / 2);
}

/** The wait after a 429: what `Retry-After` asks for, or else a longer wait than a backoff. */
export function rateLimitWait(retryAfter: string | null, nowMs: number, random: () => number = Math.random): number {
  return parseRetryAfter(retryAfter, nowMs) ?? RATE_LIMITED_MS + random() * (RATE_LIMITED_MS / 2);
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
