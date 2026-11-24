import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { isRecord, sendAttempt, type AttemptOutcome, type PreparedRequest } from "./attempt.ts";
import { CircuitBreaker } from "./breaker.ts";
import { ATTEMPT_TIMEOUT_MS, BASE_URL, BREAKER_COOLDOWN_MS, BREAKER_THRESHOLD, DEADLINE_MS, MAX_ATTEMPTS } from "./contract.ts";
import { Decimal } from "./decimal.ts";
import { LexqError, type Attempt } from "./errors.ts";
import { encodeBody } from "./json.ts";
import { backoff, keyInUseWait, rateLimitWait } from "./retry.ts";
import type {
  ClientOptions,
  DecisionResult,
  DecisionTrace,
  ExecuteOptions,
  ExecuteResult,
  ExecutionTrace,
  Facts,
  FallbackResult,
} from "./types.ts";

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
    this.#endpoint = endpoint(options.baseUrl ?? BASE_URL);
    this.#timeoutMs = milliseconds("timeoutMs", options.timeoutMs) ?? DEADLINE_MS;
    this.#attemptTimeoutMs = milliseconds("attemptTimeoutMs", options.attemptTimeoutMs) ?? ATTEMPT_TIMEOUT_MS;
    this.#retry = flag("retry", options.retry) ?? true;
    this.#breaker = breaker(options.breaker);
  }

  /**
   * Runs the deployed version of a policy group against the facts, with
   * `POST /api/v1/execution/groups/{groupId}`.
   *
   * Resolves with LexQ's decision, or with the fallback's value and the reason it was
   * needed. It rejects in three cases: the fallback throws; the fallback is missing or an
   * argument or option has the wrong type or range, which it reports before sending
   * anything; or a getter, a `toJSON` method, or a proxy in the facts or contexts throws
   * something other than a `TypeError`.
   */
  async execute<T>(groupId: string, options: ExecuteOptions<T>): Promise<ExecuteResult<T>> {
    if (typeof groupId !== "string" || groupId === "") {
      throw new TypeError("groupId must be a non-empty string");
    }
    if (groupId === "." || groupId === "..") {
      throw new TypeError(`groupId cannot be "${groupId}": in a URL it moves the request to another path`);
    }
    if (!groupId.isWellFormed()) {
      throw new TypeError("groupId holds an unpaired surrogate, which a URL cannot carry");
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
    if (!HEADER_SAFE.test(idempotencyKey)) {
      const problem = new TypeError(
        idempotencyKey === ""
          ? "idempotencyKey is empty"
          : "idempotencyKey must be printable ASCII with no space at either end, so a header carries it unchanged. Hash an ID that is not ASCII first",
      );
      // The error leaves the key out: a key that cannot go in a header can also break a log line.
      return settle(fallback, invalidInput(problem, undefined));
    }
    let body: Uint8Array;
    try {
      body = encoder.encode(encodeBody(options.facts, options.contexts));
    } catch (error) {
      if (error instanceof TypeError) {
        return settle(fallback, invalidInput(error, idempotencyKey));
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
        const decision = toDecision(outcome.data);
        if (typeof decision !== "string") {
          return decision;
        }
        outcome = {
          kind: "response",
          status: outcome.status,
          errorCode: undefined,
          message: `LexQ answered ${outcome.status} with result SUCCESS but a decision ${decision}`,
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

/**
 * How long to wait before the next attempt, or undefined when the outcome is not retried.
 * A code decides before the status does, because LexQ may move a code to another status.
 */
function waitBeforeRetry(outcome: AttemptOutcome, failedAttempts: number): number | undefined {
  if (outcome.kind === "timeout" || outcome.kind === "connection") {
    return backoff(failedAttempts);
  }
  if (outcome.kind !== "response") {
    return undefined;
  }
  switch (outcome.errorCode) {
    case "I-002":
      // Another request with this key started less than a minute ago, and it is still running
      // or failed without freeing the key. Once a running request succeeds, a retry gets its
      // decision.
      return keyInUseWait();
    case "I-001":
      // LexQ holds a successful decision for this key, made for a different request.
    case "B-008":
      // The monthly execution quota cannot cover the call.
    case "P-003":
      // An action of a matched rule failed, and running the request again fails the same way.
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
    default:
      return undefined;
  }
}

/**
 * A call adds one to the breaker when LexQ could not be reached or answered with a 5xx. A 5xx
 * that carries `P-003` does not add one: LexQ answered, and one rule's action failed.
 */
function countsAgainstBreaker(error: LexqError): boolean {
  if (error.reason !== "response") {
    return true;
  }
  return error.status !== undefined && error.status >= 500 && error.errorCode !== "P-003";
}

/**
 * A request the client would not send. The TypeError that stopped it says what to change, so
 * it is the error's cause and its message.
 */
function invalidInput(cause: TypeError, idempotencyKey: string | undefined): LexqError {
  return new LexqError(cause.message, { reason: "invalid_input", attempts: [], idempotencyKey, cause });
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

/**
 * LexQ's decision with every field LexQ returned, or what is wrong with it. The trace entries
 * are passed on as LexQ wrote them: the client computes nothing from them, so it checks only
 * that each list holds objects.
 */
function toDecision(data: Readonly<Record<string, unknown>>): DecisionResult | string {
  const { traceId, executedAt, totalProcessingTimeMs } = data;
  if (typeof traceId !== "string" || traceId === "") {
    return "without a traceId";
  }
  if (typeof executedAt !== "string" || executedAt === "") {
    return "without executedAt";
  }
  if (!(totalProcessingTimeMs instanceof Decimal)) {
    return "whose totalProcessingTimeMs is not a number";
  }
  const inputFacts = layer(data.inputFacts);
  if (!inputFacts) {
    return "whose inputFacts is not an object";
  }
  const inputContexts = layer(data.inputContexts);
  if (!inputContexts) {
    return "whose inputContexts is not an object";
  }
  const mutatedFacts = layer(data.mutatedFacts);
  if (!mutatedFacts) {
    return "whose mutatedFacts is not an object";
  }
  const generatedVariables = layer(data.generatedVariables);
  if (!generatedVariables) {
    return "whose generatedVariables is not an object";
  }
  const executionTraces = traces<ExecutionTrace>(data.executionTraces);
  if (!executionTraces) {
    return "whose executionTraces is not a list of objects";
  }
  const decisionTraces = traces<DecisionTrace>(data.decisionTraces);
  if (!decisionTraces) {
    return "whose decisionTraces is not a list of objects";
  }
  return {
    // Every field LexQ sent, so one it adds later reaches the caller before the types name
    // it. The client merges nothing, and `source` is the only field of its own. The fields
    // below come after it, so `source` and the checked values win over a field of the same
    // name in `data`. A layer or a list that LexQ left out is empty.
    ...data,
    source: "lexq",
    traceId,
    executedAt,
    totalProcessingTimeMs: totalProcessingTimeMs.toNumber(),
    inputFacts,
    inputContexts,
    mutatedFacts,
    generatedVariables,
    executionTraces,
    decisionTraces,
  };
}

/** A fact layer or the contexts, or undefined when it is not an object. A missing one is empty. */
function layer(value: unknown): Facts | undefined {
  if (value === undefined || value === null) {
    return {};
  }
  return isRecord(value) ? (value as Facts) : undefined;
}

/** A trace list, or undefined when it is not a list of objects. A missing list is empty. */
function traces<T>(value: unknown): readonly T[] | undefined {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) && value.every(isRecord) ? (value as readonly T[]) : undefined;
}

async function settle<T>(fallback: ExecuteOptions<T>["fallback"], error: LexqError): Promise<FallbackResult<T>> {
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
    return new CircuitBreaker(BREAKER_THRESHOLD, BREAKER_COOLDOWN_MS);
  }
  if (typeof option !== "object" || option === null) {
    throw new TypeError("breaker must be false, or an object with threshold and cooldownMs");
  }
  const { threshold } = option;
  if (threshold !== undefined && (!Number.isSafeInteger(threshold) || threshold < 1)) {
    throw new TypeError("breaker.threshold must be a whole number of calls, 1 or more");
  }
  return new CircuitBreaker(
    threshold ?? BREAKER_THRESHOLD,
    milliseconds("breaker.cooldownMs", option.cooldownMs) ?? BREAKER_COOLDOWN_MS,
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
