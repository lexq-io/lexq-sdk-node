// CONTRACT.md, Wire Contract: returning a decision.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Decimal } from "../../src/index.ts";
import { CALL_FIELDS, clientFor, decisionOf, fallbackValue, reply, startFakeLexq } from "../support/fake-lexq.ts";

async function decide(data: string) {
  const lexq = await startFakeLexq(reply.decision(data));
  try {
    return decisionOf(await clientFor(lexq).execute("group-1", { facts: {}, fallback: fallbackValue }));
  } finally {
    await lexq.close();
  }
}

const n = (text: string) => new Decimal(text);

const GROUP = "01f2b274-0000-4000-8000-000000000001";
const VERSION = "a6062090-0000-4000-8000-000000000001";
const RULE = "3b16ced1-0000-4000-8000-000000000001";

// The single-group response the Execution API reference shows, with its shortened IDs
// written out.
const DOCUMENTED =
  `{"traceId":"2e31f2b8-6c1d-4b8e-9f00-000000000001","executedAt":"2026-04-27T09:44:10.512384Z","totalProcessingTimeMs":3,` +
  `"inputFacts":{"userId":"user_abc","paymentAmount":150000,"customerTier":"VIP"},"inputContexts":{"channel":"mobile-app"},` +
  `"mutatedFacts":{"paymentAmount":135000},"generatedVariables":{"paymentAmount__delta":-15000},` +
  `"executionTraces":[{"policyGroupId":"${GROUP}","policyVersionId":"${VERSION}","ruleId":"${RULE}","ruleName":"VIP 10% Discount",` +
  `"matched":true,"matchExpression":"(customerTier == 'VIP') && (paymentAmount >= 100000)",` +
  `"generatedActions":[{"type":"MUTATE_FACT","parameters":{"method":"PERCENTAGE","operand":10,"operator":"SUB","targetVar":"paymentAmount"}}]}],` +
  `"decisionTraces":[{"ruleId":"${RULE}","ruleName":"VIP 10% Discount","policyGroupId":"${GROUP}","policyVersionId":"${VERSION}",` +
  `"status":"SELECTED","reasonCode":"FINAL_WINNER","reasonDetail":null}]}`;

test("the decision carries the response the Execution API reference shows", async () => {
  const decision = await decide(DOCUMENTED);
  assert.equal(decision.traceId, "2e31f2b8-6c1d-4b8e-9f00-000000000001");
  assert.equal(decision.executedAt, "2026-04-27T09:44:10.512384Z");
  assert.equal(decision.totalProcessingTimeMs, 3);
  assert.deepEqual(decision.inputFacts, { userId: "user_abc", paymentAmount: n("150000"), customerTier: "VIP" });
  assert.deepEqual(decision.inputContexts, { channel: "mobile-app" });
  assert.deepEqual(decision.mutatedFacts, { paymentAmount: n("135000") });
  assert.deepEqual(decision.generatedVariables, { paymentAmount__delta: n("-15000") });
  assert.deepEqual(decision.executionTraces, [
    {
      policyGroupId: GROUP,
      policyVersionId: VERSION,
      ruleId: RULE,
      ruleName: "VIP 10% Discount",
      matched: true,
      matchExpression: "(customerTier == 'VIP') && (paymentAmount >= 100000)",
      generatedActions: [
        { type: "MUTATE_FACT", parameters: { method: "PERCENTAGE", operand: n("10"), operator: "SUB", targetVar: "paymentAmount" } },
      ],
    },
  ]);
  assert.deepEqual(decision.decisionTraces, [
    {
      ruleId: RULE,
      ruleName: "VIP 10% Discount",
      policyGroupId: GROUP,
      policyVersionId: VERSION,
      status: "SELECTED",
      reasonCode: "FINAL_WINNER",
      reasonDetail: null,
    },
  ]);
});

test("every field of LexQ's data is in the decision", async () => {
  const decision = await decide(DOCUMENTED);
  const fields = Object.keys(JSON.parse(DOCUMENTED) as object);
  assert.deepEqual(
    fields.filter((field) => !Object.hasOwn(decision, field)),
    [],
  );
});

test("a field LexQ adds later reaches the caller, with its numbers as Decimals", async () => {
  const decision = await decide(`{"traceId":"t",${CALL_FIELDS},"riskSummary":{"score":12345678901234567890.5,"label":"low"}}`);
  assert.deepEqual((decision as unknown as Record<string, unknown>).riskSummary, { score: n("12345678901234567890.5"), label: "low" });
});

