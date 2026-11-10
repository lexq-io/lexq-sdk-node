import type { Decimal } from "./decimal.ts";
import type { LexqError } from "./errors.ts";

/** A fact value in a decision. Every number is a {@link Decimal}. */
export type FactValue = string | boolean | null | Decimal | readonly FactValue[] | { readonly [key: string]: FactValue };

/** Facts in a decision, by key. */
export type Facts = { readonly [key: string]: FactValue };

/**
 * A fact value to send. A number goes out as JavaScript writes it, a bigint and a
 * {@link Decimal} with every digit. A string stays a string, and a fact whose type is
 * NUMBER rejects `"150000"` with `P-060`.
 */
export type InputFactValue =
  | string
  | number
  | bigint
  | boolean
  | null
  | Decimal
  | readonly InputFactValue[]
  | { readonly [key: string]: InputFactValue | undefined };

/** Facts to send, by key. A fact whose value is null or undefined is left out of the request. */
export type InputFacts = { readonly [key: string]: InputFactValue | undefined };

/** Settings for a {@link LexqClient}. Only `apiKey` is required. */
export interface ClientOptions {
  /**
   * A LexQ API key, sent in the `x-api-key` header. Any scope can execute, including the
   * default Execute only. Keep it on the server: the client refuses to run in a browser.
   */
  readonly apiKey: string;
  /**
   * Where LexQ is. Defaults to `https://api.lexq.io`. Plain `http` is accepted only for
   * `localhost`, `127.0.0.1`, and `[::1]`.
   */
  readonly baseUrl?: string | undefined;
  /**
   * The deadline for each call, in milliseconds. It covers every attempt and every wait
   * between attempts, but not the fallback. Defaults to 15000. A call can set its own, and
   * neither can turn it off.
   */
  readonly timeoutMs?: number | undefined;
  /**
   * How long one attempt may take, in milliseconds, cut to the time left before the
   * deadline. Defaults to 10000, so an attempt that hangs leaves time for another. With
   * retries off, the single attempt has the whole deadline.
   */
  readonly attemptTimeoutMs?: number | undefined;
  /** `false` turns retries off for every call. A call can still set its own. Defaults to `true`. */
  readonly retry?: boolean | undefined;
  /**
   * The circuit breaker, on by default. A call fails when it runs out of time, cannot
   * connect, or gets a 5xx. After `threshold` failed calls in a row (5 by default), calls
   * go straight to the fallback for `cooldownMs` (10000 by default), and then one trial
   * call goes through. `false` turns the breaker off.
   */
  readonly breaker?: false | { readonly threshold?: number | undefined; readonly cooldownMs?: number | undefined } | undefined;
}

/** A call to one policy group. `facts` and `fallback` are required. */
export interface ExecuteOptions<T> {
  /** The facts the rules read, such as an order's amount and the customer's tier. */
  readonly facts: InputFacts;
  /**
   * Request metadata, recorded with the execution. Put the A/B routing key here as
   * `trafficKey`: LexQ reads `contexts.trafficKey`, and a `trafficKey` in `facts` is ignored,
   * so the test version receives no traffic. Values your rules read belong in `facts`.
   * Keep personal data out of it.
   */
  readonly contexts?: InputFacts | undefined;
  /**
   * The `Idempotency-Key` for this call, sent unchanged on every attempt. Without one, the
   * client generates a UUID for the call. LexQ accepts up to 255 characters and stores the
   * key with the execution, so hash a long ID, and keep personal data out of it.
   */
  readonly idempotencyKey?: string | undefined;
  /**
   * The value your service uses when the call cannot get LexQ's decision, for whatever
   * reason. Only your service knows which side is safe: a checkout can go ahead without a
   * discount, a transfer should wait. If it throws, the call rejects with that error.
   */
  readonly fallback: (error: LexqError | TypeError) => T | PromiseLike<T>;
  /** This call's deadline, in milliseconds, in place of the client's. */
  readonly timeoutMs?: number | undefined;
  /** `false` turns retries off for this call, and `true` turns them on. */
  readonly retry?: boolean | undefined;
}

/** LexQ's decision. */
export interface DecisionResult {
  readonly source: "lexq";
  /** The execution's audit handle. Store it with the record the decision applies to. */
  readonly traceId: string;
  /** `true` when a `BLOCK` action ran: the final facts have `isBlocked: true`. */
  readonly isBlocked: boolean;
  /** The final facts: `{ ...inputFacts, ...mutatedFacts, ...generatedVariables }`. */
  readonly facts: Facts;
  /** The facts as LexQ received them. */
  readonly inputFacts: Facts;
  /** The facts a rule changed. */
  readonly mutatedFacts: Facts;
  /** Values the request did not send, such as a `SET_FACT` target or `isBlocked`. */
  readonly generatedVariables: Facts;
  /** The `Idempotency-Key` the call used. */
  readonly idempotencyKey: string;
}

/** The fallback's value, and why it was needed. */
export interface FallbackResult<T> {
  readonly source: "fallback";
  readonly value: T;
  /** A `LexqError`, or a `TypeError` when a fact or the idempotency key could not be sent. */
  readonly error: LexqError | TypeError;
}

/** Either LexQ's decision or the fallback's value. `source` says which. */
export type ExecuteResult<T> = DecisionResult | FallbackResult<T>;
