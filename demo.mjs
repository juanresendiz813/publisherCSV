#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// demo.mjs — serve this repo's example packages with one command and nothing
// installed:
//
//     node demo.mjs
//
// It runs the published Malloy Publisher server (npx, pinned version below)
// against demo/publisher.config.json, waits until the server reports
// `operationalState: "serving"`, prints the Console / package / dashboard /
// MCP URLs and opens the dashboard in your browser. Ctrl-C stops everything.
//
// Node >= 20 only, no dependencies. `node demo.mjs --help` lists the flags;
// `--package <dir>` serves any package directory instead of the bundled
// examples, which is how another project reuses this file unchanged.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_PACKAGE = "@malloy-publisher/server";
// Pinned: the npx cache happily re-runs a stale `@latest`, and the server does
// not print its version. Bump deliberately; `--latest` overrides for a look.
const SERVER_VERSION = "0.4.0";
const NODE_MAJOR_REQUIRED = 20;

const REPO = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = path.join(REPO, "demo", "publisher.config.json");
const DEFAULT_SERVER_ROOT = path.join(REPO, "demo", ".run");

const USAGE = `Usage: node demo.mjs [options] [-- <extra server flags>]

Serves the example packages (demo/publisher.config.json) on the published
${SERVER_PACKAGE}@${SERVER_VERSION} via npx. First run downloads the server.

Options:
  --package <dir>       Serve one package directory (needs a publisher.json)
                        instead of the bundled examples. A config is generated
                        under the server root for it.
  --config <file>       Use this publisher.config.json (overrides --package).
  --server_root <dir>   Where the server keeps its storage (publisher_data/,
                        publisher.db, DuckDB spill). Default: demo/.run.
                        NOTE: publisher_data/ under it is wiped on every start,
                        and a private package.json is written there if missing.
                        In a clone where \`bun install\` has been run, a root
                        OUTSIDE the clone also saves ~50 s of npx pre-flight.
  --port <n>            REST + Console port (default 4000)
  --mcp_port <n>        MCP port (default 4040)
  --host <addr>         Bind address (default 127.0.0.1)
  --latest              Run ${SERVER_PACKAGE}@latest instead of the pinned version
  --no-open             Do not open the browser
  -h, --help            This text
  --                    Everything after it is passed to the server as-is
                        (e.g. -- --watch-env examples)
`;

// ---------------------------------------------------------------------------
// 0. Node floor. The published server exits with PUBLISHER_UNSUPPORTED_NODE on
//    an old Node, but only after npx has downloaded 30 MB; say it up front.
// ---------------------------------------------------------------------------
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (!(nodeMajor >= NODE_MAJOR_REQUIRED)) {
   process.stderr.write(
      `PUBLISHER_UNSUPPORTED_NODE required=>=${NODE_MAJOR_REQUIRED} detected=${process.versions.node}\n` +
         `Fix: install Node ${NODE_MAJOR_REQUIRED} or newer (https://nodejs.org, or \`nvm install 22 && nvm use 22\`), then run \`node demo.mjs\` again.\n`,
   );
   process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. Arguments
// ---------------------------------------------------------------------------
function parseArgs(argv) {
   const opts = {
      package: null,
      config: null,
      serverRoot: DEFAULT_SERVER_ROOT,
      port: "4000",
      mcpPort: "4040",
      host: "127.0.0.1",
      latest: false,
      open: true,
      extra: [],
   };
   const takesValue = {
      "--package": "package",
      "--config": "config",
      "--server_root": "serverRoot",
      "--port": "port",
      "--mcp_port": "mcpPort",
      "--host": "host",
   };
   for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if (arg === "--") {
         opts.extra = argv.slice(i + 1);
         break;
      }
      if (arg === "-h" || arg === "--help") {
         process.stdout.write(USAGE);
         process.exit(0);
      }
      if (arg === "--latest") {
         opts.latest = true;
      } else if (arg === "--no-open") {
         opts.open = false;
      } else if (arg in takesValue) {
         const value = argv[i + 1];
         if (value === undefined || value.startsWith("--")) {
            fail(`${arg} needs a value.\n\n${USAGE}`, 2);
         }
         opts[takesValue[arg]] = value;
         i++;
      } else {
         fail(`Unknown option: ${arg}\n\n${USAGE}`, 2);
      }
   }
   for (const key of ["port", "mcpPort"]) {
      if (!/^\d{1,5}$/.test(opts[key])) {
         fail(`--${key === "mcpPort" ? "mcp_port" : key} must be a port number, got "${opts[key]}".`, 2);
      }
   }
   return opts;
}

