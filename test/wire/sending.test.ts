// spec/SPEC.md, Wire: sending a request.
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { test } from "node:test";
import { LexqClient } from "../../src/index.ts";
import {
  DECISION_DATA,
  TEST_API_KEY,
  closedPort,
  clientFor,
  decisionOf,
  fallbackValue,
  lexqErrorOf,
  reply,
  startFakeLexq,
} from "../support/fake-lexq.ts";
import { spec } from "../support/spec.ts";

test("without baseUrl, the client calls the base URL in spec/values.json", async (t) => {
  const urls: string[] = [];
  // fetch is replaced for this test only, so nothing reaches the network.
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    urls.push(String(input));
    return new Response(`{"result":"SUCCESS","data":${DECISION_DATA}}`, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  decisionOf(await new LexqClient({ apiKey: TEST_API_KEY }).execute("group-1", { facts: {}, fallback: fallbackValue }));
  assert.deepEqual(urls, [`${spec.defaults.baseUrl}/api/v1/execution/groups/group-1`]);
});

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

test("null is sent as null at every level, and a key whose value is undefined is left out", async (t) => {
  const lexq = await startFakeLexq(reply.decision());
  t.after(() => lexq.close());
  decisionOf(
    await clientFor(lexq).execute("group-1", {
      facts: {
        userId: "u-1",
        couponCode: null,
        referrer: undefined,
        tags: ["a", null],
        profile: { tier: "VIP", region: null, note: undefined },
      },
      contexts: { trafficKey: null, channel: undefined },
      fallback: fallbackValue,
    }),
  );
  assert.equal(
    lexq.received[0]?.body,
    '{"facts":{"userId":"u-1","couponCode":null,"tags":["a",null],"profile":{"tier":"VIP","region":null}},"contexts":{"trafficKey":null}}',
  );
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

/**
 * Runs `body`, which must be synchronous, with the given globals defined, and puts back what
 * was there before when it returns or throws.
 */
function withGlobals(globals: Readonly<Record<string, unknown>>, body: () => undefined): void {
  const before = new Map<string, PropertyDescriptor | undefined>();
  try {
    for (const [name, value] of Object.entries(globals)) {
      before.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    }
    body();
  } finally {
    for (const [name, descriptor] of before) {
      if (descriptor === undefined) {
        Reflect.deleteProperty(globalThis, name);
      } else {
        Object.defineProperty(globalThis, name, descriptor);
      }
    }
  }
}

const startClient = () => new LexqClient({ apiKey: TEST_API_KEY });

test("the constructor throws in a web page, where window and document exist", () => {
  withGlobals({ window: {}, document: {} }, () => {
    assert.throws(startClient, /^Error: LexqClient runs on a server only: in a web page, the API key would reach every visitor$/);
  });
  assert.doesNotThrow(startClient);
});

test("the constructor does not throw where document exists without window", () => {
  withGlobals({ document: {} }, () => {
    assert.doesNotThrow(startClient);
  });
});

test("the constructor throws in a worker that a web page starts, where importScripts is a function and process is undefined", () => {
  withGlobals({ self: globalThis, importScripts() {}, process: undefined }, () => {
    assert.throws(startClient, /^Error: LexqClient runs on a server only: in a worker that a web page starts, the API key would reach every visitor to the page$/);
  });
  assert.doesNotThrow(startClient);
});

test("the constructor throws in a worker that a web page starts, where process has no versions.node, as in the process package's browser.js", () => {
  const browserProcess = { title: "browser", browser: true, env: {}, argv: [], version: "", versions: {} };
  withGlobals({ self: globalThis, importScripts() {}, process: browserProcess }, () => {
    assert.throws(startClient, /^Error: LexqClient runs on a server only: in a worker that a web page starts, the API key would reach every visitor to the page$/);
  });
  assert.doesNotThrow(startClient);
});

test("the constructor does not throw in a worker with importScripts and process.versions.node, as in a worker that the web-worker package starts in Node.js", () => {
  withGlobals({ self: globalThis, importScripts() {} }, () => {
    assert.equal(typeof process.versions.node, "string");
    assert.doesNotThrow(startClient);
  });
});

test("the constructor throws in a React Native app, where navigator.product is ReactNative", () => {
  // React Native also sets window and self to the global object when they are undefined, and,
  // when process is undefined, process to an object that holds only env. Its JavaScript defines
  // no document.
  const reactNativeProcess = { env: { NODE_ENV: "production" } };
  withGlobals({ window: globalThis, self: globalThis, process: reactNativeProcess, navigator: { product: "ReactNative" } }, () => {
    assert.throws(startClient, /^Error: LexqClient runs on a server only: in a React Native app, the API key would reach every user of the app$/);
  });
  assert.doesNotThrow(startClient);
});

test("the constructor does not throw where navigator.product is not ReactNative", () => {
  withGlobals({ navigator: { product: "Gecko" } }, () => {
    assert.doesNotThrow(startClient);
  });
});

test("the constructor does not throw in a worker global scope without importScripts, as in Deno's workers and Cloudflare Workers", () => {
  // Symbol.hasInstance makes every value an instance of both classes, so an instanceof check would
  // refuse here, as it would in a Deno worker, whose global object is an instance of WorkerGlobalScope.
  // The second run hides process, so that process.versions.node is not what lets the client start.
  class WorkerGlobalScope {
    static [Symbol.hasInstance](_value: unknown): boolean {
      return true;
    }
  }
  class ServiceWorkerGlobalScope extends WorkerGlobalScope {}
  withGlobals({ self: globalThis, WorkerGlobalScope, ServiceWorkerGlobalScope }, () => {
    assert.ok(globalThis instanceof WorkerGlobalScope);
    assert.doesNotThrow(startClient);
  });
  withGlobals({ self: globalThis, WorkerGlobalScope, ServiceWorkerGlobalScope, process: undefined }, () => {
    assert.doesNotThrow(startClient);
  });
});

test("the constructor does not throw where importScripts, process, and navigator are defined as undefined", () => {
  // The edge-runtime package defines none of the three names. Here each is defined with the
  // value undefined: that hides Node.js's own process and navigator, and a check that looked
  // only for the name importScripts would refuse here.
  withGlobals({ self: globalThis, importScripts: undefined, process: undefined, navigator: undefined }, () => {
    assert.doesNotThrow(startClient);
  });
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
