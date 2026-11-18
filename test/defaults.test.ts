import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { DEFAULT_COOLDOWN_MS, DEFAULT_THRESHOLD } from "../src/breaker.ts";
import { DEFAULT_ATTEMPT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS } from "../src/client.ts";

// The defaults are set in code. The option documentation in src/types.ts, which ships in
// the type definitions, and the README state them too, and this test keeps them equal.

function read(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("the option documentation states the defaults in code", async () => {
  const types = await read("src/types.ts");
  for (const sentence of [
    `Defaults to ${DEFAULT_TIMEOUT_MS}.`,
    `Defaults to ${DEFAULT_ATTEMPT_TIMEOUT_MS},`,
    `(${DEFAULT_THRESHOLD} by default)`,
    `(${DEFAULT_COOLDOWN_MS} by default)`,
  ]) {
    assert.ok(types.includes(sentence), `src/types.ts does not say "${sentence}"`);
  }
});

test("the README states the defaults in code", async () => {
  const readme = (await read("README.md")).replace(/\s+/g, " ");
  const sentence =
    `By default a call has a ${DEFAULT_TIMEOUT_MS / 1000}-second deadline and ${DEFAULT_ATTEMPT_TIMEOUT_MS / 1000} seconds ` +
    `per attempt, and the circuit breaker opens for ${DEFAULT_COOLDOWN_MS / 1000} seconds after ${DEFAULT_THRESHOLD} failed calls in a row.`;
  assert.ok(readme.includes(sentence), `README.md does not say "${sentence}"`);
});
