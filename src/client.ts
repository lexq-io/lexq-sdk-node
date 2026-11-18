import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { isRecord, sendAttempt, type AttemptOutcome, type PreparedRequest } from "./attempt.ts";
import { CircuitBreaker, DEFAULT_COOLDOWN_MS, DEFAULT_THRESHOLD } from "./breaker.ts";
import { LexqError, type Attempt } from "./errors.ts";
import { encodeBody } from "./json.ts";
import { MAX_ATTEMPTS, backoff, inProgressWait, rateLimitWait } from "./retry.ts";
import type {
  ClientOptions,
  DecisionResult,
  ExecuteOptions,
  ExecuteResult,
  Facts,
  FallbackResult,
} from "./types.ts";

export const DEFAULT_BASE_URL = "https://api.lexq.io";

/** The deadline for a call, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * The timeout for one attempt, in milliseconds. A decision can take seconds when LexQ is
 * busy. Cutting an attempt off does not stop the decision, which is still billed, and a
 * retry with that key gets `I-002` while the decision runs and for up to a minute after
 * it fails.
 */
export const DEFAULT_ATTEMPT_TIMEOUT_MS = 10_000;

// The longest delay a Node.js timer accepts. A longer one fires after 1 ms instead.
const MAX_TIMER_MS = 2_147_483_647;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
// Printable ASCII with no spaces, which is what a LexQ API key is.
const API_KEY = /^[\x21-\x7E]+$/;
// Printable ASCII with no space at either end. fetch would trim the ends, and the key
// LexQ stored would no longer be the one the error carries.
const HEADER_SAFE = /^[\x21-\x7E](?:[\x20-\x7E]*[\x21-\x7E])?$/;
const encoder = new TextEncoder();

/**
 * Calls LexQ's execution API with a deadline, retries, a circuit breaker, and a fallback.
 *
 * Create one client and reuse it: the circuit breaker belongs to the instance.
 *
 * @example
 * const lexq = new LexqClient({ apiKey: process.env.LEXQ_API_KEY! });
 * const result = await lexq.execute(groupId, {
 *   facts: { paymentAmount: 150000, customerTier: "VIP" },
 *   fallback: () => ({ discount: 0 }),
 * });
 */
export class LexqClient {
  readonly #apiKey: string;
  readonly #endpoint: string;
  readonly #timeoutMs: number;
  readonly #attemptTimeoutMs: number;
  readonly #retry: boolean;
  readonly #breaker: CircuitBreaker | undefined;

  /**
   * @throws {Error} In a browser, where the API key would reach every visitor.
   * @throws {TypeError} When an option has the wrong type or range.
   */
  constructor(options: ClientOptions) {
    if ("window" in globalThis && "document" in globalThis) {
      throw new Error("LexqClient runs on a server only: in a browser, the API key would reach every visitor");
    }
    if (typeof options !== "object" || options === null) {
      throw new TypeError("LexqClient needs an options object with an apiKey");
    }
    if (typeof options.apiKey !== "string" || !API_KEY.test(options.apiKey)) {
      throw new TypeError("apiKey must be a LexQ API key: printable ASCII with no spaces");
    }
    this.#apiKey = options.apiKey;
    this.#endpoint = endpoint(options.baseUrl ?? DEFAULT_BASE_URL);
    this.#timeoutMs = milliseconds("timeoutMs", options.timeoutMs) ?? DEFAULT_TIMEOUT_MS;
    this.#attemptTimeoutMs = milliseconds("attemptTimeoutMs", options.attemptTimeoutMs) ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
    this.#retry = flag("retry", options.retry) ?? true;
    this.#breaker = breaker(options.breaker);
  }

