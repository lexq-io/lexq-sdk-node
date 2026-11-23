// CONTRACT.md, Wire Contract: keep every number exact in both directions.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Decimal } from "../../src/index.ts";
import { CALL_FIELDS, clientFor, decisionOf, fallbackValue, reply, startFakeLexq } from "../support/fake-lexq.ts";

// The numbers from a real call: 38 significant digits sent to a rule that takes 10% off,
// the discounted amount LexQ rounded to 34 digits, and the 37-digit change. A JavaScript
// number keeps about 15 of them.
const SENT = "1234567890123456789012345678901234.5678";
const DISCOUNTED = "1111111101111111110111111111011111";
const DELTA = "-123456789012345678901234567890123.5678";

test("an amount with more than 34 significant digits goes out and comes back with every digit", async (t) => {
  const lexq = await startFakeLexq(
    reply.decision(
      `{"traceId":"trace-1",${CALL_FIELDS},"inputFacts":{"paymentAmount":${SENT}},"mutatedFacts":{"paymentAmount":${DISCOUNTED}},` +
        `"generatedVariables":{"paymentAmount__delta":${DELTA}}}`,
    ),
  );
  t.after(() => lexq.close());
  const decision = decisionOf(
    await clientFor(lexq).execute("group-1", { facts: { paymentAmount: new Decimal(SENT) }, fallback: fallbackValue }),
  );
  // A JSON number, not a string.
  assert.equal(lexq.received[0]?.body, `{"facts":{"paymentAmount":${SENT}}}`);
  assert.deepEqual(decision.inputFacts.paymentAmount, new Decimal(SENT));
  assert.equal(String(decision.mutatedFacts.paymentAmount), DISCOUNTED);
  assert.equal(String(decision.generatedVariables.paymentAmount__delta), DELTA);
});

test("every number in the facts comes back as a Decimal with its text as written", async (t) => {
  const written = ["0", "-0.0", "150000", "135000.00", "1E+2", "1e-7", "-15000", "1E+400"];
  const lexq = await startFakeLexq(
    reply.decision(
      `{"traceId":"t",${CALL_FIELDS},"inputFacts":{"values":[${written.join(",")}],"nested":{"count":3}},"mutatedFacts":{},"generatedVariables":{}}`,
    ),
  );
  t.after(() => lexq.close());
  const { inputFacts } = decisionOf(await clientFor(lexq).execute("group-1", { facts: {}, fallback: fallbackValue }));
  const values = inputFacts.values;
  assert.ok(Array.isArray(values));
  assert.deepEqual(
    values.map((value) => {
      assert.ok(value instanceof Decimal);
      return value.text;
    }),
    written,
  );
  assert.deepEqual(inputFacts.nested, { count: new Decimal("3") });
});

test("a number in the contexts or in a rule's action keeps every digit, and the processing time is a number", async (t) => {
  const lexq = await startFakeLexq(
    reply.decision(
      `{"traceId":"t","executedAt":"2026-04-27T09:44:10.512384Z","totalProcessingTimeMs":215,"inputContexts":{"limit":${SENT}},` +
        `"executionTraces":[{"generatedActions":[{"type":"MUTATE_FACT","parameters":{"operand":${DELTA}}}]}]}`,
    ),
  );
  t.after(() => lexq.close());
  const decision = decisionOf(await clientFor(lexq).execute("group-1", { facts: {}, fallback: fallbackValue }));
  assert.deepEqual(decision.inputContexts, { limit: new Decimal(SENT) });
  assert.deepEqual(decision.executionTraces[0]?.generatedActions[0]?.parameters, { operand: new Decimal(DELTA) });
  assert.equal(decision.totalProcessingTimeMs, 215);
});

test("numbers, bigints, and Decimals go out as JSON numbers", async (t) => {
  const lexq = await startFakeLexq(reply.decision());
  t.after(() => lexq.close());
  await clientFor(lexq).execute("group-1", {
    facts: { rate: 0.1, big: 1e21, negative: -0, count: 12345678901234567890n, amount: new Decimal("-1.50"), list: [1, new Decimal("2.0")] },
    fallback: fallbackValue,
  });
  assert.equal(
    lexq.received[0]?.body,
    '{"facts":{"rate":0.1,"big":1e+21,"negative":0,"count":12345678901234567890,"amount":-1.50,"list":[1,2.0]}}',
  );
});

test("a number from a decision can be sent back without losing a digit", async (t) => {
  const lexq = await startFakeLexq(
    reply.decision(
      `{"traceId":"t",${CALL_FIELDS},"inputFacts":{"paymentAmount":${SENT}},"mutatedFacts":{"paymentAmount":${DISCOUNTED}},"generatedVariables":{}}`,
    ),
  );
  t.after(() => lexq.close());
  const client = clientFor(lexq);
  const first = decisionOf(await client.execute("group-1", { facts: { paymentAmount: new Decimal(SENT) }, fallback: fallbackValue }));
  await client.execute("group-1", { facts: { paymentAmount: first.mutatedFacts.paymentAmount }, fallback: fallbackValue });
  assert.equal(lexq.received[1]?.body, `{"facts":{"paymentAmount":${DISCOUNTED}}}`);
});

test("a string is sent as a string, not as a number", async (t) => {
  const lexq = await startFakeLexq(reply.decision());
  t.after(() => lexq.close());
  await clientFor(lexq).execute("group-1", { facts: { paymentAmount: "150000" }, fallback: fallbackValue });
  assert.equal(lexq.received[0]?.body, '{"facts":{"paymentAmount":"150000"}}');
});

test("Decimal reads as text or as the nearest number, and JSON.stringify keeps its digits", () => {
  const amount = new Decimal(SENT);
  assert.equal(amount.text, SENT);
  assert.equal(amount.toString(), SENT);
  assert.equal(`${amount}`, SENT);
  assert.equal(amount.toNumber(), 1.2345678901234568e33);
  assert.equal(JSON.stringify({ amount }), `{"amount":${SENT}}`);
  assert.equal(new Decimal("1E+400").toNumber(), Number.POSITIVE_INFINITY);
  assert.equal(new Decimal(0.1).text, "0.1");
  assert.equal(new Decimal(150000n).text, "150000");
});

test("arithmetic and comparison on a Decimal throw instead of losing digits", () => {
  const amount = new Decimal("135000") as unknown as number;
  assert.throws(() => amount + 1, TypeError);
  assert.throws(() => amount * 2, TypeError);
  assert.throws(() => amount > 100, TypeError);
});

test("a Decimal needs a JSON number or a finite number", () => {
  for (const text of ["", "1.", ".5", "01", "+1", "1e", "0x10", "NaN", "Infinity", " 1", "1 ", "1,000", "١٢"]) {
    assert.throws(() => new Decimal(text), TypeError, JSON.stringify(text));
  }
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() => new Decimal(value), TypeError, String(value));
  }
  assert.throws(() => new Decimal({} as string), TypeError);
});

test("a Decimal cannot be changed", () => {
  const amount = new Decimal("1");
  assert.throws(() => {
    (amount as { text: string }).text = "2";
  }, TypeError);
  assert.equal(amount.text, "1");
});
