// spec/values.json holds the values of the specification version this package follows.
// scripts/gen-contract.mjs writes src/contract.ts from it, and the documentation states the
// same values.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { MAX_DEPTH } from "../src/json.ts";
import { constant, spec } from "./support/spec.ts";

const ROOT = new URL("../", import.meta.url);

/** The text with line breaks and the leading `*` of doc comment lines folded into single spaces. */
async function readProse(path: string): Promise<string> {
  return (await readFile(new URL(path, ROOT), "utf8")).replace(/\s+/g, " ").replace(/ \* /g, " ");
}

test("src/contract.ts is what scripts/gen-contract.mjs writes from spec/values.json", () => {
  execFileSync(process.execPath, [fileURLToPath(new URL("scripts/gen-contract.mjs", ROOT)), "--check"], { stdio: "pipe" });
});

test("the client lets a body nest as deep as LexQ's limit, and no deeper", () => {
  assert.equal(MAX_DEPTH, constant("MAX_REQUEST_NESTING_DEPTH"));
});

test("the documentation states the idempotency key limit in spec/values.json", async () => {
  const sentence = `accepts up to ${constant("IDEMPOTENCY_KEY_MAX_LENGTH")} characters`;
  assert.ok((await readProse("src/types.ts")).includes(sentence), `src/types.ts does not say "${sentence}"`);
});

test("the documentation states how long a repeat gets the same decision, as spec/values.json says", async () => {
  const sentence = `within ${constant("REPLAY_RETENTION_HOURS")} hours`;
  for (const path of ["README.md", "src/errors.ts"]) {
    assert.ok((await readProse(path)).includes(sentence), `${path} does not say "${sentence}"`);
  }
});

// A status written beside a code, as in `400` (`P-068`), `400 C-012`, or `409` with `I-001`.
const STATUS_AND_CODE = /`(\d{3})` \(`([A-Z]{1,4}-\d{3})`\)|`(\d{3}) ([A-Z]{1,4}-\d{3})`|`(\d{3})` with `([A-Z]{1,4}-\d{3})`/g;

test("the documentation gives each code in spec/values.json the status spec/values.json gives it", async () => {
  const statuses = new Map(spec.errorCodes.map(({ code, httpStatus }) => [code, httpStatus]));
  const sources = (await readdir(new URL("src/", ROOT))).filter((name) => name.endsWith(".ts"));
  let checked = 0;
  for (const path of ["README.md", "CONTRACT.md", ...sources.map((name) => `src/${name}`)]) {
    for (const match of (await readProse(path)).matchAll(STATUS_AND_CODE)) {
      const status = Number(match[1] ?? match[3] ?? match[5]);
      const code = match[2] ?? match[4] ?? match[6] ?? "";
      const expected = statuses.get(code);
      if (expected === undefined) {
        continue;
      }
      assert.equal(status, expected, `${path} gives ${code} the status ${status}, and spec/values.json gives it ${expected}`);
      checked += 1;
    }
  }
  assert.ok(checked > 0, "the documentation gives no code from spec/values.json a status");
});

// The client branches on some of LexQ's error codes. Each code that src/ writes in double
// quotes, as in `case "I-002":` in src/client.ts, must be one that spec/values.json gives a
// status to, so this test fails when a new version of the specification no longer lists one.
test("spec/values.json gives a status to every error code src/ writes in double quotes", async () => {
  const statuses = new Map(spec.errorCodes.map(({ code, httpStatus }) => [code, httpStatus]));
  const sources = (await readdir(new URL("src/", ROOT))).filter((name) => name.endsWith(".ts"));
  let checked = 0;
  for (const name of sources) {
    for (const match of (await readFile(new URL(`src/${name}`, ROOT), "utf8")).matchAll(/"([A-Z]{1,4}-\d{3})"/g)) {
      const code = match[1] ?? "";
      assert.ok(Number.isInteger(statuses.get(code)), `src/${name} names ${code}, and spec/values.json gives it no status`);
      checked += 1;
    }
  }
  assert.ok(checked > 0, "src/ writes no error code in double quotes");
});
