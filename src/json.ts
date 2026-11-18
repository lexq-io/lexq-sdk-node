import { MAX_REQUEST_NESTING_DEPTH } from "./contract.ts";
import { Decimal } from "./decimal.ts";

// JSON.isRawJSON and the source text JSON.parse passes to a reviver are in Node.js 21
// and later, but not yet in TypeScript's lib.
const json = JSON as JSON & { isRawJSON(value: unknown): value is { readonly rawJSON: string } };
type Reviver = (key: string, value: unknown) => unknown;

/**
 * How many levels the client lets the request body nest. It is LexQ's own limit, so a body
 * that LexQ would answer with `400 C-012` goes to the fallback without being sent. The body
 * is the first level and `facts` the second, so `{"facts":{"tags":["a"]}}` nests three. The
 * limit also keeps a runaway structure from exhausting the stack.
 */
export const MAX_DEPTH = MAX_REQUEST_NESTING_DEPTH;

/** The level of a value in `facts` or `contexts`: inside the body and that object. */
const ENTRY_LEVEL = 3;

/**
 * Writes the request body once, so every attempt can send the same bytes.
 *
 * A top-level entry of `facts` or `contexts` whose value is null or undefined is left out.
 * Anything JSON cannot carry as written throws a TypeError naming where it is: NaN,
 * Infinity, a missing list element, a function, a symbol, a Map or another object that
 * is not plain, or a structure that contains itself.
 */
export function encodeBody(facts: object, contexts: object | undefined): string {
  const fields = [`"facts":${encodeEntries(facts, "facts")}`];
  if (contexts !== undefined) {
    fields.push(`"contexts":${encodeEntries(contexts, "contexts")}`);
  }
  return `{${fields.join(",")}}`;
}

/** Parses a response body, turning every number into a Decimal that keeps the digits as written. */
export function decodeBody(text: string): unknown {
  return JSON.parse(text, reviveNumber as Reviver);
}

function reviveNumber(_key: string, value: unknown, context?: { readonly source?: string }): unknown {
  return typeof value === "number" && context?.source !== undefined ? new Decimal(context.source) : value;
}

function encodeEntries(object: object, path: string): string {
  const entries: string[] = [];
  for (const [key, value] of Object.entries(object)) {
    if (value === null || value === undefined) {
      continue;
    }
    entries.push(`${JSON.stringify(key)}:${encodeValue(value, `${path}.${key}`, ENTRY_LEVEL, new Set([object]))}`);
  }
  return `{${entries.join(",")}}`;
}

function encodeValue(value: unknown, path: string, depth: number, ancestors: Set<object>): string {
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(`${path} is ${value}, which JSON cannot carry`);
      }
      return String(value);
    case "bigint":
      return value.toString();
    case "undefined":
      throw new TypeError(`${path} is undefined, which JSON cannot carry`);
    case "function":
    case "symbol":
      throw new TypeError(`${path} is a ${typeof value}, which JSON cannot carry`);
    default:
      break;
  }
  if (value === null) {
    return "null";
  }
  if (value instanceof Decimal) {
    return value.text;
  }
  if (json.isRawJSON(value)) {
    return value.rawJSON;
  }
  if (depth > MAX_DEPTH) {
    throw new TypeError(`${path} would nest the request body more than ${MAX_DEPTH} levels deep`);
  }
  if (ancestors.has(value as object)) {
    throw new TypeError(`${path} contains itself, which JSON cannot carry`);
  }
  ancestors.add(value as object);
  try {
    return encodeContainer(value as object, path, depth, ancestors);
  } finally {
    ancestors.delete(value as object);
  }
}

function encodeContainer(value: object, path: string, depth: number, ancestors: Set<object>): string {
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const item: unknown = value[index];
      if (!(index in value) || item === undefined) {
        throw new TypeError(`${path}[${index}] is missing, which JSON cannot carry`);
      }
      items.push(encodeValue(item, `${path}[${index}]`, depth + 1, ancestors));
    }
    return `[${items.join(",")}]`;
  }
  const toJSON: unknown = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === "function") {
    // What JSON.stringify does with a Date: write what toJSON returns.
    return encodeValue(toJSON.call(value), path, depth + 1, ancestors);
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    const name = (value as { constructor?: { name?: unknown } }).constructor?.name;
    throw new TypeError(`${path} is a ${typeof name === "string" ? name : "object"}, which JSON cannot carry as written`);
  }
  const entries: string[] = [];
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) {
      continue;
    }
    entries.push(`${JSON.stringify(key)}:${encodeValue(item, `${path}.${key}`, depth + 1, ancestors)}`);
  }
  return `{${entries.join(",")}}`;
}
