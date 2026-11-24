#!/usr/bin/env node
/**
 * Writes src/contract.ts and contracts/lexq-manifest.sdk.json from spec/values.json, the
 * values of the LexQ SDK specification version that spec/spec.lock pins.
 *
 * src/contract.ts holds the LexQ constants that CONSTANTS lists and every default in
 * DEFAULTS. contracts/lexq-manifest.sdk.json holds the subset that CONSTANTS and
 * ERROR_CODES list, until a later change removes it.
 *
 * A name below that spec/values.json lacks, or a default in spec/values.json that DEFAULTS
 * does not list, fails the run. The client would otherwise rely on a value the
 * specification no longer states, or leave out one it now states.
 *
 * Usage: node scripts/gen-contract.mjs           write both files
 *        node scripts/gen-contract.mjs --check   check that both files match spec/values.json
 * Exit:  0 on success, 1 when a value is missing, unknown, or malformed, or a file does
 *        not match.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const ROOT = new URL("../", import.meta.url);
const VALUES = new URL("spec/values.json", ROOT);
const SUBSET = new URL("contracts/lexq-manifest.sdk.json", ROOT);
const SOURCE = new URL("src/contract.ts", ROOT);

/**
 * The LexQ constants both files carry, by the name LexQ gives them, and what each one is.
 * `<C-012>` in a description becomes that code with the status spec/values.json gives it.
 */
const CONSTANTS = [
  ["MAX_REQUEST_NESTING_DEPTH", "How many levels a request body may nest. LexQ answers a deeper body with `<C-012>`."],
  ["IDEMPOTENCY_KEY_MAX_LENGTH", "The longest `Idempotency-Key` LexQ accepts, in characters. LexQ answers a longer key with `<I-003>`."],
  ["REPLAY_RETENTION_HOURS", "How long a successful decision stays available to a repeat with the same `Idempotency-Key`, in hours. A later repeat runs the decision again and is billed again."],
];

/** The error codes contracts/lexq-manifest.sdk.json carries, with the status LexQ gives each one. */
const ERROR_CODES = ["I-001", "I-002", "B-008"];

/** A code in a CONSTANTS description, written `<C-012>`. */
const CODE_IN_DOC = /<([A-Z]{1,4}-\d{3})>/g;

/**
 * Every default in the specification: its key in spec/values.json, the name src/contract.ts
 * exports, its kind, and what it is.
 */
const DEFAULTS = [
  ["baseUrl", "BASE_URL", "url", "Where LexQ is."],
  ["deadlineMs", "DEADLINE_MS", "count", "The deadline for a call, in milliseconds, covering every attempt and every wait between them."],
  ["attemptTimeoutMs", "ATTEMPT_TIMEOUT_MS", "count", "The timeout for one attempt while retries are on, in milliseconds."],
  ["maxAttempts", "MAX_ATTEMPTS", "count", "Attempts for a call, counting the first."],
  ["backoff", "BACKOFF", "ranges", "The wait before the next attempt, in milliseconds: entry n is the range after n + 1 failed attempts."],
  ["rateLimitWait", "RATE_LIMIT_WAIT", "range", "The wait after a `429` without `Retry-After`, in milliseconds."],
  ["keyInUseWait", "KEY_IN_USE_WAIT", "range", "The wait after `I-002`, in milliseconds."],
  ["breakerThreshold", "BREAKER_THRESHOLD", "count", "How many counted calls in a row open the breaker."],
  ["breakerCooldownMs", "BREAKER_COOLDOWN_MS", "count", "How long the breaker stays open before one trial call goes through, in milliseconds."],
  ["maxResponseBytes", "MAX_RESPONSE_BYTES", "count", "The largest response body the client reads, in bytes."],
  ["maxMessageLength", "MAX_MESSAGE_LENGTH", "count", "The longest part of LexQ's `message` an error message keeps, in UTF-16 code units."],
  ["maxKeyPathLength", "MAX_KEY_PATH_LENGTH", "count", "The longest key path an error message keeps, in UTF-16 code units."],
  ["maxErrorCodeLength", "MAX_ERROR_CODE_LENGTH", "count", "The longest `errorCode` an error keeps, in characters."],
];

/** What a problem says a default of each kind must be. */
const KIND_NAMES = {
  url: "a URL that starts with https://",
  count: "a positive integer",
  range: "an object with only minMs and maxMs, positive integers with minMs at most maxMs",
  ranges: "a non-empty list of objects, each with only minMs and maxMs, positive integers with minMs at most maxMs",
};

function fail(message, details = []) {
  console.error(`✗ ${message}`);
  for (const detail of details) {
    console.error(`  ${detail}`);
  }
  process.exit(1);
}

function isCount(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isRange(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.keys(value).sort().join() === "maxMs,minMs" &&
    isCount(value.minMs) &&
    isCount(value.maxMs) &&
    value.minMs <= value.maxMs
  );
}

