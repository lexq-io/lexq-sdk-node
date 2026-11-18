import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BACKOFF_MS,
  IN_PROGRESS_MS,
  RATE_LIMITED_MS,
  backoff,
  inProgressWait,
  parseRetryAfter,
  rateLimitWait,
} from "../../src/retry.ts";

test("the backoff doubles with each failed attempt and keeps half of it random", () => {
  for (const [failed, low, high] of [
    [1, BACKOFF_MS / 2, BACKOFF_MS],
    [2, BACKOFF_MS, BACKOFF_MS * 2],
    [3, BACKOFF_MS * 2, BACKOFF_MS * 4],
  ] as const) {
    assert.equal(backoff(failed, () => 0), low);
    assert.equal(backoff(failed, () => 1), high);
  }
});

test("Retry-After is read as seconds or as an HTTP date", () => {
  const now = Date.parse("2026-11-10T00:00:00Z");
  assert.equal(parseRetryAfter("2", now), 2000);
  assert.equal(parseRetryAfter(" 3 ", now), 3000);
  assert.equal(parseRetryAfter("0", now), 0);
  assert.equal(parseRetryAfter("Tue, 10 Nov 2026 00:00:05 GMT", now), 5000);
  assert.equal(parseRetryAfter("Mon, 09 Nov 2026 23:00:00 GMT", now), 0);
  assert.equal(parseRetryAfter("soon", now), undefined);
  assert.equal(parseRetryAfter("-1", now), undefined);
  assert.equal(parseRetryAfter("1.5", now), undefined);
  assert.equal(parseRetryAfter("2026-11-10T00:00:05Z", now), undefined);
  assert.equal(parseRetryAfter(null, now), undefined);
});

test("a 429 waits as long as Retry-After asks, or else longer than any backoff", () => {
  assert.equal(rateLimitWait("2", 0), 2000);
  assert.equal(rateLimitWait(null, 0, () => 0), RATE_LIMITED_MS);
  assert.equal(rateLimitWait("later", 0, () => 1), RATE_LIMITED_MS * 1.5);
  assert.ok(RATE_LIMITED_MS > BACKOFF_MS * 4);
});

test("an I-002 waits longer than any backoff", () => {
  assert.equal(inProgressWait(() => 0), IN_PROGRESS_MS);
  assert.equal(inProgressWait(() => 1), IN_PROGRESS_MS * 1.5);
  assert.ok(IN_PROGRESS_MS > BACKOFF_MS * 4);
});
