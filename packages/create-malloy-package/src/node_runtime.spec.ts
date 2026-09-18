// Copyright (c) Credible Data Inc.
// SPDX-License-Identifier: MIT

/**
 * The tests in this file run the built bundle under Node, because every other
 * test in this package runs the source under Bun and those are two different
 * engines.
 *
 * That gap is not academic. `build` bundles with `--target node`, `engines.node`
 * says `>=20`, and an npm user runs `dist/index.js` on Node -- so the artifact
 * this package ships is a V8 program no matter what JavaScriptCore said about
 * the source. The two disagree on limits that have nothing to do with the code:
 * the argument-count ceiling on a spread is roughly 125,000 on V8 and 200,000 on
 * JSC, so `Math.max(6, ...oneArgumentPerColumn)` in the model emitter was a
 * `RangeError` on the shipped CLI and a green test run at the same time, on the
 * same commit. A 1.1 MB CSV was enough to find it.
 *
 * So these are deliberately not unit tests. Each one builds the real bundle and
 * runs it the way a user does, and each one is anchored to a file that actually
 * broke the tool rather than to a limit -- a limit is an engine detail that will
 * move, and the point is to stop depending on where it is.
 *
 * They cost about a second each. If that ever stops being true, move them to
 * tests/e2e rather than deleting them: the run under Node is the part that
 * matters, not which suite it sits in.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = path.resolve(
   path.dirname(fileURLToPath(import.meta.url)),
   "..",
);
const distDir = path.join(packageRoot, "dist");
/** The bin an npm user gets, built exactly as package.json builds it. */
const cliBundle = path.join(distDir, "index.js");
/**
 * A throwaway copy of the package layout, for the emitter bundle below.
 *
 * templates.ts resolves ../templates from its own module's location, so that
 * bundle has to sit one level under a directory with a templates/ beside it.
 * dist/ is the obvious such directory and the wrong one: `files` publishes
 * dist/ wholesale and `prepack` builds into it without clearing it first, so
 * anything a test leaves there is a file npm puts in the tarball. Cleaning up
 * afterwards would not be enough either -- an interrupted or crashed run would
 * still leave it behind -- so nothing that is not a shipped artifact is written
 * into dist/ at all. Rebuilding the layout here, a root with dist/ and
 * templates/ as siblings, keeps the resolution identical to an installed
 * package, and the bundle is still the real one, built by the same command.
 */
const checkRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-node-check-"));
/**
 * The emitter on its own, so a case can call it directly instead of driving the
 * whole CLI.
 */
const modelBundle = path.join(checkRoot, "dist", "model.node-check.js");

function bunBuild(entry: string, outfile: string): void {
   // process.execPath, not the string "bun": on Windows the npm-installed `bun`
   // on PATH is a .cmd shim, and spawning a .cmd refuses arguments that a path
   // may well contain. The binary running this test is the one we want anyway.
   const built = spawnSync(
      process.execPath,
      [
         "build",
         path.join(packageRoot, "src", entry),
         "--outfile",
         outfile,
         "--target",
         "node",
         "--format",
         "esm",
         "--packages",
         "external",
      ],
      { cwd: packageRoot, encoding: "utf8" },
   );
   if (built.status !== 0) {
      throw new Error(
         `bun build ${entry} failed (${built.status}):\n${built.stdout}\n${built.stderr}`,
      );
   }
}

/** Run Node on a file, from a directory of its own, and hand back everything. */
function runNode(
   file: string,
   args: string[],
   cwd: string,
): { status: number | null; out: string } {
   const run = spawnSync("node", [file, ...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
   });
   if (run.error) {
      throw new Error(
         `could not run node: ${run.error.message}. These tests exist to ` +
            `exercise the shipped bundle on the runtime it ships for, so a ` +
            `missing Node is a gap in the run, not something to skip past.`,
      );
   }
   return { status: run.status, out: `${run.stdout}${run.stderr}` };
}

/** A fresh directory to scaffold into, with the data file already written. */
function seeded(name: string, contents: string): string {
   const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-node-"));
   fs.writeFileSync(path.join(dir, name), contents);
   return dir;
}

/** The model file a scaffolded package carries. */
function modelOf(dir: string): string {
   const pkg = path.join(dir, "sales");
   const model = fs.readdirSync(pkg).find((entry) => entry.endsWith(".malloy"));
   if (model === undefined) {
      throw new Error(
         `no model file in ${pkg}: [${fs.readdirSync(pkg).join(", ")}]`,
      );
   }
   return fs.readFileSync(path.join(pkg, model), "utf8");
}

/** One backslash, built rather than written: the literal is itself an escape. */
const BACKSLASH = String.fromCharCode(92);

beforeAll(() => {
   fs.mkdirSync(path.dirname(modelBundle), { recursive: true });
   fs.cpSync(
      path.join(packageRoot, "templates"),
      path.join(checkRoot, "templates"),
      { recursive: true },
   );
   bunBuild("index.ts", cliBundle);
   bunBuild("model.ts", modelBundle);
});

afterAll(() => {
   fs.rmSync(checkRoot, { recursive: true, force: true });
});

