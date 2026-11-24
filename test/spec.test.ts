// spec/ holds unchanged copies of one version of the LexQ SDK specification: SPEC.md and
// values.json, with spec.lock naming the version and the SHA-256 of each copy. The three
// files change together when the package moves to another version of the specification.
// CONTRACT.md names the lock's version once and no other version. Any string written
// like v1.2.3 counts as a version, even one meant as a tag of this package.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { test } from "node:test";

const ROOT = new URL("../", import.meta.url);

// A version such as v1.2.3 standing alone, not part of v1.2.3-rc1, v1.2.3.4, or v01.2.3. A
// period that ends a sentence is allowed after it.
const VERSION = /(?<![\w.-])v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?![\w-]|\.\d)/g;

interface Lock {
  readonly note: string;
  readonly version: string;
  readonly commit: string;
  readonly files: Readonly<Record<string, { readonly sha256: string }>>;
}

async function readLock(): Promise<Lock> {
  return JSON.parse(await readFile(new URL("spec/spec.lock", ROOT), "utf8")) as Lock;
}

test("spec/ holds the two copies and the lock as plain files, and nothing else", async () => {
  const names = (await readdir(new URL("spec/", ROOT))).sort();
  assert.deepEqual(names, ["SPEC.md", "spec.lock", "values.json"]);
  for (const name of names) {
    const stats = await lstat(new URL(`spec/${name}`, ROOT));
    assert.ok(stats.isFile(), `spec/${name} is not a plain file`);
  }
});

test("spec.lock names one version and one commit, and holds the SHA-256 of each copy", async () => {
  const lock = await readLock();
  assert.deepEqual(Object.keys(lock).sort(), ["commit", "files", "note", "version"]);
  assert.deepEqual(lock.version.match(VERSION), [lock.version]);
  assert.match(lock.commit, /^[0-9a-f]{40}$/);
  assert.deepEqual(Object.keys(lock.files).sort(), ["SPEC.md", "values.json"]);
  for (const [name, entry] of Object.entries(lock.files)) {
    assert.deepEqual(Object.keys(entry), ["sha256"]);
    const digest = createHash("sha256").update(await readFile(new URL(`spec/${name}`, ROOT))).digest("hex");
    assert.equal(digest, entry.sha256, `spec/${name} is not the copy spec.lock names`);
  }
});

test("CONTRACT.md names the version in spec.lock, and no other", async () => {
  const lock = await readLock();
  const named = (await readFile(new URL("CONTRACT.md", ROOT), "utf8")).match(VERSION) ?? [];
  assert.deepEqual(named, [lock.version]);
});
