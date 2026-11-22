// Safeguard 4: every call requires a fallback, and every failure uses it. Leaving it out
// does not compile, and at run time the call rejects before sending anything.
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { LexqClient, LexqError, type ExecuteResult } from "../../src/index.ts";
import { MAX_DEPTH } from "../../src/json.ts";
import {
  TEST_API_KEY,
  closedPort,
  clientFor,
  decisionOf,
  fallbackOf,
  fallbackValue,
  lexqErrorOf,
  reply,
  startFakeLexq,
} from "../support/fake-lexq.ts";

test("a call without a fallback does not compile, and rejects before sending", async (t) => {
  const lexq = await startFakeLexq(reply.decision());
  t.after(() => lexq.close());
  // @ts-expect-error A call needs a fallback.
  await assert.rejects(clientFor(lexq).execute("group-1", { facts: {} }), TypeError);
  assert.equal(lexq.received.length, 0);
});

test("a LexQ error that is not retried uses the fallback too", async (t) => {
  const lexq = await startFakeLexq(reply.error(403, "P-009", "This group is disabled or has been deleted and cannot be executed"));
  t.after(() => lexq.close());
  const result = fallbackOf(await clientFor(lexq).execute("group-1", { facts: {}, fallback: () => ({ discount: 0 }) }));
  assert.deepEqual(result.value, { discount: 0 });
  assert.ok(result.error instanceof LexqError);
  assert.equal(result.error.status, 403);
  assert.equal(result.error.errorCode, "P-009");
  assert.match(result.error.message, /P-009: This group is disabled/);
});

test("the error names the reason, lists every attempt, and carries the key the call used", async () => {
  const port = await closedPort();
  const client = new LexqClient({ apiKey: TEST_API_KEY, baseUrl: `http://127.0.0.1:${port}` });
  const error = lexqErrorOf(
    await client.execute("group-1", { facts: {}, idempotencyKey: "order-1", timeoutMs: 2000, fallback: fallbackValue }),
  );
  assert.equal(error.reason, "connection");
  assert.ok(error.attempts.length >= 2);
  for (const attempt of error.attempts) {
    assert.equal(attempt.outcome, "connection");
    assert.equal(attempt.status, undefined);
  }
  assert.equal(error.idempotencyKey, "order-1");
  assert.match(error.message, /ECONNREFUSED/);
});

test("the fallback can be async", async (t) => {
  const lexq = await startFakeLexq(reply.unavailable());
  t.after(() => lexq.close());
  const result = fallbackOf(
    await clientFor(lexq, { retry: false }).execute("group-1", { facts: {}, fallback: async () => "held" }),
  );
  assert.equal(result.value, "held");
});

test("when the fallback throws, the call rejects with that error", async (t) => {
  const lexq = await startFakeLexq(reply.unavailable());
  t.after(() => lexq.close());
  const thrown = new Error("no safe default");
  await assert.rejects(
    clientFor(lexq, { retry: false }).execute("group-1", {
      facts: {},
      fallback: () => {
        throw thrown;
      },
    }),
    (error) => error === thrown,
  );
});

test("the deadline covers the attempts to reach LexQ, not the fallback", async (t) => {
  const lexq = await startFakeLexq(reply.hang());
  t.after(() => lexq.close());
  const startedAt = performance.now();
  const result = fallbackOf(
    await clientFor(lexq).execute("group-1", {
      facts: {},
      timeoutMs: 100,
      fallback: async () => {
        await sleep(300);
        return "slow but kept";
      },
    }),
  );
  assert.equal(result.value, "slow but kept");
  assert.ok(performance.now() - startedAt >= 390);
});

test("the result says whether it is LexQ's decision or the fallback's value", async (t) => {
  const lexq = await startFakeLexq(reply.decision(), reply.unavailable());
  t.after(() => lexq.close());
  const client = clientFor(lexq, { retry: false });
  const decided: ExecuteResult<string> = await client.execute("group-1", { facts: {}, fallback: fallbackValue });
  const fellBack: ExecuteResult<string> = await client.execute("group-1", { facts: {}, fallback: fallbackValue });
  assert.equal(decisionOf(decided).source, "lexq");
  const fallback = fallbackOf(fellBack);
  assert.equal(fallback.source, "fallback");
  // A fallback's value has no isBlocked.
  // @ts-expect-error FallbackResult has no isBlocked.
  assert.equal(fallback.isBlocked, undefined);
});

