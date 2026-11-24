// Safeguard 1: every call has a deadline. The default is finite, the client sets it, a
// call can override it, and neither can turn it off. It covers every attempt and every
// wait, and each attempt has its own timeout, cut to the time left.
import assert from "node:assert/strict";
import { test } from "node:test";
import { LexqClient } from "../../src/index.ts";
import {
  TEST_API_KEY,
  clientFor,
  decisionOf,
  fallbackValue,
  lexqErrorOf,
  reply,
  startFakeLexq,
} from "../support/fake-lexq.ts";
import { spec } from "../support/spec.ts";

const { attemptTimeoutMs, deadlineMs } = spec.defaults;

// Timers fire late on a busy CI runner, so upper bounds leave room.
const SLACK_MS = 500;

test("without timeoutMs, a call to a server that never answers ends at the default deadline", async (t) => {
  const lexq = await startFakeLexq(reply.hang());
  t.after(() => lexq.close());
  const startedAt = performance.now();
  const error = lexqErrorOf(await clientFor(lexq).execute("group-1", { facts: {}, fallback: fallbackValue }));
  const elapsed = performance.now() - startedAt;
  assert.equal(error.reason, "deadline");
  assert.ok(Number.isFinite(deadlineMs));
  assert.ok(elapsed >= deadlineMs - 20, `ended after ${elapsed} ms`);
  assert.ok(elapsed < deadlineMs + SLACK_MS, `ended after ${elapsed} ms`);
  // The first attempt ran into the default attempt timeout, which is shorter than the deadline.
  const [first] = error.attempts;
  assert.ok(first, "the first attempt is listed");
  assert.equal(first.outcome, "timeout");
  assert.ok(first.durationMs >= attemptTimeoutMs - 20, `the first attempt took ${first.durationMs} ms`);
  assert.ok(first.durationMs < attemptTimeoutMs + SLACK_MS, `the first attempt took ${first.durationMs} ms`);
});

test("a call's timeoutMs replaces the client's", async (t) => {
  const lexq = await startFakeLexq(reply.hang());
  t.after(() => lexq.close());
  const client = clientFor(lexq, { timeoutMs: 5000 });
  const startedAt = performance.now();
  const error = lexqErrorOf(await client.execute("group-1", { facts: {}, timeoutMs: 200, fallback: fallbackValue }));
  const elapsed = performance.now() - startedAt;
  assert.equal(error.reason, "deadline");
  assert.ok(elapsed >= 180 && elapsed < 200 + SLACK_MS, `ended after ${elapsed} ms`);
});

test("neither the client nor a call can turn the deadline off", async (t) => {
  const lexq = await startFakeLexq(reply.decision());
  t.after(() => lexq.close());
  const invalid: unknown[] = [0, -1, Number.POSITIVE_INFINITY, Number.NaN, "300", null, 2 ** 31];
  for (const timeoutMs of invalid) {
    assert.throws(
      () => new LexqClient({ apiKey: TEST_API_KEY, baseUrl: lexq.baseUrl, timeoutMs: timeoutMs as number }),
      TypeError,
      `client timeoutMs ${String(timeoutMs)}`,
    );
    assert.throws(
      () => new LexqClient({ apiKey: TEST_API_KEY, baseUrl: lexq.baseUrl, attemptTimeoutMs: timeoutMs as number }),
      TypeError,
      `client attemptTimeoutMs ${String(timeoutMs)}`,
    );
    let fallbackCalled = false;
    await assert.rejects(
      clientFor(lexq).execute("group-1", {
        facts: {},
        timeoutMs: timeoutMs as number,
        fallback: () => {
          fallbackCalled = true;
        },
      }),
      TypeError,
      `call timeoutMs ${String(timeoutMs)}`,
    );
    assert.equal(fallbackCalled, false);
  }
  assert.equal(lexq.received.length, 0);
});

test("the deadline covers every attempt and every wait between them", async (t) => {
  const lexq = await startFakeLexq(reply.unavailable());
  t.after(() => lexq.close());
  const startedAt = performance.now();
  const error = lexqErrorOf(
    await clientFor(lexq, { breaker: false }).execute("group-1", { facts: {}, timeoutMs: 400, fallback: fallbackValue }),
  );
  const elapsed = performance.now() - startedAt;
  assert.ok(error.attempts.length >= 2, `${error.attempts.length} attempts`);
  assert.ok(elapsed < 400 + SLACK_MS, `ended after ${elapsed} ms`);
});

test("each attempt has its own timeout, so an attempt that hangs leaves time for another", async (t) => {
  const lexq = await startFakeLexq(reply.hang(), reply.decision());
  t.after(() => lexq.close());
  const client = clientFor(lexq, { attemptTimeoutMs: 150 });
  const decision = decisionOf(await client.execute("group-1", { facts: {}, timeoutMs: 2000, fallback: fallbackValue }));
  assert.equal(decision.traceId, "trace-1");
  assert.equal(lexq.received.length, 2);
});

test("an attempt's timeout is cut to the time left before the deadline", async (t) => {
  const lexq = await startFakeLexq(reply.hang());
  t.after(() => lexq.close());
  const client = clientFor(lexq, { attemptTimeoutMs: 1000 });
  const startedAt = performance.now();
  const error = lexqErrorOf(await client.execute("group-1", { facts: {}, timeoutMs: 200, fallback: fallbackValue }));
  const elapsed = performance.now() - startedAt;
  assert.equal(error.reason, "deadline");
  assert.equal(error.attempts.length, 1);
  assert.ok(elapsed < 200 + SLACK_MS, `ended after ${elapsed} ms`);
});

test("with retries off, the one attempt has the whole deadline", async (t) => {
  const lexq = await startFakeLexq(reply.after(300, reply.decision()));
  t.after(() => lexq.close());
  const client = clientFor(lexq, { attemptTimeoutMs: 100, retry: false });
  const decision = decisionOf(await client.execute("group-1", { facts: {}, timeoutMs: 2000, fallback: fallbackValue }));
  assert.equal(decision.traceId, "trace-1");
  assert.equal(lexq.received.length, 1);
});
