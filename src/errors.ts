/**
 * Why a call ended with the fallback.
 *
 * - `breaker_open`: the circuit breaker is open, so nothing was sent.
 * - `deadline`: the call's deadline ran out before LexQ answered.
 * - `timeout`: the last attempt got no answer within its own timeout, and no retry followed.
 * - `connection`: the last attempt could not connect, or the connection broke.
 * - `response`: an answer came back that is not a decision. `status` holds the HTTP
 *   status, and `errorCode` holds LexQ's code when the body carried one.
 */
export type LexqErrorReason = "breaker_open" | "deadline" | "timeout" | "connection" | "response";

/** One attempt that did not return a decision. */
export interface Attempt {
  /** Whether the attempt got no answer in time, could not connect, or got an answer that is not a decision. */
  readonly outcome: "timeout" | "connection" | "response";
  /** The HTTP status, when an answer came back. */
  readonly status: number | undefined;
  /** LexQ's `errorCode`, when the answer carried one. */
  readonly errorCode: string | undefined;
  /** How long the attempt took, in milliseconds. */
  readonly durationMs: number;
}

/**
 * What the fallback receives when a call could not get LexQ's decision.
 *
 * It never carries the API key, the facts, or a response body. Keep `idempotencyKey`
 * to repeat the call: if LexQ finished the decision and it succeeded, a repeat with that
 * key within 24 hours returns it instead of running it again. What a repeat gets
 * otherwise: https://docs.lexq.io/api/execution#retrying-a-failed-call
 */
export class LexqError extends Error {
  override readonly name = "LexqError";
  readonly reason: LexqErrorReason;
  /** The HTTP status of the answer that ended the call, when `reason` is `response`. */
  readonly status: number | undefined;
  /** LexQ's `errorCode`, for example `P-015` or `I-001`, when the answer carried one. Branch on this, not on the message. */
  readonly errorCode: string | undefined;
  /** Every attempt, in order. Empty when nothing was sent. */
  readonly attempts: readonly Attempt[];
  /** The `Idempotency-Key` the call used, whether you passed it or the client generated it. */
  readonly idempotencyKey: string;

  constructor(
    message: string,
    fields: {
      readonly reason: LexqErrorReason;
      readonly status?: number | undefined;
      readonly errorCode?: string | undefined;
      readonly attempts: readonly Attempt[];
      readonly idempotencyKey: string;
      readonly cause?: unknown;
    },
  ) {
    super(message, fields.cause === undefined ? undefined : { cause: fields.cause });
    this.reason = fields.reason;
    this.status = fields.status;
    this.errorCode = fields.errorCode;
    this.attempts = Object.freeze([...fields.attempts]);
    this.idempotencyKey = fields.idempotencyKey;
  }
}
