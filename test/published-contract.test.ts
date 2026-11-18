// contracts/lexq-manifest.sdk.json holds the LexQ limits and error codes this client relies
// on. src/contract.ts is generated from it, and the documentation states the same values.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { MAX_DEPTH } from "../src/json.ts";

const ROOT = new URL("../", import.meta.url);

interface Subset {
  readonly constants: { readonly MAX_REQUEST_NESTING_DEPTH: number; readonly IDEMPOTENCY_KEY_MAX_LENGTH: number };
  readonly errorCodes: readonly { readonly code: string; readonly httpStatus: number }[];
}

function read(path: string): Promise<string> {
  return readFile(new URL(path, ROOT), "utf8");
}

async function readSubset(): Promise<Subset> {
  return JSON.parse(await read("contracts/lexq-manifest.sdk.json")) as Subset;
}

/** The text with line breaks and the leading `*` of doc comment lines folded into single spaces. */
async function readProse(path: string): Promise<string> {
  return (await read(path)).replace(/\s+/g, " ").replace(/ \* /g, " ");
}

test("src/contract.ts is what scripts/gen-contract.mjs writes from the published subset", () => {
  execFileSync(process.execPath, [fileURLToPath(new URL("scripts/gen-contract.mjs", ROOT)), "--check"], { stdio: "pipe" });
});

test("the client lets a body nest as deep as the published limit, and no deeper", async () => {
  assert.equal(MAX_DEPTH, (await readSubset()).constants.MAX_REQUEST_NESTING_DEPTH);
});

test("the documentation states the idempotency key limit in the published subset", async () => {
  const sentence = `accepts up to ${(await readSubset()).constants.IDEMPOTENCY_KEY_MAX_LENGTH} characters`;
  for (const path of ["src/types.ts", "CONTRACT.md"]) {
    assert.ok((await readProse(path)).includes(sentence), `${path} does not say "${sentence}"`);
  }
});

test("the retry table names each published error code with its status", async () => {
  const contract = await readProse("CONTRACT.md");
  for (const { code, httpStatus } of (await readSubset()).errorCodes) {
    const row = `\`${httpStatus}\` with \`${code}\``;
    assert.ok(contract.includes(row), `CONTRACT.md does not say "${row}"`);
  }
});
