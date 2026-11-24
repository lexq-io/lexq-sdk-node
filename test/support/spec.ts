// The values of the LexQ SDK specification version this package follows, read from the copy
// in spec/values.json. Tests take their expected values from here rather than from the
// client's own constants.
import { readFileSync } from "node:fs";

export interface Range {
  readonly minMs: number;
  readonly maxMs: number;
}

export interface SpecValues {
  readonly constants: Readonly<Record<string, number>>;
  readonly errorCodes: readonly { readonly code: string; readonly httpStatus: number }[];
  readonly defaults: {
    readonly baseUrl: string;
    readonly deadlineMs: number;
    readonly attemptTimeoutMs: number;
    readonly maxAttempts: number;
    readonly backoff: readonly Range[];
    readonly rateLimitWait: Range;
    readonly keyInUseWait: Range;
    readonly breakerThreshold: number;
    readonly breakerCooldownMs: number;
    readonly maxResponseBytes: number;
    readonly maxMessageLength: number;
    readonly maxKeyPathLength: number;
    readonly maxErrorCodeLength: number;
  };
}

export const spec = JSON.parse(readFileSync(new URL("../../spec/values.json", import.meta.url), "utf8")) as SpecValues;

/** A LexQ constant from spec/values.json, by the name LexQ gives it. */
export function constant(name: string): number {
  const value = spec.constants[name];
  if (value === undefined) {
    throw new Error(`spec/values.json has no constant ${name}`);
  }
  return value;
}
