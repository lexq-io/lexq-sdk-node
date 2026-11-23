// Safeguard 2: a failed attempt is sent again with the same Idempotency-Key and the same
// bytes, for the outcomes in CONTRACT.md's retry table and no others.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Decimal } from "../../src/index.ts";
import { IN_PROGRESS_MS, MAX_ATTEMPTS, RATE_LIMITED_MS } from "../../src/retry.ts";
import {
  clientFor,
  decisionOf,
  fallbackValue,
  lexqErrorOf,
  reply,
  startFakeLexq,
  type Responder,
} from "../support/fake-lexq.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("every attempt of a call sends the same Idempotency-Key and the same bytes", async (t) => {
  const lexq = await startFakeLexq(reply.unavailable(), reply.text(502, "<html>Bad Gateway</html>"), reply.decision());
  t.after(() => lexq.close());
  decisionOf(
    await clientFor(lexq).execute("group-1", {
      facts: {
        paymentAmount: new Decimal("150000.10"),
        customerTier: "VIP",
        tags: ["new", "mobile"],
        quantity: 3,
      },
      contexts: { trafficKey: "user-7" },
      idempotencyKey: "order-12345",
      timeoutMs: 2000,
      fallback: fallbackValue,
    }),
  );
  assert.equal(lexq.received.length, 3);
  for (const request of lexq.received) {
    assert.equal(request.headers["idempotency-key"], "order-12345");
    assert.deepEqual(request.bytes, lexq.received[0]?.bytes);
  }
});

test("without a key, the client generates one per call and uses it for every attempt", async (t) => {
  const lexq = await startFakeLexq(reply.unavailable(), reply.decision());
  t.after(() => lexq.close());
  const client = clientFor(lexq);
  decisionOf(await client.execute("group-1", { facts: {}, timeoutMs: 2000, fallback: fallbackValue }));
  decisionOf(await client.execute("group-1", { facts: {}, timeoutMs: 2000, fallback: fallbackValue }));
  const [attemptOne, attemptTwo, nextCall] = lexq.received.map((request) => String(request.headers["idempotency-key"]));
  assert.equal(lexq.received.length, 3);
  assert.match(attemptOne ?? "", UUID);
  assert.equal(attemptTwo, attemptOne);
  assert.match(nextCall ?? "", UUID);
  assert.notEqual(nextCall, attemptOne);
});

test("a key the client generates reaches the fallback's error, so the call can be repeated with it", async (t) => {
  const lexq = await startFakeLexq(reply.unavailable());
  t.after(() => lexq.close());
  const error = lexqErrorOf(await clientFor(lexq, { retry: false }).execute("group-1", { facts: {}, fallback: fallbackValue }));
  const sent = String(lexq.received[0]?.headers["idempotency-key"]);
  assert.match(sent, UUID);
  assert.equal(error.idempotencyKey, sent);
});

test("a caller's key is sent unchanged, even past the 255 characters LexQ accepts", async (t) => {
  const lexq = await startFakeLexq(reply.error(400, "I-003"));
  t.after(() => lexq.close());
  const key = "k".repeat(300);
  const error = lexqErrorOf(await clientFor(lexq).execute("group-1", { facts: {}, idempotencyKey: key, fallback: fallbackValue }));
  assert.equal(lexq.received[0]?.headers["idempotency-key"], key);
  assert.equal(error.errorCode, "I-003");
  assert.equal(error.idempotencyKey, key);
  assert.equal(lexq.received.length, 1);
});

const retried: [string, Responder][] = [
  ["an attempt that times out", reply.hang()],
  ["a connection that fails", reply.drop()],
  ["502", reply.text(502, "<html>Bad Gateway</html>")],
  ["503", reply.unavailable()],
  ["504", reply.text(504, "<html>Gateway Timeout</html>")],
  ["409 with I-002", reply.error(409, "I-002")],
];

for (const [outcome, first] of retried) {
  test(`${outcome} is retried`, async (t) => {
    const lexq = await startFakeLexq(first, reply.decision());
    t.after(() => lexq.close());
    const client = clientFor(lexq, { attemptTimeoutMs: 150 });
    decisionOf(await client.execute("group-1", { facts: {}, timeoutMs: 3000, fallback: fallbackValue }));
    assert.equal(lexq.received.length, 2);
  });
}

