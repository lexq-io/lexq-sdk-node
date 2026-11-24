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

/**
 * Facts to send, by key. `contexts` has the same type. A key whose value is `null` is sent
 * as `null`, and a condition on it does not match, even in a rule that blocks. A key whose
 * value is `undefined` is left out. If an enabled rule reads a fact that is left out, LexQ
 * answers `P-015`.
 */
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
   * The circuit breaker, on by default. A call counts toward the breaker when it runs out of
   * time, cannot connect, or gets a 5xx that does not carry `P-003`, and any other answer
   * resets the count. `P-003` means an action of a matched rule failed, not that LexQ is
   * down. After `threshold` counted calls in a row (5 by default), calls go straight to the
   * fallback for `cooldownMs` (10000 by default), and then one trial call goes through.
   * `false` turns the breaker off.
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
   * discount, a transfer should wait. The error's `reason` says why the call failed. If the
   * fallback throws, the call rejects with that error.
   */
  readonly fallback: (error: LexqError) => T | PromiseLike<T>;
  /** This call's deadline, in milliseconds, in place of the client's. */
  readonly timeoutMs?: number | undefined;
  /** `false` turns retries off for this call, and `true` turns them on. */
  readonly retry?: boolean | undefined;
}

/**
 * LexQ's decision: every field in LexQ's `data`, and `source`. The client merges nothing, so
 * the facts come back in the three layers LexQ sends. A layer, the contexts, or a trace list
 * that LexQ leaves out or sends as `null` is empty. A field LexQ adds after this release is
 * there as well, before this type names it.
 *
 * A `BLOCK` action does not fail the call. It writes `isBlocked: true` and `blockReason`. A
 * key the request did not send comes back in `generatedVariables`, a key it sent with
 * another value in `mutatedFacts`, and a key it sent with the same value only in
 * `inputFacts`. So check `isBlocked` in all three layers, and send an earlier block under
 * another key, such as `previouslyBlocked`.
 */
export interface DecisionResult {
  readonly source: "lexq";
  /** The execution's audit handle. Store it with the record the decision applies to. */
  readonly traceId: string;
  /**
   * When LexQ ran the decision, as LexQ wrote it, for example `2026-04-27T09:44:10.512384Z`.
   * It keeps the microseconds a `Date` would drop. A repeat that LexQ answered from the
   * idempotency key has the first call's `traceId` and `executedAt`.
   */
  readonly executedAt: string;
  /** How long LexQ took to run the decision, in milliseconds. */
  readonly totalProcessingTimeMs: number;
  /** The facts as LexQ received them. */
  readonly inputFacts: Facts;
  /** The `contexts` the request sent, or `{}` when it sent none. */
  readonly inputContexts: Facts;
  /** The new value of each fact the request sent that a rule changed. */
  readonly mutatedFacts: Facts;
  /**
   * Keys the request did not send, such as a `SET_FACT` target. A rule that changes
   * `paymentAmount` with `MUTATE_FACT` adds `paymentAmount__delta`: how much it changed, not
   * the new value, which is in `mutatedFacts`. Leave the `__delta` keys out when you send a
   * decision's facts again.
   */
  readonly generatedVariables: Facts;
  /**
   * Each rule LexQ evaluated, in the order it decided: by group priority, then by rule
   * priority. The entry at an index describes the same rule as `decisionTraces` at that index.
   */
  readonly executionTraces: readonly ExecutionTrace[];
  /** Why each rule LexQ evaluated fired or did not, in the same order as `executionTraces`. */
  readonly decisionTraces: readonly DecisionTrace[];
}

/** How LexQ evaluated one rule. */
export interface ExecutionTrace {
  readonly policyGroupId: string;
  readonly policyVersionId: string;
  readonly ruleId: string;
  readonly ruleName: string;
  /** Whether the rule's condition matched the facts. */
  readonly matched: boolean;
  /** The rule's condition as text, for example `paymentAmount >= 100000`. */
  readonly matchExpression: string;
  /**
   * The actions the rule defines, whether or not they ran. They ran when the rule's entry in
   * `decisionTraces` has the status `SELECTED`.
   */
  readonly generatedActions: readonly RuleAction[];
}

/** An action a rule defines. */
export interface RuleAction {
  /** For example `MUTATE_FACT`, `SET_FACT`, or `BLOCK`. */
  readonly type: string;
  /** The action's settings, such as `targetVar` and `operand`. */
  readonly parameters: Facts;
}

/**
 * Why one rule LexQ evaluated fired or did not.
 * [Decision Trace](https://docs.lexq.io/guides/policy-rules#decision-trace) lists every status
 * and reason code.
 */
export interface DecisionTrace {
  readonly ruleId: string;
  readonly ruleName: string;
  readonly policyGroupId: string;
  readonly policyVersionId: string;
  /** For example `SELECTED` when the rule fired and its actions ran, or `NO_MATCH`. */
  readonly status: string;
  /** For example `FINAL_WINNER` or `CONDITION_MISMATCH`. */
  readonly reasonCode: string;
  /**
   * More about the reason, such as the rule that won when this one lost a competition, or
   * why a condition could not be evaluated. Often `null`.
   */
  readonly reasonDetail: string | null;
}

/** The fallback's value, and why it was needed. */
export interface FallbackResult<T> {
  readonly source: "fallback";
  readonly value: T;
  /** Why the call could not get LexQ's decision. */
  readonly error: LexqError;
}

/** Either LexQ's decision or the fallback's value. `source` says which. */
export type ExecuteResult<T> = DecisionResult | FallbackResult<T>;
