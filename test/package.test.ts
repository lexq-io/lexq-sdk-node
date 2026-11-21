// What npm publishes. npm run build compiles src into dist/, package.json points at
// dist/index.js and its declarations, and the tarball holds nothing else. Apart from the
// first test, each test reads a copy of the package, built into a temporary directory the
// way npm run build builds it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../", import.meta.url);
const TSC = fileURLToPath(new URL("node_modules/typescript/bin/tsc", ROOT));

interface PackageJson {
  readonly exports?: { readonly "."?: { readonly types?: unknown; readonly default?: unknown } };
  readonly types?: unknown;
}

let dir = "";
let packed: string[] = [];

function run(file: string, args: readonly string[], cwd = dir): string {
  const result = spawnSync(file, args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `${file} ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`);
  return result.stdout;
}

/** The paths `npm pack` would put in the tarball for the package in `cwd`. */
function pack(cwd: string): string[] {
  const [report] = JSON.parse(run("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], cwd)) as [{ files: { path: string }[] }];
  return report.files.map((file) => file.path).sort();
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "lexq-sdk-package-"));
  for (const file of ["package.json", "README.md", "LICENSE"]) {
    await copyFile(new URL(file, ROOT), join(dir, file));
  }
  run(process.execPath, [TSC, "-p", fileURLToPath(new URL("tsconfig.build.json", ROOT)), "--outDir", join(dir, "dist")]);
  packed = pack(dir);
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("npm pack takes nothing from this repository but dist/, package.json, the README, and the license", () => {
  const outside = pack(fileURLToPath(ROOT)).filter((path) => !path.startsWith("dist/") && !["LICENSE", "README.md", "package.json"].includes(path));
  assert.deepEqual(outside, []);
});

test("the tarball holds package.json, the README, the license, and a .js and .d.ts for each source file", async () => {
  const modules = (await readdir(new URL("src/", ROOT))).filter((name) => name.endsWith(".ts")).map((name) => name.slice(0, -".ts".length));
  const expected = ["LICENSE", "README.md", "package.json", ...modules.flatMap((name) => [`dist/${name}.d.ts`, `dist/${name}.js`])];
  assert.deepEqual(packed, expected.sort());
});

test("package.json points at files the tarball holds", async () => {
  const packageJson = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as PackageJson;
  const fields: [string, unknown][] = [
    ['exports["."].types', packageJson.exports?.["."]?.types],
    ['exports["."].default', packageJson.exports?.["."]?.default],
    // TypeScript 5 resolves with node10 by default under module commonjs, and node10
    // ignores exports and reads this field.
    ["types", packageJson.types],
  ];
  for (const [field, path] of fields) {
    assert.ok(typeof path === "string" && packed.includes(path.replace(/^\.\//, "")), `${field} is ${JSON.stringify(path)}, not a file in the tarball`);
  }
});

test("import and require of the package name load what src/index.ts exports", async () => {
  const names = Object.keys(await import("../src/index.ts")).sort().join(",");
  await writeFile(join(dir, "load.mjs"), 'console.log(Object.keys(await import("@lexq/sdk")).sort().join(","));\n');
  await writeFile(join(dir, "load.cjs"), 'console.log(Object.keys(require("@lexq/sdk")).sort().join(","));\n');
  assert.equal(run(process.execPath, ["load.mjs"]).trim(), names);
  assert.equal(run(process.execPath, ["load.cjs"]).trim(), names);
});

test("TypeScript finds the declarations through the package name", async () => {
  await writeFile(
    join(dir, "consumer.ts"),
    [
      'import { Decimal, LexqClient, type ExecuteResult } from "@lexq/sdk";',
      "",
      "export async function decide(lexq: LexqClient): Promise<string> {",
      '  const result: ExecuteResult<number> = await lexq.execute("group-1", { facts: { amount: new Decimal("1.5") }, fallback: () => 0 });',
      "  // The fallback's error is always a LexqError, so its reason needs no instanceof check.",
      '  return result.source === "lexq" ? result.traceId : `${result.error.reason} ${String(result.error.status)}`;',
      "}",
      "",
      "// If the package resolved to `any`, this directive would go unused and fail the check.",
      "// @ts-expect-error: a call without a fallback does not compile.",
      'void new LexqClient({ apiKey: "key" }).execute("group-1", { facts: {} });',
      "",
    ].join("\n"),
  );
  await writeFile(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { target: "es2022", module: "nodenext", strict: true, noEmit: true, skipLibCheck: false, types: [] },
      files: ["consumer.ts"],
    }),
  );
  run(process.execPath, [TSC, "-p", join(dir, "tsconfig.json")]);
});
