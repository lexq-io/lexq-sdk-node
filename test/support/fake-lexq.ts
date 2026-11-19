import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  LexqClient,
  LexqError,
  type ClientOptions,
  type DecisionResult,
  type ExecuteResult,
  type FallbackResult,
} from "../../src/index.ts";

export const TEST_API_KEY = "lexq_test_key_0123456789";

/** A request as the fake server received it. */
export interface Received {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  /** The body exactly as the bytes arrived. */
  readonly bytes: Buffer;
  readonly body: string;
  /** performance.now() when the whole request had arrived. */
  readonly at: number;
}

/** Answers one request. */
export type Responder = (response: ServerResponse, request: Received) => void;

export interface FakeLexq {
  readonly baseUrl: string;
  readonly received: Received[];
  close(): Promise<void>;
}

/**
 * Starts a server on 127.0.0.1 that answers the nth request with the nth responder.
 * The last responder answers every request after it.
 */
export async function startFakeLexq(...responders: [Responder, ...Responder[]]): Promise<FakeLexq> {
  const received: Received[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const bytes = Buffer.concat(chunks);
      const entry: Received = {
        method: request.method ?? "",
        path: request.url ?? "",
        headers: request.headers,
        bytes,
        body: bytes.toString("utf8"),
        at: performance.now(),
      };
      received.push(entry);
      const responder = responders[Math.min(received.length, responders.length) - 1];
      assert.ok(responder);
      responder(response, entry);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * The two fields LexQ writes about the call on every decision, as JSON text to put after
 * `traceId`. The client does not take a decision without them.
 */
export const CALL_FIELDS = '"executedAt":"2026-04-27T09:44:10.512384Z","totalProcessingTimeMs":3';

export const DECISION_DATA =
  `{"traceId":"trace-1",${CALL_FIELDS},"inputFacts":{"paymentAmount":150000},"inputContexts":{},` +
  '"mutatedFacts":{},"generatedVariables":{},"executionTraces":[],"decisionTraces":[]}';

export const reply = {
  /** A decision. `data` is JSON text, so a test can write numbers no JavaScript number holds. */
  decision(data: string = DECISION_DATA): Responder {
    return reply.json(200, `{"result":"SUCCESS","data":${data}}`);
  },
  /** LexQ's error envelope. */
  error(status: number, errorCode: string, message = "LexQ error message", headers: Record<string, string> = {}): Responder {
    return reply.json(status, JSON.stringify({ result: "ERROR", errorCode, message }), headers);
  },
  json(status: number, text: string, headers: Record<string, string> = {}): Responder {
    return (response) => {
      response.writeHead(status, { "content-type": "application/json", ...headers });
      response.end(text);
    };
  },
  text(status: number, text: string, headers: Record<string, string> = { "content-type": "text/html" }): Responder {
    return (response) => {
      response.writeHead(status, headers);
      response.end(text);
    };
  },
  /** A proxy's 503 page, in HTML rather than LexQ's envelope. */
  unavailable(): Responder {
    return reply.text(503, "<html>Service Unavailable</html>");
  },
  /** Never answers. */
  hang(): Responder {
    return () => {};
  },
  /** Closes the connection without answering. */
  drop(): Responder {
    return (response) => {
      response.socket?.destroy();
    };
  },
  /** Answers with `responder` after `ms` milliseconds. */
  after(ms: number, responder: Responder): Responder {
    return (response, request) => {
      setTimeout(() => responder(response, request), ms);
    };
  },
};

/** A client pointed at the fake server, with any options a test sets. */
export function clientFor(lexq: FakeLexq, options: Omit<ClientOptions, "apiKey" | "baseUrl"> = {}): LexqClient {
  return new LexqClient({ apiKey: TEST_API_KEY, baseUrl: lexq.baseUrl, ...options });
}

export function decisionOf<T>(result: ExecuteResult<T>): DecisionResult {
  if (result.source !== "lexq") {
    assert.fail(`expected LexQ's decision, got the fallback: ${result.error.message}`);
  }
  return result;
}

export function fallbackOf<T>(result: ExecuteResult<T>): FallbackResult<T> {
  if (result.source !== "fallback") {
    assert.fail(`expected the fallback, got LexQ's decision ${result.traceId}`);
  }
  return result;
}

export function lexqErrorOf<T>(result: ExecuteResult<T>): LexqError {
  const { error } = fallbackOf(result);
  assert.ok(error instanceof LexqError, `expected a LexqError, got ${error.name}: ${error.message}`);
  return error;
}

/** A port nothing listens on, for a connection that fails. */
export async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

export const fallbackValue = (): string => "fallback";
