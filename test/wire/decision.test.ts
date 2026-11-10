// CONTRACT.md, Wire Contract: returning a decision.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Decimal } from "../../src/index.ts";
import { clientFor, decisionOf, fallbackValue, reply, startFakeLexq } from "../support/fake-lexq.ts";

async function decide(data: string) {
  const lexq = await startFakeLexq(reply.decision(data));
  try {
    return decisionOf(await clientFor(lexq).execute("group-1", { facts: {}, fallback: fallbackValue }));
  } finally {
    await lexq.close();
  }
}

const n = (text: string) => new Decimal(text);

test("the final facts are inputFacts, then mutatedFacts, then generatedVariables", async () => {
  const decision = await decide(
    '{"traceId":"trace-1","inputFacts":{"a":1,"b":2,"c":3},"mutatedFacts":{"b":20},"generatedVariables":{"c":30,"d":40}}',
  );
  assert.deepEqual(decision.facts, { a: n("1"), b: n("20"), c: n("30"), d: n("40") });
  assert.deepEqual(decision.inputFacts, { a: n("1"), b: n("2"), c: n("3") });
  assert.deepEqual(decision.mutatedFacts, { b: n("20") });
  assert.deepEqual(decision.generatedVariables, { c: n("30"), d: n("40") });
});

test("a block that arrives in generatedVariables sets isBlocked", async () => {
  const decision = await decide(
    '{"traceId":"trace-1","inputFacts":{"userId":"u-1"},"mutatedFacts":{},"generatedVariables":{"isBlocked":true,"blockReason":"Policy Violation"}}',
  );
  assert.equal(decision.isBlocked, true);
  assert.equal(decision.facts.blockReason, "Policy Violation");
});

test("a block that arrives in mutatedFacts, because the request sent isBlocked, sets isBlocked", async () => {
  const decision = await decide(
    '{"traceId":"trace-1","inputFacts":{"isBlocked":false},"mutatedFacts":{"isBlocked":true},"generatedVariables":{}}',
  );
  assert.equal(decision.isBlocked, true);
});

const notBlocked: [string, string][] = [
  ["no isBlocked", '{"traceId":"t","inputFacts":{},"mutatedFacts":{},"generatedVariables":{}}'],
  ["isBlocked false", '{"traceId":"t","inputFacts":{"isBlocked":false},"mutatedFacts":{},"generatedVariables":{}}'],
  ["isBlocked as the string true", '{"traceId":"t","inputFacts":{},"mutatedFacts":{},"generatedVariables":{"isBlocked":"true"}}'],
];

for (const [answer, data] of notBlocked) {
  test(`with ${answer}, isBlocked is false`, async () => {
    assert.equal((await decide(data)).isBlocked, false);
  });
}

test("traceId comes back with the decision", async () => {
  const decision = await decide('{"traceId":"2e31f2b8-6c1d-4b8e-9f00-000000000001","inputFacts":{},"mutatedFacts":{},"generatedVariables":{}}');
  assert.equal(decision.traceId, "2e31f2b8-6c1d-4b8e-9f00-000000000001");
});

test("a layer LexQ leaves out is empty", async () => {
  const decision = await decide('{"traceId":"t","inputFacts":{"a":"x"}}');
  assert.deepEqual(decision.mutatedFacts, {});
  assert.deepEqual(decision.generatedVariables, {});
  assert.deepEqual(decision.facts, { a: "x" });
});

test("a fact named __proto__ stays a fact and changes no prototype", async () => {
  const decision = await decide('{"traceId":"t","inputFacts":{"__proto__":{"polluted":true}},"mutatedFacts":{},"generatedVariables":{}}');
  assert.equal(Object.hasOwn(decision.facts, "__proto__"), true);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(Object.getPrototypeOf(decision.facts), Object.prototype);
});
