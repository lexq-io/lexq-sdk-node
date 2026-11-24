// spec/SPEC.md, Wire: returning a decision.
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

test("the decision holds every field of LexQ's data and source, and nothing else", async () => {
  const decision = await decide(DOCUMENTED);
  const fields = [...Object.keys(JSON.parse(DOCUMENTED) as object), "source"];
  assert.deepEqual(Object.keys(decision).sort(), fields.sort());
});

test("the decision's type has none of the fields the client used to add", async () => {
  const decision = await decide(DOCUMENTED);
  // @ts-expect-error The client does not merge the fact layers.
  assert.equal(decision.facts, undefined);
  // @ts-expect-error A block is in the layers, where LexQ put it.
  assert.equal(decision.isBlocked, undefined);
  // @ts-expect-error The idempotency key is the caller's, and a failed call's error carries it.
  assert.equal(decision.idempotencyKey, undefined);
});

test("a field LexQ adds later reaches the caller, with its numbers as Decimals", async () => {
  const decision = await decide(`{"traceId":"t",${CALL_FIELDS},"riskSummary":{"score":12345678901234567890.5,"label":"low"}}`);
  assert.deepEqual((decision as unknown as Record<string, unknown>).riskSummary, { score: n("12345678901234567890.5"), label: "low" });
});

test("source wins over a field of the same name in LexQ's data, and LexQ's other fields stay as sent", async () => {
  const decision = await decide(
    `{"traceId":"t",${CALL_FIELDS},"inputFacts":{"a":1},"source":"engine","facts":{"b":2},"isBlocked":"yes","idempotencyKey":"other"}`,
  );
  const fields = decision as unknown as Record<string, unknown>;
  assert.equal(decision.source, "lexq");
  assert.deepEqual(fields.facts, { b: n("2") });
  assert.equal(fields.isBlocked, "yes");
  assert.equal(fields.idempotencyKey, "other");
});

test("a field named __proto__ in LexQ's data stays a field and changes no prototype", async () => {
  const decision = await decide(`{"traceId":"t",${CALL_FIELDS},"__proto__":{"polluted":true}}`);
  assert.equal(Object.hasOwn(decision, "__proto__"), true);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(Object.getPrototypeOf(decision), Object.prototype);
});

test("the fact layers come back as LexQ sent them, each on its own", async () => {
  const decision = await decide(
    `{"traceId":"trace-1",${CALL_FIELDS},"inputFacts":{"a":1,"b":2},"mutatedFacts":{"b":20},"generatedVariables":{"c":30}}`,
  );
  assert.deepEqual(decision.inputFacts, { a: n("1"), b: n("2") });
  assert.deepEqual(decision.mutatedFacts, { b: n("20") });
  assert.deepEqual(decision.generatedVariables, { c: n("30") });
});

test("a block comes back in generatedVariables, where LexQ put it", async () => {
  const decision = await decide(
    `{"traceId":"trace-1",${CALL_FIELDS},"inputFacts":{"userId":"u-1"},"mutatedFacts":{},"generatedVariables":{"isBlocked":true,"blockReason":"Policy Violation"}}`,
  );
  assert.deepEqual(decision.generatedVariables, { isBlocked: true, blockReason: "Policy Violation" });
});

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
  assert.deepEqual(decision.inputFacts, { a: "x" });
});

test("a layer, the contexts, or a trace list that LexQ sends as null is empty", async () => {
  const decision = await decide(
    `{"traceId":"t",${CALL_FIELDS},"inputFacts":null,"inputContexts":null,"mutatedFacts":null,"generatedVariables":null,"executionTraces":null,"decisionTraces":null}`,
  );
  assert.deepEqual(decision.inputFacts, {});
  assert.deepEqual(decision.inputContexts, {});
  assert.deepEqual(decision.mutatedFacts, {});
  assert.deepEqual(decision.generatedVariables, {});
  assert.deepEqual(decision.executionTraces, []);
  assert.deepEqual(decision.decisionTraces, []);
});

test("a fact named __proto__ stays a fact and changes no prototype", async () => {
  const decision = await decide(
    `{"traceId":"t",${CALL_FIELDS},"inputFacts":{"__proto__":{"polluted":true}},"mutatedFacts":{},"generatedVariables":{}}`,
  );
  assert.equal(Object.hasOwn(decision.inputFacts, "__proto__"), true);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(Object.getPrototypeOf(decision.inputFacts), Object.prototype);
});