test("409 with I-002 is retried after a longer wait than a backoff", async (t) => {
  const lexq = await startFakeLexq(reply.error(409, "I-002"), reply.decision());
  t.after(() => lexq.close());
  decisionOf(await clientFor(lexq).execute("group-1", { facts: {}, timeoutMs: 3000, fallback: fallbackValue }));
  const [first, second] = lexq.received;
  assert.ok(first && second);
  assert.ok(second.at - first.at >= IN_PROGRESS_MS - 50, `waited ${second.at - first.at} ms`);
});

test("429 is retried after Retry-After", async (t) => {
  const lexq = await startFakeLexq(reply.error(429, "C-007", "Too many requests", { "retry-after": "1" }), reply.decision());
  t.after(() => lexq.close());
  decisionOf(await clientFor(lexq).execute("group-1", { facts: {}, timeoutMs: 3000, fallback: fallbackValue }));
  const [first, second] = lexq.received;
  assert.ok(first && second);
  assert.ok(second.at - first.at >= 950, `waited ${second.at - first.at} ms`);
});

test("429 without Retry-After is retried after a longer wait than a backoff", async (t) => {
  const lexq = await startFakeLexq(reply.error(429, "C-007"), reply.decision());
  t.after(() => lexq.close());
  decisionOf(await clientFor(lexq).execute("group-1", { facts: {}, timeoutMs: 3000, fallback: fallbackValue }));
  const [first, second] = lexq.received;
  assert.ok(first && second);
  assert.ok(second.at - first.at >= RATE_LIMITED_MS - 50, `waited ${second.at - first.at} ms`);
});

test("429 is not retried when Retry-After asks for more time than the deadline has left", async (t) => {
  const lexq = await startFakeLexq(reply.error(429, "C-007", "Too many requests", { "retry-after": "30" }), reply.decision());
  t.after(() => lexq.close());
  const error = lexqErrorOf(await clientFor(lexq).execute("group-1", { facts: {}, timeoutMs: 1000, fallback: fallbackValue }));
  assert.equal(error.status, 429);
  assert.equal(error.errorCode, "C-007");
  assert.equal(lexq.received.length, 1);
});

const notRetried: [number, string][] = [
  [409, "I-001"],
  [403, "B-008"],
  [400, "P-015"],
  [400, "I-003"],
  [401, "A-003"],
  [403, "P-009"],
  [404, "P-001"],
  [413, "C-011"],
  [500, "P-003"],
];

for (const [status, errorCode] of notRetried) {
  test(`${status} with ${errorCode} is never retried`, async (t) => {
    const lexq = await startFakeLexq(reply.error(status, errorCode), reply.decision());
    t.after(() => lexq.close());
    const error = lexqErrorOf(await clientFor(lexq).execute("group-1", { facts: {}, timeoutMs: 2000, fallback: fallbackValue }));
    assert.equal(error.reason, "response");
    assert.equal(error.status, status);
    assert.equal(error.errorCode, errorCode);
    assert.equal(lexq.received.length, 1);
  });
}

test("retries stop after the attempt limit even when the deadline has time left", async (t) => {
  const lexq = await startFakeLexq(reply.unavailable());
  t.after(() => lexq.close());
  const error = lexqErrorOf(
    await clientFor(lexq, { breaker: false }).execute("group-1", { facts: {}, timeoutMs: 10_000, fallback: fallbackValue }),
  );
  assert.equal(lexq.received.length, MAX_ATTEMPTS);
  assert.equal(error.attempts.length, MAX_ATTEMPTS);
  assert.equal(error.status, 503);
});

test("the client can turn retries off", async (t) => {
  const lexq = await startFakeLexq(reply.unavailable(), reply.decision());
  t.after(() => lexq.close());
  lexqErrorOf(await clientFor(lexq, { retry: false }).execute("group-1", { facts: {}, fallback: fallbackValue }));
  assert.equal(lexq.received.length, 1);
});

test("a single call can turn retries off", async (t) => {
  const lexq = await startFakeLexq(reply.unavailable(), reply.decision());
  t.after(() => lexq.close());
  lexqErrorOf(await clientFor(lexq).execute("group-1", { facts: {}, retry: false, fallback: fallbackValue }));
  assert.equal(lexq.received.length, 1);
});

test("a single call can turn retries on when the client has them off", async (t) => {
  const lexq = await startFakeLexq(reply.unavailable(), reply.decision());
  t.after(() => lexq.close());
  const client = clientFor(lexq, { retry: false });
  decisionOf(await client.execute("group-1", { facts: {}, retry: true, timeoutMs: 2000, fallback: fallbackValue }));
  assert.equal(lexq.received.length, 2);
});
