// CONTRACT.md, Wire Contract: reading a response.
import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_BODY_BYTES, MAX_MESSAGE_LENGTH } from "../../src/attempt.ts";
import { CALL_FIELDS, clientFor, fallbackValue, lexqErrorOf, reply, startFakeLexq, type Responder } from "../support/fake-lexq.ts";

async function failureFrom(responder: Responder) {
  const lexq = await startFakeLexq(responder);
  try {
    const error = lexqErrorOf(await clientFor(lexq, { retry: false }).execute("group-1", { facts: {}, fallback: fallbackValue }));
    return { error, received: lexq.received };
  } finally {
    await lexq.close();
  }
}

test("the body is read for every status, 5xx included", async () => {
  const { error } = await failureFrom(reply.error(500, "P-003", "Action execution raised an error during evaluation"));
  assert.equal(error.status, 500);
  assert.equal(error.errorCode, "P-003");
  assert.match(error.message, /^LexQ answered 500 P-003: Action execution raised/);
});

for (const status of [301, 302, 307, 308]) {
  test(`a ${status} is never followed, and keeps its status`, async () => {
    const { error, received } = await failureFrom(reply.text(status, "", { location: "/api/v1/execution/groups/elsewhere" }));
    assert.equal(error.reason, "response");
    assert.equal(error.status, status);
    assert.equal(received.length, 1);
  });
}

test("a body that is not JSON is a failure that keeps its status", async () => {
  const { error } = await failureFrom(reply.text(502, "<html><body>502 Bad Gateway</body></html>"));
  assert.equal(error.reason, "response");
  assert.equal(error.status, 502);
  assert.equal(error.errorCode, undefined);
  assert.doesNotMatch(error.message, /html|Bad Gateway/i);
});

test("LexQ's message stays on one line and within MAX_MESSAGE_LENGTH", async () => {
  const lineSeparator = String.fromCharCode(0x2028);
  const forged = `Bad input\n2026-11-10T00:00:00Z INFO payment approved\r${lineSeparator}`;
  const { error } = await failureFrom(reply.error(400, "P-015", forged + "x".repeat(MAX_MESSAGE_LENGTH * 2)));
  assert.doesNotMatch(error.message, /[\p{Cc}\p{Zl}\p{Zp}]/u);
  assert.match(error.message, /^LexQ answered 400 P-015: Bad input 2026-11-10T00:00:00Z INFO payment approved x+\.\.\.$/);
  assert.ok(error.message.length < MAX_MESSAGE_LENGTH + 40);
});

test("an errorCode that is not a short token is not kept", async () => {
  for (const code of ["P-015\nINFO", "x".repeat(33), ""]) {
    const { error } = await failureFrom(reply.json(400, JSON.stringify({ result: "ERROR", errorCode: code, message: "m" })));
    assert.equal(error.errorCode, undefined, JSON.stringify(code));
    assert.equal(error.message, "LexQ answered 400");
  }
});

test("the code is read from errorCode, not code", async () => {
  const { error } = await failureFrom(reply.json(404, '{"result":"ERROR","code":"P-001","message":"Policy group not found."}'));
  assert.equal(error.status, 404);
  assert.equal(error.errorCode, undefined);
});

const defects: [string, Responder][] = [
  ["a 2xx with result ERROR", reply.json(200, '{"result":"ERROR","errorCode":"P-001","message":"x","data":{"traceId":"t"}}')],
  ["a 2xx without a result", reply.json(200, '{"data":{"traceId":"t","inputFacts":{}}}')],
  ["a 4xx with result SUCCESS", reply.json(400, '{"result":"SUCCESS","data":{"traceId":"t","inputFacts":{}}}')],
  ["a 5xx with result SUCCESS", reply.json(500, '{"result":"SUCCESS","data":{"traceId":"t","inputFacts":{}}}')],
  ["result SUCCESS without data", reply.json(200, '{"result":"SUCCESS"}')],
  ["JSON that is not an object", reply.json(200, '["SUCCESS"]')],
];

for (const [defect, responder] of defects) {
  test(`${defect} is a failure, even when it carries data`, async () => {
    const { error } = await failureFrom(responder);
    assert.equal(error.reason, "response");
  });
}

const brokenDecisions: [string, string, string][] = [
  ["a decision without a traceId", `{${CALL_FIELDS},"inputFacts":{}}`, "without a traceId"],
  ["a decision without executedAt", '{"traceId":"t","totalProcessingTimeMs":3}', "without executedAt"],
  [
    "a decision whose processing time is text",
    '{"traceId":"t","executedAt":"2026-04-27T09:44:10.512384Z","totalProcessingTimeMs":"3"}',
    "whose totalProcessingTimeMs is not a number",
  ],
  ["a decision whose facts are a list", `{"traceId":"t",${CALL_FIELDS},"inputFacts":[]}`, "whose inputFacts is not an object"],
  ["a decision whose contexts are a list", `{"traceId":"t",${CALL_FIELDS},"inputContexts":[]}`, "whose inputContexts is not an object"],
  ["a decision whose changed facts are text", `{"traceId":"t",${CALL_FIELDS},"mutatedFacts":"x"}`, "whose mutatedFacts is not an object"],
  ["a decision whose generated values are a list", `{"traceId":"t",${CALL_FIELDS},"generatedVariables":[]}`, "whose generatedVariables is not an object"],
  ["a decision whose traces are not a list", `{"traceId":"t",${CALL_FIELDS},"executionTraces":{}}`, "whose executionTraces is not a list of objects"],
  ["a decision with a trace that is not an object", `{"traceId":"t",${CALL_FIELDS},"decisionTraces":["SELECTED"]}`, "whose decisionTraces is not a list of objects"],
];

for (const [defect, data, problem] of brokenDecisions) {
  test(`${defect} is a failure that names what is wrong`, async () => {
    const { error } = await failureFrom(reply.json(200, `{"result":"SUCCESS","data":${data}}`));
    assert.equal(error.reason, "response");
    assert.equal(error.message, `LexQ answered 200 with result SUCCESS but a decision ${problem}`);
  });
}

test("a body larger than the limit is a failure that keeps its status", async () => {
  const { error } = await failureFrom((response) => {
    // Written in two chunks, so the body arrives without a content-length to check first.
    response.writeHead(200, { "content-type": "application/json" });
    response.write(Buffer.alloc(MAX_BODY_BYTES / 2, 0x20));
    response.write(Buffer.alloc(MAX_BODY_BYTES / 2 + 1, 0x20));
    response.end();
  });
  assert.equal(error.reason, "response");
  assert.equal(error.status, 200);
  assert.equal(error.message, `LexQ answered 200 with a body larger than ${MAX_BODY_BYTES} bytes`);
});

test("a body declared larger than the limit is not read", async () => {
  const { error } = await failureFrom((response) => {
    response.writeHead(200, { "content-type": "application/json", "content-length": String(MAX_BODY_BYTES + 1) });
    response.write("{");
  });
  assert.equal(error.reason, "response");
  assert.equal(error.status, 200);
  assert.equal(error.message, `LexQ answered 200 with a body larger than ${MAX_BODY_BYTES} bytes`);
});