describe("the built bundle under Node", () => {
   test("a JSON key named after an Object.prototype member scaffolds", () => {
      // The smallest file that reproduces it, byte for byte: 33 bytes. It used
      // to stop the CLI with `Cannot read properties of undefined (reading
      // 'trim')` after the package directory, publisher.json,
      // malloy-config.json and the copied data file were already written -- a
      // package the user had to delete by hand before they could try again.
      const dir = seeded("proto.json", '[{"constructor":1,"a":1},{"a":2}]');
      const run = runNode(cliBundle, ["sales", "--data", "./proto.json"], dir);
      expect(run.status).toBe(0);
      expect(run.out).not.toContain("Cannot read properties of undefined");
      // The run finished, so the model is there -- and its profile comment
      // reports the record that lacked the key as one empty value rather than
      // as an inherited function.
      const model = modelOf(dir);
      expect(model).toContain("// Columns read from 2 rows of the file:");
      expect(model).toContain("constructor  integer");
      expect(model).toContain("1 distinct  1 empty");
      expect(model).toContain("measure: record_count is count()");
      fs.rmSync(dir, { recursive: true, force: true });
   });

   test("a file wider than the column cap falls back instead of failing", () => {
      // 130,000 columns and one row: 1.1 MB, comfortably inside the 4 MiB the
      // profiler reads, and `RangeError: Maximum call stack size exceeded` on
      // Node before the cap and the fold. The package it leaves behind now is
      // the one --data has always produced for a file this tool cannot model.
      const n = 130000;
      const header = Array.from({ length: n }, (_, i) => `c${i}`).join(",");
      const row = Array.from({ length: n }, (_, i) => String(i % 7)).join(",");
      const dir = seeded("wide.csv", `${header}\n${row}\n`);
      const run = runNode(cliBundle, ["sales", "--data", "./wide.csv"], dir);
      expect(run.status).toBe(0);
      expect(run.out).not.toContain("Maximum call stack size exceeded");
      const model = modelOf(dir);
      expect(model).toContain("measure: record_count is count()");
      expect(model).not.toContain("dimension: c0 is");
      fs.rmSync(dir, { recursive: true, force: true });
   });

   test("the emitter takes 130,000 columns on V8 without a spread limit", () => {
      // The cap above means the CLI no longer hands the emitter a file this
      // wide, so this calls it directly. Without it, the fold in
      // renderProfileComment could be turned back into a spread and every test
      // in this package would stay green -- which is exactly what happened.
      const driver = path.join(
         fs.mkdtempSync(path.join(os.tmpdir(), "cmp-emit-")),
         "drive.mjs",
      );
      fs.writeFileSync(
         driver,
         [
            // pathToFileURL, not string concatenation: a Windows path needs a
            // third slash and its drive letter escaped, and getting that wrong
            // fails as "module not found" rather than as anything readable.
            `const { renderProfiledModel } = await import(${JSON.stringify(
               pathToFileURL(modelBundle).href,
            )});`,
            "const columns = Array.from({ length: 130000 }, (_, i) => ({",
            "   name: `c${i}`,",
            '   type: "string",',
            "   distinct: 2,",
            "   nulls: 0,",
            "   isKey: false,",
            "}));",
            "const model = renderProfiledModel(",
            "   { columns, rowsProfiled: 1, truncated: false },",
            '   { sourceName: "shop", dataPath: "data/wide.csv" },',
            ");",
            'if (!model.includes("measure: record_count is count()")) {',
            '   throw new Error("the model came back without its measure");',
            "}",
            'console.log("EMITTED", model.length);',
         ].join("\n"),
      );
      const run = runNode(driver, [], path.dirname(driver));
      expect(run.out).not.toContain("Maximum call stack size exceeded");
      expect(run.status).toBe(0);
      expect(run.out).toContain("EMITTED");
      fs.rmSync(path.dirname(driver), { recursive: true, force: true });
   });

   test("a header carrying a backslash never reaches the model", () => {
      // The one that scaffolded green and then would not load: the backslash
      // escaped the closing backtick of the name the emitter quoted, so the
      // package the user was handed had two parse errors in it and nothing in
      // the run said so.
      const dir = seeded("paths.csv", `path${BACKSLASH},n\na,1\nb,2\nc,3\n`);
      const run = runNode(cliBundle, ["sales", "--data", "./paths.csv"], dir);
      expect(run.status).toBe(0);
      const model = modelOf(dir);
      expect(model).not.toContain(BACKSLASH);
      expect(model).toContain("measure: record_count is count()");
      fs.rmSync(dir, { recursive: true, force: true });
   });

   test("an ordinary CSV still profiles when run this way", () => {
      // The control. Without it, four passing fallbacks prove only that the
      // tool can decline to read a file.
      const dir = seeded(
         "orders.csv",
         "order_id,region,amount\n1,west,10\n2,east,20\n3,west,5\n",
      );
      const run = runNode(cliBundle, ["sales", "--data", "./orders.csv"], dir);
      expect(run.status).toBe(0);
      const model = modelOf(dir);
      expect(model).toContain("// Columns read from 3 rows of the file:");
      expect(model).toContain("measure: total_amount is amount.sum()");
      fs.rmSync(dir, { recursive: true, force: true });
   });
});