/** The values both files need, checked for presence and form. */
function read() {
  if (!existsSync(VALUES)) {
    fail("spec/values.json not found", ["It belongs in spec/ with spec/SPEC.md and spec/spec.lock. CONTRIBUTING.md says how spec/ changes."]);
  }
  const values = JSON.parse(readFileSync(VALUES, "utf8"));
  const constants = values.constants ?? {};
  const statuses = new Map((values.errorCodes ?? []).map((entry) => [entry.code, entry.httpStatus]));
  const defaults = values.defaults ?? {};
  const listed = new Set(DEFAULTS.map(([key]) => key));
  const problems = [
    ...CONSTANTS.filter(([name]) => !isCount(constants[name])).map(([name]) => `constant ${name} is missing or not a positive integer`),
    ...ERROR_CODES.filter((code) => !Number.isInteger(statuses.get(code))).map((code) => `error code ${code} is missing or its status is not an integer`),
    ...CONSTANTS.flatMap(([name, doc]) =>
      [...doc.matchAll(CODE_IN_DOC)]
        .filter(([, code]) => !Number.isInteger(statuses.get(code)))
        .map(([, code]) => `error code ${code}, which the description of ${name} names, is missing or its status is not an integer`),
    ),
    ...Object.keys(defaults).filter((key) => !listed.has(key)).map((key) => `default ${key} is not in DEFAULTS`),
  ];
  for (const [key, , kind] of DEFAULTS) {
    const value = defaults[key];
    const ok =
      kind === "url"
        ? typeof value === "string" && value.startsWith("https://")
        : kind === "count"
          ? isCount(value)
          : kind === "range"
            ? isRange(value)
            : Array.isArray(value) && value.length > 0 && value.every(isRange);
    if (!ok) {
      problems.push(`default ${key} is missing or not ${KIND_NAMES[kind]}`);
    }
  }
  if (Array.isArray(defaults.backoff) && isCount(defaults.maxAttempts) && defaults.backoff.length !== defaults.maxAttempts - 1) {
    problems.push(`default backoff has ${defaults.backoff.length} ranges, and maxAttempts ${defaults.maxAttempts} needs ${defaults.maxAttempts - 1}`);
  }
  if (problems.length > 0) {
    fail("spec/values.json does not hold the values this client uses", problems);
  }
  return { constants, statuses, defaults };
}

function renderSubset({ constants, statuses }) {
  const subset = {
    schemaVersion: 2,
    note: "Subset of LexQ's contract manifest limited to CONSTANTS and ERROR_CODES in scripts/gen-contract.mjs. Generated; do not edit.",
    constants: Object.fromEntries(CONSTANTS.map(([name]) => [name, constants[name]])),
    errorCodes: ERROR_CODES.map((code) => ({ code, httpStatus: statuses.get(code) })),
  };
  return `${JSON.stringify(subset, null, 2)}\n`;
}

function literal(kind, value) {
  if (kind === "range") {
    return `{ minMs: ${value.minMs}, maxMs: ${value.maxMs} }`;
  }
  if (kind === "ranges") {
    return `[${value.map((range) => literal("range", range)).join(", ")}]`;
  }
  return JSON.stringify(value);
}

function renderSource({ constants, statuses, defaults }) {
  const lines = ["// Generated by scripts/gen-contract.mjs from spec/values.json. Do not edit.", ""];
  for (const [name, doc] of CONSTANTS) {
    const described = doc.replace(CODE_IN_DOC, (_, code) => `${statuses.get(code)} ${code}`);
    lines.push(`/** ${described} */`, `export const ${name} = ${constants[name]};`, "");
  }
  for (const [key, name, kind, doc] of DEFAULTS) {
    const suffix = kind === "range" || kind === "ranges" ? " as const" : "";
    lines.push(`/** ${doc} */`, `export const ${name} = ${literal(kind, defaults[key])}${suffix};`, "");
  }
  return lines.join("\n");
}

const values = read();
if (process.argv.includes("--check")) {
  const problems = [];
  if (!existsSync(SUBSET) || readFileSync(SUBSET, "utf8") !== renderSubset(values)) {
    problems.push("contracts/lexq-manifest.sdk.json does not match spec/values.json");
  }
  if (!existsSync(SOURCE) || readFileSync(SOURCE, "utf8") !== renderSource(values)) {
    problems.push("src/contract.ts does not match spec/values.json");
  }
  if (problems.length > 0) {
    fail("a file written from spec/values.json was changed by hand or not written again", [...problems, "Run node scripts/gen-contract.mjs to write both."]);
  }
  console.log(`✓ src/contract.ts and contracts/lexq-manifest.sdk.json match spec/values.json: ${CONSTANTS.length} constants, ${DEFAULTS.length} defaults, ${ERROR_CODES.length} error codes`);
} else {
  writeFileSync(SUBSET, renderSubset(values));
  writeFileSync(SOURCE, renderSource(values));
  console.log(`✓ wrote src/contract.ts and contracts/lexq-manifest.sdk.json from spec/values.json: ${CONSTANTS.length} constants, ${DEFAULTS.length} defaults, ${ERROR_CODES.length} error codes`);
}
