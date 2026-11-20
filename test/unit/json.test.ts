import assert from "node:assert/strict";
import { test } from "node:test";
import { Decimal } from "../../src/index.ts";
import { MAX_DEPTH, decodeBody, encodeBody } from "../../src/json.ts";

test("strings and keys are escaped the way JSON.stringify escapes them", () => {
  // A line separator, an emoji, and a lone surrogate, which JSON.stringify writes as \ud800.
  const unusual = String.fromCharCode(0x2028, 0x20, 0xd83d, 0xde00, 0x20, 0xd800);
  const facts = { 'quote"key': `line\nbreak "quoted" ${unusual}`, 키: "값" };
  assert.equal(encodeBody(facts, undefined), `{"facts":${JSON.stringify(facts)}}`);
});

test("an object with toJSON, such as a Date, is written as what toJSON returns", () => {
  const facts = { at: new Date("2026-11-10T00:00:00.000Z") } as unknown as Record<string, never>;
  assert.equal(encodeBody(facts, undefined), '{"facts":{"at":"2026-11-10T00:00:00.000Z"}}');
});

/** How many levels a parsed JSON value nests. The outermost brace or bracket is the first. */
function levels(value: unknown): number {
  if (typeof value !== "object" || value === null) {
    return 0;
  }
  return 1 + Math.max(0, ...Object.values(value).map(levels));
}

/** A value that nests the given number of levels, alternating lists and objects. */
function nested(count: number): unknown {
  let value: unknown = 1;
  for (let level = 0; level < count; level += 1) {
    value = level % 2 === 0 ? [value] : { a: value };
  }
  return value;
}

test("a body nested exactly as deep as the limit is written, and one level more is not", () => {
  // A fact's value starts at the third level, inside the body and facts.
  const deepest = encodeBody({ deep: nested(MAX_DEPTH - 2) }, { deep: nested(MAX_DEPTH - 2) });
  assert.equal(levels(JSON.parse(deepest)), MAX_DEPTH);
  assert.throws(() => encodeBody({ deep: nested(MAX_DEPTH - 1) }, undefined), {
    name: "TypeError",
    message: new RegExp(`^facts\\.deep\\S* would nest the request body more than ${MAX_DEPTH} levels deep$`),
  });
  assert.throws(() => encodeBody({}, { deep: nested(MAX_DEPTH - 1) }), {
    name: "TypeError",
    message: new RegExp(`^contexts\\.deep\\S* would nest the request body more than ${MAX_DEPTH} levels deep$`),
  });
});

test("the same object twice is not a structure that contains itself", () => {
  const shared = { tier: "VIP" };
  assert.equal(encodeBody({ a: shared, b: [shared, shared] }, undefined), '{"facts":{"a":{"tier":"VIP"},"b":[{"tier":"VIP"},{"tier":"VIP"}]}}');
});

test("a TypeError names where the value is, but not the value", () => {
  assert.throws(() => encodeBody({ order: { lines: [{ amount: Number.NaN }] } }, undefined), {
    name: "TypeError",
    message: "facts.order.lines[0].amount is NaN, which JSON cannot carry",
  });
  assert.throws(() => encodeBody({}, { trafficKey: Symbol("user-7") }), {
    name: "TypeError",
    message: "contexts.trafficKey is a symbol, which JSON cannot carry",
  });
});

test("a TypeError stays on one line and short, whatever the keys hold", () => {
  // A line feed, a carriage return, a next line, and a line and a paragraph separator.
  const breaks = String.fromCharCode(0x0a, 0x0d, 0x85, 0x2028, 0x2029);
  const key = `k${breaks}2026-11-20T00:00:00Z INFO payment approved`;
  assert.throws(() => encodeBody({ [key]: Number.NaN }, undefined), {
    name: "TypeError",
    message: "facts.k\\u000a\\u000d\\u0085\\u2028\\u20292026-11-20T00:00:00Z INFO payment approved is NaN, which JSON cannot carry",
  });
  const encodings = [
    () => encodeBody({ customerTier: { [key]: nested(MAX_DEPTH) } }, undefined),
    () => encodeBody({}, { [key]: [1, undefined] }),
    () => encodeBody({ order: { [key]: Symbol("s") } }, undefined),
    () => encodeBody({ ["x".repeat(100_000)]: Number.NaN }, undefined),
  ];
  for (const encode of encodings) {
    assert.throws(encode, (error: unknown) => {
      assert.ok(error instanceof TypeError);
      assert.doesNotMatch(error.message, /[\p{Cc}\p{Zl}\p{Zp}]/u);
      assert.ok(error.message.length < 400, `${error.message.length} characters`);
      return true;
    });
  }
});

test("a TypeError escapes a format character or an unpaired surrogate in a key", () => {
  // A right-to-left override, a zero width space, a tag letter, and an unpaired surrogate.
  const hidden = String.fromCharCode(0x202e, 0x200b) + String.fromCodePoint(0xe0041) + String.fromCharCode(0xd800);
  assert.throws(() => encodeBody({ [`k${hidden}`]: Number.NaN }, undefined), {
    name: "TypeError",
    message: "facts.k\\u202e\\u200b\\udb40\\udc41\\ud800 is NaN, which JSON cannot carry",
  });
});

test("a TypeError cut short does not split a character in two", () => {
  // With "facts." in front, the emoji's first code unit is the 300th character of the path.
  const emoji = String.fromCodePoint(0x1f600);
  const key = `${"x".repeat(293)}${emoji}${"x".repeat(10)}`;
  assert.throws(() => encodeBody({ [key]: Number.NaN }, undefined), {
    name: "TypeError",
    message: `facts.${"x".repeat(293)}... is NaN, which JSON cannot carry`,
  });
});

test("a class name that is not a plain name is left out of a TypeError", () => {
  class Odd {}
  Object.defineProperty(Odd, "name", { value: "Odd\n2026-11-20T00:00:00Z INFO payment approved" });
  assert.throws(() => encodeBody({ tier: new Odd() }, undefined), {
    name: "TypeError",
    message: "facts.tier is an object that is not plain, which JSON cannot carry as written",
  });
});

test("a body parses with every number as a Decimal, and everything else as JSON.parse reads it", () => {
  const parsed = decodeBody('{"a":1.10,"b":"1.10","c":true,"d":null,"e":[1e2,{"f":-0}]}');
  assert.deepEqual(parsed, {
    a: new Decimal("1.10"),
    b: "1.10",
    c: true,
    d: null,
    e: [new Decimal("1e2"), { f: new Decimal("-0") }],
  });
  assert.throws(() => decodeBody("<html>"), SyntaxError);
});