const unsendable: [string, Record<string, unknown>][] = [
  ["NaN", { facts: { paymentAmount: Number.NaN } }],
  ["Infinity", { facts: { paymentAmount: Number.POSITIVE_INFINITY } }],
  ["-Infinity in a list", { facts: { amounts: [1, Number.NEGATIVE_INFINITY] } }],
  ["a list with a missing element", { facts: { tags: ["a", , "c"] } }],
  ["a list with undefined in it", { facts: { tags: ["a", undefined] } }],
  ["a function", { facts: { tier: () => "VIP" } }],
  ["a symbol", { facts: { tier: Symbol("VIP") } }],
  ["a Map", { facts: { tiers: new Map([["a", 1]]) } }],
  ["a structure that contains itself", { facts: (() => { const loop: Record<string, unknown> = {}; loop.self = loop; return { loop }; })() }],
  ["a fact that nests the body deeper than the limit", { facts: { deep: Array.from({ length: MAX_DEPTH - 1 }).reduce<unknown>((inner) => [inner], 1) } }],
  ["NaN in contexts", { facts: {}, contexts: { trafficKey: Number.NaN } }],
  ["an empty idempotency key", { facts: {}, idempotencyKey: "" }],
  ["an idempotency key with a line break", { facts: {}, idempotencyKey: "order-1\r\nx-api-key: stolen" }],
  ["an idempotency key with a space at the end", { facts: {}, idempotencyKey: "order-1 " }],
  ["an idempotency key that is not ASCII", { facts: {}, idempotencyKey: "주문-1" }],
];

for (const [problem, options] of unsendable) {
  test(`${problem} goes to the fallback as invalid_input, and nothing is sent`, async (t) => {
    const lexq = await startFakeLexq(reply.decision());
    t.after(() => lexq.close());
    const result = fallbackOf(
      await clientFor(lexq).execute("group-1", { facts: {}, fallback: fallbackValue, ...options } as never),
    );
    const { error } = result;
    assert.ok(error instanceof LexqError, `got ${error.name}`);
    assert.equal(error.reason, "invalid_input");
    assert.ok(error.cause instanceof TypeError, "the TypeError that stopped the request is the cause");
    assert.equal(error.message, error.cause.message);
    assert.deepEqual(error.attempts, []);
    assert.equal(error.status, undefined);
    assert.equal(error.errorCode, undefined);
    assert.equal(result.value, "fallback");
    assert.equal(lexq.received.length, 0);
  });
}

test("when the idempotency key is why nothing was sent, the error leaves the key out", async (t) => {
  const lexq = await startFakeLexq(reply.decision());
  t.after(() => lexq.close());
  const error = lexqErrorOf(
    await clientFor(lexq).execute("group-1", {
      facts: {},
      idempotencyKey: "order-1\r\nx-api-key: stolen",
      fallback: fallbackValue,
    }),
  );
  assert.equal(error.reason, "invalid_input");
  assert.equal(error.idempotencyKey, undefined);
  assert.doesNotMatch(error.message, /order-1|stolen|[\r\n]/);
});

test("when a fact is why nothing was sent, the error keeps the call's key", async (t) => {
  const lexq = await startFakeLexq(reply.decision());
  t.after(() => lexq.close());
  const error = lexqErrorOf(
    await clientFor(lexq).execute("group-1", {
      facts: { paymentAmount: Number.NaN },
      idempotencyKey: "order-1",
      fallback: fallbackValue,
    }),
  );
  assert.equal(error.reason, "invalid_input");
  assert.equal(error.idempotencyKey, "order-1");
});

const misuse: [string, string, Record<string, unknown>][] = [
  ["groupId is empty", "", {}],
  ['groupId is "."', ".", {}],
  ['groupId is ".."', "..", {}],
  ["facts is missing", "group-1", { facts: undefined }],
  ["facts is a list", "group-1", { facts: [] }],
  ["facts is a string", "group-1", { facts: "paymentAmount=1" }],
  ["contexts is a string", "group-1", { contexts: "mobile" }],
  ["idempotencyKey is a number", "group-1", { idempotencyKey: 12345 }],
  ["timeoutMs is 0", "group-1", { timeoutMs: 0 }],
  ["retry is a string", "group-1", { retry: "no" }],
];

for (const [problem, groupId, options] of misuse) {
  test(`when ${problem}, the call rejects with a TypeError without calling the fallback`, async (t) => {
    const lexq = await startFakeLexq(reply.decision());
    t.after(() => lexq.close());
    let fallbackCalled = false;
    await assert.rejects(
      clientFor(lexq).execute(groupId, {
        facts: {},
        fallback: () => {
          fallbackCalled = true;
        },
        ...options,
      } as never),
      TypeError,
    );
    assert.equal(fallbackCalled, false);
    assert.equal(lexq.received.length, 0);
  });
}