  /**
   * Runs the deployed version of a policy group against the facts, with
   * `POST /api/v1/execution/groups/{groupId}`.
   *
   * Resolves with LexQ's decision, or with the fallback's value and the reason it was
   * needed. It rejects only when the fallback throws, or before sending anything when
   * the fallback is missing or an option has the wrong type or range.
   */
  async execute<T>(groupId: string, options: ExecuteOptions<T>): Promise<ExecuteResult<T>> {
    if (typeof groupId !== "string" || groupId === "") {
      throw new TypeError("groupId must be a non-empty string");
    }
    if (groupId === "." || groupId === "..") {
      throw new TypeError(`groupId cannot be "${groupId}": in a URL it moves the request to another path`);
    }
    if (typeof options !== "object" || options === null) {
      throw new TypeError("execute needs an options object with facts and a fallback");
    }
    const { fallback } = options;
    if (typeof fallback !== "function") {
      throw new TypeError("fallback is required: the value your service uses when the call fails");
    }
    if (!isPlainObject(options.facts)) {
      throw new TypeError("facts must be a plain object");
    }
    if (options.contexts !== undefined && !isPlainObject(options.contexts)) {
      throw new TypeError("contexts must be a plain object");
    }
    if (options.idempotencyKey !== undefined && typeof options.idempotencyKey !== "string") {
      throw new TypeError("idempotencyKey must be a string");
    }
    const timeoutMs = milliseconds("timeoutMs", options.timeoutMs) ?? this.#timeoutMs;
    const retry = flag("retry", options.retry) ?? this.#retry;

    const idempotencyKey = options.idempotencyKey ?? randomUUID();
    let body: Uint8Array;
    try {
      if (!HEADER_SAFE.test(idempotencyKey)) {
        throw new TypeError(
          idempotencyKey === ""
            ? "idempotencyKey is empty"
            : "idempotencyKey must be printable ASCII with no space at either end, so a header carries it unchanged. Hash an ID that is not ASCII first",
        );
      }
      body = encoder.encode(encodeBody(options.facts, options.contexts));
    } catch (error) {
      if (error instanceof TypeError) {
        return settle(fallback, error);
      }
      throw error;
    }

    const permit = this.#breaker === undefined ? "closed" : this.#breaker.admit(performance.now());
    if (permit === undefined) {
      return settle(
        fallback,
        new LexqError("The circuit breaker is open, so the call did not reach LexQ", {
          reason: "breaker_open",
          attempts: [],
          idempotencyKey,
        }),
      );
    }
    let ending: DecisionResult | LexqError;
    try {
      ending = await this.#send(groupId, body, idempotencyKey, timeoutMs, retry);
    } catch (error) {
      this.#breaker?.release(permit);
      throw error;
    }
    this.#breaker?.record(permit, ending instanceof LexqError && countsAgainstBreaker(ending), performance.now());
    return ending instanceof LexqError ? settle(fallback, ending) : ending;
  }

  async #send(
    groupId: string,
    body: Uint8Array,
    idempotencyKey: string,
    timeoutMs: number,
    retry: boolean,
  ): Promise<DecisionResult | LexqError> {
    const request: PreparedRequest = {
      url: this.#endpoint + encodeURIComponent(groupId),
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
        "x-api-key": this.#apiKey,
      },
      body,
    };
    const deadlineAt = performance.now() + timeoutMs;
    const attempts: Attempt[] = [];
    for (;;) {
      const left = deadlineAt - performance.now();
      if (left <= 0) {
        return deadline(timeoutMs, attempts, idempotencyKey);
      }
      // With retries off, the one attempt has the whole deadline.
      const limit = retry ? Math.min(this.#attemptTimeoutMs, left) : left;
      const startedAt = performance.now();
      let outcome: AttemptOutcome = await sendAttempt(request, limit);
      const durationMs = Math.round(performance.now() - startedAt);
      if (outcome.kind === "decision") {
        const decision = toDecision(outcome.data, idempotencyKey);
        if (decision !== undefined) {
          return decision;
        }
        outcome = {
          kind: "response",
          status: outcome.status,
          errorCode: undefined,
          message: `LexQ answered ${outcome.status} with result SUCCESS but a decision without a traceId or with facts that are not objects`,
          retryAfter: null,
        };
      }
      attempts.push({
        outcome: outcome.kind,
        status: outcome.kind === "response" ? outcome.status : undefined,
        errorCode: outcome.kind === "response" ? outcome.errorCode : undefined,
        durationMs,
      });
      if (outcome.kind === "timeout" && limit === left) {
        return deadline(timeoutMs, attempts, idempotencyKey);
      }
      const wait = retry && attempts.length < MAX_ATTEMPTS ? waitBeforeRetry(outcome, attempts.length) : undefined;
      if (wait === undefined || performance.now() + wait >= deadlineAt) {
        return failure(outcome, limit, attempts, idempotencyKey);
      }
      await sleep(wait);
    }
  }
}

/** How long to wait before the next attempt, or undefined when the outcome is not retried. */
function waitBeforeRetry(outcome: AttemptOutcome, failedAttempts: number): number | undefined {
  if (outcome.kind === "timeout" || outcome.kind === "connection") {
    return backoff(failedAttempts);
  }
  if (outcome.kind !== "response") {
    return undefined;
  }
  switch (outcome.status) {
    case 502:
    case 503:
    case 504:
      return backoff(failedAttempts);
    case 429:
      // A request rejected with 429 did not use its key.
      return rateLimitWait(outcome.retryAfter, Date.now());
    case 409:
      // I-002: a request with this key is still running, or failed less than a minute ago.
      // Once a running request succeeds, a retry gets its decision.
      // I-001: the key is spent, and only a new key works.
      return outcome.errorCode === "I-002" ? inProgressWait() : undefined;
    default:
      return undefined;
  }
}

