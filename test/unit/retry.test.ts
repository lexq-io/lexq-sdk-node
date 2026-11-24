import assert from "node:assert/strict";
import { test } from "node:test";
import { backoff, keyInUseWait, parseRetryAfter, rateLimitWait } from "../../src/retry.ts";
import { spec } from "../support/spec.ts";

const { backoff: backoffRanges, keyInUseWait: keyInUse, rateLimitWait: rateLimited } = spec.defaults;
const longestBackoff = Math.max(...backoffRanges.map((range) => range.maxMs));

test("each backoff is a random time in the range for that many failed attempts", () => {
  backoffRanges.forEach((range, index) => {
    assert.equal(backoff(index + 1, () => 0), range.minMs);
    assert.equal(backoff(index + 1, () => 1), range.maxMs);
  });
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

test("a 429 waits as long as Retry-After asks, or else a random time longer than any backoff", () => {
  assert.equal(rateLimitWait("2", 0), 2000);
  assert.equal(rateLimitWait(null, 0, () => 0), rateLimited.minMs);
  assert.equal(rateLimitWait("later", 0, () => 1), rateLimited.maxMs);
  assert.ok(rateLimited.minMs > longestBackoff);
});

test("an I-002 waits a random time longer than any backoff", () => {
  assert.equal(keyInUseWait(() => 0), keyInUse.minMs);
  assert.equal(keyInUseWait(() => 1), keyInUse.maxMs);
  assert.ok(keyInUse.minMs > longestBackoff);
});
