import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { spec } from "./support/spec.ts";

// The defaults come from spec/values.json, through src/contract.ts. The option documentation
// in src/types.ts, which ships in the type definitions, and the README state them too, and
// this test keeps them equal to spec/values.json.

const { attemptTimeoutMs, baseUrl, breakerCooldownMs, breakerThreshold, deadlineMs } = spec.defaults;

function read(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("the option documentation states the defaults in spec/values.json", async () => {
  const types = await read("src/types.ts");
  for (const sentence of [
    `Defaults to \`${baseUrl}\`.`,
    `Defaults to ${deadlineMs}.`,
    `Defaults to ${attemptTimeoutMs},`,
    `(${breakerThreshold} by default)`,
    `(${breakerCooldownMs} by default)`,
  ]) {
    assert.ok(types.includes(sentence), `src/types.ts does not say "${sentence}"`);
  }
});

test("the README states the defaults in spec/values.json", async () => {
  const readme = (await read("README.md")).replace(/\s+/g, " ");
  for (const sentence of [
    `By default a call has a ${deadlineMs / 1000}-second deadline and ${attemptTimeoutMs / 1000} seconds per attempt.`,
    `The circuit breaker opens for ${breakerCooldownMs / 1000} seconds after ${breakerThreshold} calls in a row end ` +
      "with a timeout, a failed connection, or a 5xx that does not carry `P-003`.",
  ]) {
    assert.ok(readme.includes(sentence), `README.md does not say "${sentence}"`);
  }
});