function fail(message, code = 1) {
   process.stderr.write(message.endsWith("\n") ? message : `${message}\n`);
   process.exit(code);
}

const opts = parseArgs(process.argv.slice(2));

// ---------------------------------------------------------------------------
// 2. Server root + config
// ---------------------------------------------------------------------------
const serverRoot = path.resolve(opts.serverRoot);
// `--init` deletes <server_root>/publisher_data on every boot. That is the
// point for a throwaway demo dir and a disaster for the from-source server's
// own storage, so refuse the one path that is easy to type by habit.
if (serverRoot === path.join(REPO, "packages", "server")) {
   fail(
      `--server_root must not be packages/server (this script starts the server with --init, which wipes <server_root>/publisher_data). Use the default (demo/.run) or another directory.`,
   );
}
fs.mkdirSync(serverRoot, { recursive: true });
// npx runs from the server root, and npm walks UP from there to find "the
// project". Inside this repo that walk reaches the workspace, whose
// packages/server IS @malloy-publisher/server at the pinned version, so npx
// would run the (unbuilt) workspace copy instead of installing the published
// one. A private package.json in the server root ends the walk there.
const boundary = path.join(serverRoot, "package.json");
if (!fs.existsSync(boundary)) {
   fs.writeFileSync(
      boundary,
      `${JSON.stringify({ name: "publisher-demo-run", private: true, description: "npm project boundary for demo.mjs; safe to delete" }, null, 2)}\n`,
   );
}

let configPath;
if (opts.config) {
   configPath = path.resolve(opts.config);
   if (!isFile(configPath)) fail(`--config: no such file: ${configPath}`);
} else if (opts.package) {
   configPath = writePackageConfig(path.resolve(opts.package), serverRoot);
} else {
   configPath = DEFAULT_CONFIG;
   if (!isFile(configPath)) {
      fail(`Missing ${configPath}. Run this from a clone of the repo, or pass --package <dir> / --config <file>.`);
   }
}

function isFile(p) {
   try {
      return fs.statSync(p).isFile();
   } catch {
      return false;
   }
}

