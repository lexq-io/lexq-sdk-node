import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

// The engines field in package.json sets the oldest Node.js version the package
// supports. Three other places follow it: the README states it, the CI matrix tests
// that line, and the @types/node major makes the type check reject an API that line
// does not have.

interface PackageJson {
  engines: { node: string };
  devDependencies: Record<string, string>;
}

function read(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

const packageJson = JSON.parse(await read("package.json")) as PackageJson;

function floor(): { major: number; minor: number } {
  const range = packageJson.engines.node;
  const match = /^>=(\d+)\.(\d+)\.0$/.exec(range);
  assert.ok(match, `engines.node is "${range}", expected ">=MAJOR.MINOR.0"`);
  return { major: Number(match[1]), minor: Number(match[2]) };
}

test("the README states the floor in engines", async () => {
  const { major, minor } = floor();
  const sentence = `Node.js ${major}.${minor} or later`;
  assert.ok((await read("README.md")).includes(sentence), `README.md does not say "${sentence}"`);
});

test("CI tests the floor line", async () => {
  const { major } = floor();
  const matrix = /^\s*node: \[([^\]]*)\]$/m.exec(await read(".github/workflows/ci.yml"));
  assert.ok(matrix, "no `node: [...]` matrix in .github/workflows/ci.yml");
  const lines = (matrix[1] ?? "").split(",").map((line) => Number(line));
  assert.equal(Math.min(...lines), major);
});

test("type definitions come from the floor line", () => {
  const { major } = floor();
  const types = packageJson.devDependencies["@types/node"] ?? "";
  assert.match(types, new RegExp(`^\\^${major}\\.`));
});