/** A call adds one to the breaker when LexQ could not be reached or answered with a 5xx. */
function countsAgainstBreaker(error: LexqError): boolean {
  return error.reason !== "response" || (error.status !== undefined && error.status >= 500);
}

function deadline(timeoutMs: number, attempts: readonly Attempt[], idempotencyKey: string): LexqError {
  return new LexqError(`LexQ did not answer within the ${timeoutMs} ms deadline`, {
    reason: "deadline",
    attempts,
    idempotencyKey,
  });
}

function failure(
  outcome: AttemptOutcome,
  limit: number,
  attempts: readonly Attempt[],
  idempotencyKey: string,
): LexqError {
  switch (outcome.kind) {
    case "timeout":
      return new LexqError(`LexQ did not answer within the ${Math.round(limit)} ms attempt timeout`, {
        reason: "timeout",
        attempts,
        idempotencyKey,
      });
    case "connection":
      return new LexqError(connectionMessage(outcome.cause), {
        reason: "connection",
        attempts,
        idempotencyKey,
        cause: outcome.cause,
      });
    case "response":
      return new LexqError(outcome.message, {
        reason: "response",
        status: outcome.status,
        errorCode: outcome.errorCode,
        attempts,
        idempotencyKey,
      });
    case "decision":
      throw new Error("a decision is not a failure");
  }
}

function connectionMessage(cause: unknown): string {
  const code = (cause as { cause?: { code?: unknown } } | undefined)?.cause?.code;
  return typeof code === "string" ? `Could not reach LexQ: ${code}` : "Could not reach LexQ";
}

function toDecision(data: Readonly<Record<string, unknown>>, idempotencyKey: string): DecisionResult | undefined {
  const { traceId } = data;
  const inputFacts = layer(data.inputFacts);
  const mutatedFacts = layer(data.mutatedFacts);
  const generatedVariables = layer(data.generatedVariables);
  if (typeof traceId !== "string" || traceId === "" || !inputFacts || !mutatedFacts || !generatedVariables) {
    return undefined;
  }
  const facts: Facts = { ...inputFacts, ...mutatedFacts, ...generatedVariables };
  return {
    source: "lexq",
    traceId,
    // BLOCK sets isBlocked in generatedVariables, or in mutatedFacts when the request sent it.
    isBlocked: facts.isBlocked === true,
    facts,
    inputFacts,
    mutatedFacts,
    generatedVariables,
    idempotencyKey,
  };
}

/** A fact layer, or undefined when it is not an object. A missing layer is empty. */
function layer(value: unknown): Facts | undefined {
  if (value === undefined || value === null) {
    return {};
  }
  return isRecord(value) ? (value as Facts) : undefined;
}

async function settle<T>(fallback: ExecuteOptions<T>["fallback"], error: LexqError | TypeError): Promise<FallbackResult<T>> {
  // The deadline covers the attempts to reach LexQ, not the fallback.
  return { source: "fallback", value: await fallback(error), error };
}

function endpoint(baseUrl: unknown): string {
  if (typeof baseUrl !== "string") {
    throw new TypeError("baseUrl must be a string");
  }
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new TypeError("baseUrl must be an absolute URL, such as https://api.lexq.io");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) {
    throw new TypeError("baseUrl must use https. Plain http is accepted only for localhost, 127.0.0.1, and [::1]");
  }
  if (url.username !== "" || url.password !== "") {
    throw new TypeError("baseUrl must not carry credentials. Pass the API key as apiKey");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new TypeError("baseUrl must not have a query or a fragment");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}/api/v1/execution/groups/`;
}

function breaker(option: ClientOptions["breaker"]): CircuitBreaker | undefined {
  if (option === false) {
    return undefined;
  }
  if (option === undefined) {
    return new CircuitBreaker(DEFAULT_THRESHOLD, DEFAULT_COOLDOWN_MS);
  }
  if (typeof option !== "object" || option === null) {
    throw new TypeError("breaker must be false, or an object with threshold and cooldownMs");
  }
  const { threshold } = option;
  if (threshold !== undefined && (!Number.isSafeInteger(threshold) || threshold < 1)) {
    throw new TypeError("breaker.threshold must be a whole number of calls, 1 or more");
  }
  return new CircuitBreaker(
    threshold ?? DEFAULT_THRESHOLD,
    milliseconds("breaker.cooldownMs", option.cooldownMs) ?? DEFAULT_COOLDOWN_MS,
  );
}

function milliseconds(name: string, value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > MAX_TIMER_MS) {
    throw new TypeError(`${name} must be a number of milliseconds above 0 and at most ${MAX_TIMER_MS}`);
  }
  return value;
}

function flag(name: string, value: unknown): boolean | undefined {
  if (value === undefined || typeof value === "boolean") {
    return value;
  }
  throw new TypeError(`${name} must be true or false`);
}

function isPlainObject(value: unknown): value is object {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