// A one-package config, generated under the server root so the location can
// be absolute and the file lands somewhere git-ignored. The environment is
// named `demo`, the package after its publisher.json.
function writePackageConfig(packageDir, root) {
   const manifest = path.join(packageDir, "publisher.json");
   if (!isFile(manifest)) {
      fail(`--package: ${packageDir} has no publisher.json (not a Malloy package directory).`);
   }
   let name = path.basename(packageDir);
   try {
      const parsed = JSON.parse(fs.readFileSync(manifest, "utf8"));
      if (typeof parsed.name === "string" && parsed.name.trim()) name = parsed.name.trim();
   } catch (error) {
      fail(`--package: cannot read ${manifest}: ${error.message}`);
   }
   const config = {
      frozenConfig: false,
      environments: [
         {
            name: "demo",
            packages: [{ name, location: packageDir.split(path.sep).join("/") }],
            connections: [],
         },
      ],
   };
   const target = path.join(root, "publisher.config.json");
   fs.writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`);
   return target;
}

// First environment / first package in the config: what the printed URLs and
// the browser point at.
function firstPackage(file) {
   try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      const env = parsed.environments?.[0];
      const pkg = env?.packages?.[0];
      if (env?.name && pkg?.name) return { environment: env.name, package: pkg.name };
   } catch {
      // A config the server cannot read fails loudly below (PUBLISHER_INIT_FAILED).
   }
   return null;
}
const first = firstPackage(configPath);

// ---------------------------------------------------------------------------
// 3. URLs
// ---------------------------------------------------------------------------
const urlHost =
   opts.host === "0.0.0.0" ? "127.0.0.1"
   : opts.host === "::" ? "[::1]"
   : opts.host.includes(":") ? `[${opts.host}]`
   : opts.host;
const baseUrl = `http://${urlHost}:${opts.port}`;
const mcpUrl = `http://${urlHost}:${opts.mcpPort}/mcp`;
const statusUrl = `${baseUrl}/api/v0/status`;

// ---------------------------------------------------------------------------
// 4. Start the published server through npx
// ---------------------------------------------------------------------------
const spec = `${SERVER_PACKAGE}@${opts.latest ? "latest" : SERVER_VERSION}`;
const serverArgs = [
   "--config", configPath,
   "--server_root", serverRoot,
   "--port", opts.port,
   "--mcp_port", opts.mcpPort,
   "--host", opts.host,
   "--init",
   "--no-mcp-config",
   ...opts.extra,
];
const npxArgs = ["--yes", spec, ...serverArgs];

process.stdout.write(
   `demo: ${spec} --config ${configPath} --server_root ${serverRoot} (${baseUrl}, MCP ${mcpUrl})\n` +
      `demo: first run downloads the server (about 30 MB); the Console answers once it prints PUBLISHER_READY\n`,
);

const child = startNpx(npxArgs);

// Prefer running npm's own npx-cli.js under the current node: no `.cmd` shim
// (which Node refuses to spawn without a shell), no extra cmd.exe layer, and
// Node quotes the arguments itself. Falls back to the `npx` on PATH.
function startNpx(args) {
   const env = { ...process.env };
   // The child writes to a pipe (so this script can read PUBLISHER_* lines), and
   // the server's logger drops colors for a pipe; keep them when we have a TTY.
   if (process.stdout.isTTY && env.FORCE_COLOR === undefined) env.FORCE_COLOR = "1";
   // POSIX: give the child its own process group (detached calls setsid), so a
   // stop can signal the GROUP. npx interposes at least one `sh -c` layer on
   // Linux, and signalling the immediate child alone leaves the real server
   // running and still holding both ports. Windows has no process groups to
   // join and `detached` there means a new console window, so: POSIX only.
   const common = {
      cwd: serverRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
   };

   const execDir = path.dirname(process.execPath);
   const npxCli = [
      path.join(execDir, "node_modules", "npm", "bin", "npx-cli.js"),
      path.join(execDir, "..", "lib", "node_modules", "npm", "bin", "npx-cli.js"),
   ].find(isFile);
   if (npxCli) {
      return spawn(process.execPath, [npxCli, ...args], common);
   }
   if (process.platform === "win32") {
      for (const a of args) {
         if (a.includes('"')) fail(`Cannot pass an argument containing a double quote through cmd.exe: ${a}`);
      }
      const quoted = args.map((a) => (/[\s&|<>^()]/.test(a) ? `"${a}"` : a));
      return spawn("npx.cmd", quoted, { ...common, shell: true });
   }
   return spawn("npx", args, common);
}

// ---------------------------------------------------------------------------
// 5. Stream output through, watching for the server's machine-readable lines
// ---------------------------------------------------------------------------
let serving = false;
let stopping = false;
let childExited = false;

function relay(stream, sink) {
   let pending = "";
   stream.on("data", (chunk) => {
      sink.write(chunk);
      pending += chunk.toString();
      let nl;
      while ((nl = pending.indexOf("\n")) !== -1) {
         onServerLine(pending.slice(0, nl));
         pending = pending.slice(nl + 1);
      }
   });
}
relay(child.stdout, process.stdout);
relay(child.stderr, process.stderr);

function onServerLine(line) {
   if (line.includes("PUBLISHER_INIT_FAILED")) {
      // The server stays up (listening, not serving) after this; for a demo
      // that is a hang, so stop it and report.
      process.stderr.write(`demo: the server could not load its configuration (see the PUBLISHER_INIT_FAILED line above). Config: ${configPath}\n`);
      stop("SIGTERM", 1);
   } else if (line.includes("PUBLISHER_UNSUPPORTED_NODE")) {
      process.stderr.write(`demo: the server refused this Node (${process.versions.node}); it needs >= ${NODE_MAJOR_REQUIRED}.\n`);
   }
}

child.on("error", (error) => {
   process.stderr.write(`demo: could not start npx: ${error.message}\nIs npm installed next to node? (\`npx --version\` should print a version.)\n`);
   process.exit(1);
});

let exitCodeOverride = null;
// True only while the orphan sweep is watching a process group that outlived
// the child leading it: the one state in which a group kill is still justified
// after the child has been reaped.
let orphanGroupAlive = false;
child.on("exit", (code, signal) => {
   childExited = true;
   const finish = () => {
      if (exitCodeOverride !== null) process.exit(exitCodeOverride);
      if (!serving && !stopping) {
         process.stderr.write(`demo: the server exited before it was serving (code=${code ?? "null"} signal=${signal ?? "none"}).\n`);
      }
      process.exit(code ?? (stopping ? 0 : 1));
   };
   // `child` LEADS the process group, it is not the group: npx interposes an
   // `sh -c` layer with the real server under it. When the leader goes first —
   // `kill -9` on the npx pid, or a server that outlives the npx that was
   // signalled alongside it — those two are left holding both ports with
   // nothing above them, and exiting here would strand them. Wait them out.
   if (groupAlive()) return sweepOrphanedGroup(finish);
   finish();
});

// ---------------------------------------------------------------------------
// 6. Stop cleanly: forward the signal, wait, force after a grace period
// ---------------------------------------------------------------------------
// How long a stop waits for a graceful shutdown before forcing one.
const STOP_GRACE_MS = process.platform === "win32" ? 5000 : 10000;

function stop(signal, exitCode) {
   if (stopping) return;
   stopping = true;
   if (exitCode !== undefined) exitCodeOverride = exitCode;
   if (childExited) process.exit(exitCodeOverride ?? 0);
   process.stdout.write(`\ndemo: stopping the server (${signal})...\n`);
   // POSIX: signal the child's whole process group, which is what an
   // interactive terminal's Ctrl-C does and what `child.kill()` does NOT.
   // Windows: a console Ctrl-C already reached npx and the server on this
   // console and both exit on their own (verified: the whole tree is gone
   // and nothing is left listening). kill() here would only terminate npx
   // and orphan the server, so skip it; the tree kill below covers a stop
   // that did NOT come from the console, e.g. PUBLISHER_INIT_FAILED.
   // SIGQUIT is forwarded as SIGTERM: nothing in the tree handles SIGQUIT, and
   // the default action for it is "terminate and dump core" — one core file per
   // process, in the server root. Ask for the same clean shutdown instead.
   if (process.platform !== "win32") signalGroup(signal === "SIGQUIT" ? "SIGTERM" : signal);
   const grace = setTimeout(() => {
      // `childExited` means the child's own "exit" handler took over: it
      // either found the group gone or is watching it on the same deadline,
      // and it owns the escalation from there. Nothing to force here, and the
      // pid is no longer reliably ours to aim a blind group kill at.
      if (childExited) return;
      killTree(child.pid);
   }, STOP_GRACE_MS);
   grace.unref();
}

// POSIX only. A negative pid signals the process group the child leads (see
// startNpx), reaching every shell layer npx interposes and the server itself.
// A group that is already gone is the normal race on a second stop, not an
// error worth printing.
function signalGroup(signal) {
   if (!child.pid) return;
   try {
      process.kill(-child.pid, signal);
   } catch (error) {
      if (error.code === "ESRCH") return; // already dead, or never grouped
      try {
         child.kill(signal); // e.g. EPERM: at least reach the child we own
      } catch {
         // Nothing left to kill.
      }
   }
}

// POSIX only. Does the child's process group still exist? Signal 0 sends
// nothing at all and only reports whether there is something to send to;
// ESRCH means genuinely gone, anything else (EPERM) means it is there but not
// ours to signal.
function groupAlive() {
   if (process.platform === "win32" || !child.pid) return false;
   try {
      process.kill(-child.pid, 0);
      return true;
   } catch (error) {
      return error.code !== "ESRCH";
   }
}

// The child's process group outlived the child that led it. The runner is on
// its way out and nothing else will supervise what is left, so it does not go
// until they do: ask once if nothing has asked yet, watch, then force.
//
// Waiting, rather than killing on the spot, is deliberate. A kill in the reap
// callback needs no probe and so cannot reach a recycled pgid, but it is wrong
// in practice: measured on `kill -TERM <runner pid>`, `npm exec` exits ~0.1 s
// BEFORE the server has finished closing down, so kill-on-reap SIGKILLs a
// perfectly healthy shutdown on the commonest supervisor stop there is.
// Watching costs a pid-recycling window, but only one tick of it: the
// escalation below is reached only if the group answered a probe at EVERY
// sample since the reap, so a recycled pgid would have to appear inside the
// one tick that the real group left in, in a process that also made itself a
// group leader. Short of Linux-only /proc identity checks, that is as small as
// this gets from JS. Windows has no equivalent to any of it: once the child is
// reaped there is no tree left for `taskkill /T` to walk.
const ORPHAN_POLL_MS = 100;

function sweepOrphanedGroup(done) {
   orphanGroupAlive = true;
   process.stderr.write(`demo: npx exited with the server still running; stopping its process group (${child.pid}).\n`);
   if (!stopping) signalGroup("SIGTERM"); // nothing has asked it to stop yet
   const deadline = Date.now() + STOP_GRACE_MS;
   const watch = setInterval(() => {
      const alive = groupAlive();
      if (alive && Date.now() < deadline) return;
      if (alive) signalGroup("SIGKILL"); // out of grace and still holding the ports
      orphanGroupAlive = false;
      clearInterval(watch);
      done();
   }, ORPHAN_POLL_MS);
}

function killTree(pid) {
   try {
      if (process.platform === "win32") {
         spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
      } else {
         signalGroup("SIGKILL");
      }
   } catch {
      // Nothing left to kill.
   }
}

// Every signal a terminal or a supervisor realistically stops a foreground
// process with. SIGQUIT earns its place because Node runs NO exit handler for
// a signal nothing listens for, so `kill -QUIT` would leak the whole group;
// one array entry closes that. The list stops there because what is left is
// either uncatchable (SIGKILL, SIGSTOP — see below) or not a stop signal
// (SIGUSR1 is Node's debugger, SIGWINCH is a resize).
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]) {
   process.on(signal, () => stop(signal));
}

