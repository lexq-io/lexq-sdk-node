// Safeguard 3: a circuit breaker, on by default, that counts calls rather than attempts,
// opens at its threshold, and lets one trial call through after a cool-down.
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { LexqClient } from "../../src/index.ts";
import { MAX_ATTEMPTS } from "../../src/retry.ts";
import {
  TEST_API_KEY,
  closedPort,
  clientFor,
  decisionOf,
  fallbackValue,
  lexqErrorOf,
  reply,
  startFakeLexq,
  type Responder,
} from "../support/fake-lexq.ts";

const failing = { facts: {}, retry: false, fallback: fallbackValue } as const;

test("the breaker is on by default and opens at its threshold, so calls skip the network", async (t) => {
  const lexq = await startFakeLexq(reply.unavailable());
  t.after(() => lexq.close());
  const client = clientFor(lexq);
  for (let call = 1; call <= 5; call += 1) {
    assert.equal(lexqErrorOf(await client.execute("group-1", failing)).reason, "response");
  }
  const error = lexqErrorOf(await client.execute("group-1", failing));
  assert.equal(error.reason, "breaker_open");
  assert.deepEqual(error.attempts, []);
  assert.equal(lexq.received.length, 5);
});

test("the breaker counts calls, not attempts", async (t) => {
  const lexq = await startFakeLexq(reply.unavailable());
  t.after(() => lexq.close());
  const client = clientFor(lexq, { breaker: { threshold: 2 } });
  const first = lexqErrorOf(await client.execute("group-1", { facts: {}, timeoutMs: 10_000, fallback: fallbackValue }));
  assert.equal(first.attempts.length, MAX_ATTEMPTS);
  assert.notEqual(lexqErrorOf(await client.execute("group-1", failing)).reason, "breaker_open");
  assert.equal(lexqErrorOf(await client.execute("group-1", failing)).reason, "breaker_open");
});

const counted: [string, () => Promise<{ client: LexqClient; close: () => Promise<void> }>][] = [
  ["the deadline running out", async () => {
    const lexq = await startFakeLexq(reply.hang());
    return { client: clientFor(lexq, { breaker: { threshold: 1 }, timeoutMs: 100 }), close: () => lexq.close() };
  }],
  ["a connection that fails", async () => {
    const port = await closedPort();
    return {
      client: new LexqClient({ apiKey: TEST_API_KEY, baseUrl: `http://127.0.0.1:${port}`, breaker: { threshold: 1 } }),
      close: async () => {},
    };
  }],
  ["500", async () => {
    const lexq = await startFakeLexq(reply.error(500, "P-003"));
    return { client: clientFor(lexq, { breaker: { threshold: 1 } }), close: () => lexq.close() };
  }],
  ["502 with a body that is not JSON", async () => {
    const lexq = await startFakeLexq(reply.text(502, "<html>Bad Gateway</html>"));
    return { client: clientFor(lexq, { breaker: { threshold: 1 } }), close: () => lexq.close() };
  }],
];

for (const [ending, setUp] of counted) {
  test(`a call that ends with ${ending} adds one`, async (t) => {
    const { client, close } = await setUp();
    t.after(close);
    assert.notEqual(lexqErrorOf(await client.execute("group-1", failing)).reason, "breaker_open");
    assert.equal(lexqErrorOf(await client.execute("group-1", failing)).reason, "breaker_open");
  });
}

const resets: [string, Responder][] = [
  ["a decision", reply.decision()],
  ["400 with P-015", reply.error(400, "P-015")],
  ["409 with I-001", reply.error(409, "I-001")],
  ["429", reply.error(429, "C-007")],
  ["a redirect", reply.text(302, "", { location: "/elsewhere" })],
];

for (const [answer, responder] of resets) {
  test(`a call answered with ${answer} resets the count`, async (t) => {
    const fail = reply.unavailable();
    const lexq = await startFakeLexq(fail, responder, fail, reply.decision());
    t.after(() => lexq.close());
    const client = clientFor(lexq, { breaker: { threshold: 2 } });
    await client.execute("group-1", failing);
    await client.execute("group-1", failing);
    await client.execute("group-1", failing);
    // Two failures with a reset between them never reach the threshold of two.
    decisionOf(await client.execute("group-1", failing));
    assert.equal(lexq.received.length, 4);
  });
}