test("the client's own fields win over fields of the same name in LexQ's data", async () => {
  const decision = await decide(
    `{"traceId":"t",${CALL_FIELDS},"inputFacts":{"a":1},"source":"engine","facts":{"b":2},"isBlocked":"yes","idempotencyKey":"other"}`,
  );
  assert.equal(decision.source, "lexq");
  assert.deepEqual(decision.facts, { a: n("1") });
  assert.equal(decision.isBlocked, false);
  assert.notEqual(decision.idempotencyKey, "other");
});

test("a field named __proto__ in LexQ's data stays a field and changes no prototype", async () => {
  const decision = await decide(`{"traceId":"t",${CALL_FIELDS},"__proto__":{"polluted":true}}`);
  assert.equal(Object.hasOwn(decision, "__proto__"), true);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(Object.getPrototypeOf(decision), Object.prototype);
});

test("the final facts are inputFacts, then mutatedFacts, then generatedVariables", async () => {
  const decision = await decide(
    `{"traceId":"trace-1",${CALL_FIELDS},"inputFacts":{"a":1,"b":2,"c":3},"mutatedFacts":{"b":20},"generatedVariables":{"c":30,"d":40}}`,
  );
  assert.deepEqual(decision.facts, { a: n("1"), b: n("20"), c: n("30"), d: n("40") });
  assert.deepEqual(decision.inputFacts, { a: n("1"), b: n("2"), c: n("3") });
  assert.deepEqual(decision.mutatedFacts, { b: n("20") });
  assert.deepEqual(decision.generatedVariables, { c: n("30"), d: n("40") });
});

test("a block that arrives in generatedVariables sets isBlocked", async () => {
  const decision = await decide(
    `{"traceId":"trace-1",${CALL_FIELDS},"inputFacts":{"userId":"u-1"},"mutatedFacts":{},"generatedVariables":{"isBlocked":true,"blockReason":"Policy Violation"}}`,
  );
  assert.equal(decision.isBlocked, true);
  assert.equal(decision.facts.blockReason, "Policy Violation");
});

test("a block that arrives in mutatedFacts, because the request sent isBlocked, sets isBlocked", async () => {
  const decision = await decide(
    `{"traceId":"trace-1",${CALL_FIELDS},"inputFacts":{"isBlocked":false},"mutatedFacts":{"isBlocked":true},"generatedVariables":{}}`,
  );
  assert.equal(decision.isBlocked, true);
});

const notBlocked: [string, string][] = [
  ["no isBlocked", `{"traceId":"t",${CALL_FIELDS},"inputFacts":{},"mutatedFacts":{},"generatedVariables":{}}`],
  ["isBlocked false", `{"traceId":"t",${CALL_FIELDS},"inputFacts":{"isBlocked":false},"mutatedFacts":{},"generatedVariables":{}}`],
  ["isBlocked as the string true", `{"traceId":"t",${CALL_FIELDS},"inputFacts":{},"mutatedFacts":{},"generatedVariables":{"isBlocked":"true"}}`],
];

for (const [answer, data] of notBlocked) {
  test(`with ${answer}, isBlocked is false`, async () => {
    assert.equal((await decide(data)).isBlocked, false);
  });
}

test("traceId comes back with the decision", async () => {
  const decision = await decide(
    `{"traceId":"2e31f2b8-6c1d-4b8e-9f00-000000000001",${CALL_FIELDS},"inputFacts":{},"mutatedFacts":{},"generatedVariables":{}}`,
  );
  assert.equal(decision.traceId, "2e31f2b8-6c1d-4b8e-9f00-000000000001");
});

test("a layer, the contexts, or a trace list that LexQ leaves out is empty", async () => {
  const decision = await decide(`{"traceId":"t",${CALL_FIELDS},"inputFacts":{"a":"x"}}`);
  assert.deepEqual(decision.mutatedFacts, {});
  assert.deepEqual(decision.generatedVariables, {});
  assert.deepEqual(decision.inputContexts, {});
  assert.deepEqual(decision.executionTraces, []);
  assert.deepEqual(decision.decisionTraces, []);
  assert.deepEqual(decision.facts, { a: "x" });
});

test("a fact named __proto__ stays a fact and changes no prototype", async () => {
  const decision = await decide(
    `{"traceId":"t",${CALL_FIELDS},"inputFacts":{"__proto__":{"polluted":true}},"mutatedFacts":{},"generatedVariables":{}}`,
  );
  assert.equal(Object.hasOwn(decision.facts, "__proto__"), true);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(Object.getPrototypeOf(decision.facts), Object.prototype);
});