// Belt and braces. A detached child outlives its parent, so any exit path that
// did not already stop the server — an uncaught throw, a `fail()` after the
// spawn, `process.exit()` from the error handler, a second Ctrl-C while the
// orphan sweep is still waiting — has to take the group down on its way out.
// One synchronous kill(2); nothing to await. The two cases it fires in are the
// two where a group kill is still aimed at something known to be ours: the
// child is not reaped yet, or the sweep has been watching its group answer
// probes ever since it was.
//
// What no handler can cover: SIGKILL and SIGSTOP run no code at all, so
// `kill -9` on this runner leaves the server alive and holding both ports. It
// leaked that way before this file spawned detached too — but recovering from
// it got harder, and that part IS new: `detached` calls setsid(), so the
// orphan now sits in its own session instead of the terminal's, where neither
// a second Ctrl-C nor closing the terminal reaches it. Recover by hand:
// `ps -eo pid,pgid,args` prints the pgid, and `kill -9 -<pgid>` clears it.
// The `-e` is what setsid() costs the recovery: a plain `ps` lists only the
// caller's terminal, and this orphan is the one process no longer on it, so
// the recipe without `-e` prints nothing and reads as an all-clear.
process.on("exit", () => {
   if (process.platform === "win32") return;
   if (childExited && !orphanGroupAlive) return;
   signalGroup("SIGKILL");
});