test("a call that sends nothing leaves the count alone", async (t) => {
  const lexq = await startFakeLexq(reply.unavailable());
  t.after(() => lexq.close());
  const client = clientFor(lexq, { breaker: { threshold: 2 } });
  await client.execute("group-1", failing);
  assert.equal(lexqErrorOf(await client.execute("group-1", { ...failing, facts: { amount: Number.NaN } })).reason, "invalid_input");
  assert.equal(lexqErrorOf(await client.execute("group-1", { ...failing, idempotencyKey: "" })).reason, "invalid_input");
  await client.execute("group-1", failing);
  assert.equal(lexqErrorOf(await client.execute("group-1", failing)).reason, "breaker_open");
  assert.equal(lexq.received.length, 2);
});

test("after the cool-down, one trial goes through with its retries while other calls get the fallback", async (t) => {
  const lexq = await startFakeLexq(
    reply.unavailable(),
    reply.unavailable(),
    reply.after(300, reply.decision()),
    reply.decision(),
  );
  t.after(() => lexq.close());
  const client = clientFor(lexq, { breaker: { threshold: 1, cooldownMs: 150 } });
  await client.execute("group-1", failing);
  assert.equal(lexqErrorOf(await client.execute("group-1", failing)).reason, "breaker_open");
  await sleep(200);
  const trial = client.execute("group-1", { facts: {}, timeoutMs: 3000, fallback: fallbackValue });
  await sleep(50);
  assert.equal(lexqErrorOf(await client.execute("group-1", failing)).reason, "breaker_open");
  decisionOf(await trial);
  // The trial's first attempt got a 503 and its retry got the decision, so the breaker closed.
  decisionOf(await client.execute("group-1", failing));
  assert.equal(lexq.received.length, 4);
});

test("a trial that fails opens the breaker again", async (t) => {
  const lexq = await startFakeLexq(reply.unavailable(), reply.unavailable(), reply.decision());
  t.after(() => lexq.close());
  const client = clientFor(lexq, { breaker: { threshold: 1, cooldownMs: 150 } });
  await client.execute("group-1", failing);
  await sleep(200);
  assert.equal(lexqErrorOf(await client.execute("group-1", failing)).reason, "response");
  assert.equal(lexqErrorOf(await client.execute("group-1", failing)).reason, "breaker_open");
  await sleep(200);
  decisionOf(await client.execute("group-1", failing));
  assert.equal(lexq.received.length, 3);
});

test("each client has its own breaker", async (t) => {
  const lexq = await startFakeLexq(reply.unavailable(), reply.decision());
  t.after(() => lexq.close());
  const opened = clientFor(lexq, { breaker: { threshold: 1 } });
  await opened.execute("group-1", failing);
  assert.equal(lexqErrorOf(await opened.execute("group-1", failing)).reason, "breaker_open");
  decisionOf(await clientFor(lexq, { breaker: { threshold: 1 } }).execute("group-1", failing));
});

test("the client can turn the breaker off", async (t) => {
  const lexq = await startFakeLexq(reply.unavailable());
  t.after(() => lexq.close());
  const client = clientFor(lexq, { breaker: false });
  for (let call = 1; call <= 8; call += 1) {
    assert.equal(lexqErrorOf(await client.execute("group-1", failing)).reason, "response");
  }
  assert.equal(lexq.received.length, 8);
});

test("breaker options of the wrong type or range throw", () => {
  const invalid: unknown[] = [true, null, "off", { threshold: 0 }, { threshold: 1.5 }, { cooldownMs: 0 }, { cooldownMs: Number.POSITIVE_INFINITY }];
  for (const breaker of invalid) {
    assert.throws(
      () => new LexqClient({ apiKey: TEST_API_KEY, breaker: breaker as false }),
      TypeError,
      JSON.stringify(breaker),
    );
  }
});
