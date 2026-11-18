// CONTRACT.md, Wire Contract: sending a request.
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { test } from "node:test";
import { LexqClient } from "../../src/index.ts";
import {
  TEST_API_KEY,
  closedPort,
  clientFor,
  decisionOf,
  fallbackValue,
  lexqErrorOf,
  reply,
  startFakeLexq,
} from "../support/fake-lexq.ts";

test("the request is a JSON POST to the group, with the key in x-api-key and no Authorization", async (t) => {
  const lexq = await startFakeLexq(reply.decision());
  t.after(() => lexq.close());
  decisionOf(await clientFor(lexq).execute("01f2b274-0000-4000-8000-000000000001", { facts: {}, fallback: fallbackValue }));
  const [request] = lexq.received;
  assert.ok(request);
  assert.equal(request.method, "POST");
  assert.equal(request.path, "/api/v1/execution/groups/01f2b274-0000-4000-8000-000000000001");
  assert.equal(request.headers["x-api-key"], TEST_API_KEY);
  assert.equal(request.headers.authorization, undefined);
  assert.equal(request.headers["content-type"], "application/json");
  assert.equal(request.headers.accept, "application/json");
});

test("the group ID is encoded into one path segment", async (t) => {
  const lexq = await startFakeLexq(reply.error(404, "P-001"));
  t.after(() => lexq.close());
  await clientFor(lexq).execute("../../partners/groups?x=1#y", { facts: {}, fallback: fallbackValue });
  assert.equal(lexq.received[0]?.path, "/api/v1/execution/groups/..%2F..%2Fpartners%2Fgroups%3Fx%3D1%23y");
});

test("a path in baseUrl is kept in front of the API path", async (t) => {
  const lexq = await startFakeLexq(reply.decision());
  t.after(() => lexq.close());
  const client = new LexqClient({ apiKey: TEST_API_KEY, baseUrl: `${lexq.baseUrl}/gateway/lexq/` });
  decisionOf(await client.execute("group-1", { facts: {}, fallback: fallbackValue }));
  assert.equal(lexq.received[0]?.path, "/gateway/lexq/api/v1/execution/groups/group-1");
});

test("a fact whose value is null or undefined is left out of the request", async (t) => {
  const lexq = await startFakeLexq(reply.decision());
  t.after(() => lexq.close());
  decisionOf(
    await clientFor(lexq).execute("group-1", {
      facts: { userId: "u-1", couponCode: null, referrer: undefined, tags: ["a", null], profile: { tier: "VIP", note: undefined } },
      fallback: fallbackValue,
    }),
  );
  assert.equal(lexq.received[0]?.body, '{"facts":{"userId":"u-1","tags":["a",null],"profile":{"tier":"VIP"}}}');
});

test("trafficKey stays where the caller put it", async (t) => {
  const lexq = await startFakeLexq(reply.decision());
  t.after(() => lexq.close());
  const client = clientFor(lexq);
  await client.execute("group-1", { facts: { paymentAmount: 1 }, contexts: { trafficKey: "user-7" }, fallback: fallbackValue });
  await client.execute("group-1", { facts: { trafficKey: "user-7" }, fallback: fallbackValue });
  assert.equal(lexq.received[0]?.body, '{"facts":{"paymentAmount":1},"contexts":{"trafficKey":"user-7"}}');
  assert.equal(lexq.received[1]?.body, '{"facts":{"trafficKey":"user-7"}}');
});

test("the constructor throws where window and document exist", () => {
  const scope = globalThis as Record<string, unknown>;
  scope.window = {};
  scope.document = {};
  try {
    assert.throws(() => new LexqClient({ apiKey: TEST_API_KEY }), /server only/);
  } finally {
    delete scope.window;
    delete scope.document;
  }
  assert.doesNotThrow(() => new LexqClient({ apiKey: TEST_API_KEY }));
});

test("plain http is accepted only for localhost, 127.0.0.1, and [::1]", () => {
  for (const baseUrl of ["https://api.lexq.io", "http://localhost:8080", "http://127.0.0.1:8080", "http://[::1]:8080"]) {
    assert.doesNotThrow(() => new LexqClient({ apiKey: TEST_API_KEY, baseUrl }), baseUrl);
  }
  const rejected = [
    "http://api.lexq.io",
    "http://10.0.0.5:8080",
    "ftp://api.lexq.io",
    "https://user:secret@api.lexq.io",
    "https://api.lexq.io?region=eu",
    "https://api.lexq.io#top",
    "api.lexq.io",
    "",
  ];
  for (const baseUrl of rejected) {
    assert.throws(() => new LexqClient({ apiKey: TEST_API_KEY, baseUrl }), TypeError, baseUrl);
  }
});

test("an apiKey of the wrong type or with spaces throws", () => {
  for (const apiKey of ["", "lexq key", " lexq_key", 42, undefined]) {
    assert.throws(() => new LexqClient({ apiKey: apiKey as string }), TypeError, String(apiKey));
  }
});

test("the API key never reaches an error or an inspected client", async (t) => {
  const lexq = await startFakeLexq(reply.error(401, "A-003", "Invalid API Key"));
  t.after(() => lexq.close());
  const port = await closedPort();
  const errors = [
    lexqErrorOf(await clientFor(lexq).execute("group-1", { facts: {}, fallback: fallbackValue })),
    lexqErrorOf(
      await new LexqClient({ apiKey: TEST_API_KEY, baseUrl: `http://127.0.0.1:${port}`, retry: false }).execute("group-1", {
        facts: {},
        fallback: fallbackValue,
      }),
    ),
  ];
  for (const error of errors) {
    assert.doesNotMatch(inspect(error, { depth: 10 }), new RegExp(TEST_API_KEY));
    assert.doesNotMatch(JSON.stringify(error), new RegExp(TEST_API_KEY));
  }
  assert.doesNotMatch(inspect(clientFor(lexq), { depth: 10, showHidden: true }), new RegExp(TEST_API_KEY));
});

test("an error never carries a fact value", async (t) => {
  const lexq = await startFakeLexq(reply.error(500, "P-003"));
  t.after(() => lexq.close());
  const facts = { customerEmail: "secret.person@example.com", paymentAmount: 987654321 };
  const error = lexqErrorOf(await clientFor(lexq, { retry: false }).execute("group-1", { facts, fallback: fallbackValue }));
  const shown = `${inspect(error, { depth: 10 })} ${JSON.stringify(error)}`;
  assert.doesNotMatch(shown, /secret\.person|987654321/);
});