// ---------------------------------------------------------------------------
// 7. Wait for `serving`, then print the URLs and open the dashboard
// ---------------------------------------------------------------------------
async function fetchJson(url) {
   const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
   if (!response.ok) throw new Error(`HTTP ${response.status}`);
   return response.json();
}

async function waitUntilServing() {
   const started = Date.now();
   let reminded = false;
   while (!childExited && !stopping) {
      try {
         const status = await fetchJson(statusUrl);
         if (status.operationalState === "serving") return status;
      } catch {
         // Not listening yet (npx still downloading) or still initializing.
      }
      if (!reminded && Date.now() - started > 60_000) {
         reminded = true;
         process.stdout.write(`demo: still starting (a first run downloads and unpacks the server; give it a minute or two)\n`);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
   }
   return null;
}

async function firstDashboard() {
   if (!first) return null;
   try {
      const list = await fetchJson(
         `${baseUrl}/api/v0/environments/${encodeURIComponent(first.environment)}/packages/${encodeURIComponent(first.package)}/dashboards`,
      );
      const name = Array.isArray(list) ? list.find((d) => d && typeof d.name === "string")?.name : undefined;
      return name ? `${baseUrl}/${first.environment}/${first.package}/dashboards/${name}` : null;
   } catch {
      return null;
   }
}

function openInBrowser(url) {
   try {
      const [command, args] =
         process.platform === "win32" ? ["cmd.exe", ["/d", "/c", "start", "", url]]
         : process.platform === "darwin" ? ["open", [url]]
         : ["xdg-open", [url]];
      const opener = spawn(command, args, { stdio: "ignore", detached: true });
      opener.on("error", () => {});
      opener.unref();
   } catch {
      // No browser is not an error; the URLs are printed.
   }
}

const status = await waitUntilServing();
if (status) {
   serving = true;
   const loadErrors = Array.isArray(status.loadErrors) ? status.loadErrors.length : 0;
   const packages = (status.environments ?? []).flatMap((e) =>
      (e.packages ?? []).map((p) => `${e.name}/${p.name ?? p}`),
   );
   const packageUrl = first ? `${baseUrl}/${first.environment}/${first.package}` : null;
   const dashboardUrl = await firstDashboard();
   const lines = [
      ``,
      `demo: serving${packages.length ? ` ${packages.join(", ")}` : ""} (load_errors=${loadErrors})`,
      `  Console:    ${baseUrl}`,
      ...(packageUrl ? [`  Package:    ${packageUrl}`] : []),
      ...(dashboardUrl ? [`  Dashboard:  ${dashboardUrl}`] : []),
      `  MCP:        ${mcpUrl}`,
      `  Status:     ${statusUrl}`,
      `Press Ctrl-C to stop.`,
      ``,
   ];
   process.stdout.write(lines.join("\n"));
   if (loadErrors > 0) {
      process.stderr.write(`demo: ${loadErrors} package(s) failed to load or are stale; see loadErrors on ${statusUrl}\n`);
   }
   if (opts.open) openInBrowser(dashboardUrl ?? packageUrl ?? baseUrl);
}
