/** How many failed calls in a row open the breaker. */
export const DEFAULT_THRESHOLD = 5;

/** How long the breaker stays open before one trial call goes through, in milliseconds. */
export const DEFAULT_COOLDOWN_MS = 10_000;

/** What a call holds while it runs: an ordinary pass, or the one trial after a cool-down. */
export type Permit = "closed" | "trial";

/**
 * Counts calls, not attempts. One client owns one breaker.
 *
 * A call whose deadline ran out, or whose last attempt timed out, failed to connect, or
 * got a 5xx, adds one. Any other call that got an answer resets the count. A call that
 * sent nothing never reaches the breaker.
 */
export class CircuitBreaker {
  readonly #threshold: number;
  readonly #cooldownMs: number;
  #failures = 0;
  #openedAt: number | undefined;
  #trialRunning = false;

  constructor(threshold: number, cooldownMs: number) {
    this.#threshold = threshold;
    this.#cooldownMs = cooldownMs;
  }

  /** Returns how the call may go out, or undefined when it must go straight to the fallback. */
  admit(now: number): Permit | undefined {
    if (this.#openedAt === undefined) {
      return "closed";
    }
    if (this.#trialRunning || now - this.#openedAt < this.#cooldownMs) {
      return undefined;
    }
    this.#trialRunning = true;
    return "trial";
  }

  /** Records how an admitted call ended. */
  record(permit: Permit, failed: boolean, now: number): void {
    if (failed) {
      this.#failures += 1;
      if (permit === "trial" || (this.#openedAt === undefined && this.#failures >= this.#threshold)) {
        this.#openedAt = now;
      }
    } else {
      this.#failures = 0;
      if (permit === "trial") {
        this.#openedAt = undefined;
      }
    }
    if (permit === "trial") {
      this.#trialRunning = false;
    }
  }

  /** Releases a trial whose call threw instead of ending, so the next call can be the trial. */
  release(permit: Permit): void {
    if (permit === "trial") {
      this.#trialRunning = false;
    }
  }
}
