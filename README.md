<!--
Copyright (c) Credible Data Inc.
SPDX-License-Identifier: MIT
-->

## Try it in one line

```bash
git clone https://github.com/spiculedata/publisherCSV.git && cd publisherCSV && node demo.mjs
```

That is the whole setup. [`demo.mjs`](demo.mjs) needs **Node.js 20 or newer** and nothing else — no
Bun, no build, no `npm install`. It runs the published Publisher server through `npx` (pinned to
`@malloy-publisher/server@0.4.0`), points it at [`demo/publisher.config.json`](demo/publisher.config.json),
waits until the server reports `serving`, prints the URLs and opens the dashboard in your browser.
The first run downloads the server (about 30 MB, plus its dependencies): 2 min 50 s from
`node demo.mjs` to the dashboard on a Windows 11 laptop over home Wi-Fi. Later runs skip the
download and start from the npx cache: 9 s on the same machine, from a fresh clone. Verified on
Windows 11 (Node 24) from Git Bash, from PowerShell, and from a fresh clone with no `node_modules`;
macOS and Linux run the same code path but are untested.

What you get:

- [`examples/nfl-2024`](examples/nfl-2024) — the 2024 NFL season served straight from three CSVs,
  with its filterable dashboard at <http://127.0.0.1:4000/examples/nfl-2024/dashboards/season>
  (Team, Division and Season-phase controls; every tile answers to every control);
- upstream's `storefront` example next to it;
- the Console at <http://127.0.0.1:4000>, the REST API under `/api/v0`, and the MCP endpoint at
  `http://127.0.0.1:4040/mcp` for Claude, Cursor, Codex or an agent of your own.

`Ctrl-C` stops everything — the runner, `npx` and the server, with no port left listening (verified
on Windows 11). `npm run demo` is the same command. Flags: `--port` / `--mcp_port` / `--host`
(defaults 4000 / 4040 / 127.0.0.1), `--no-open`, `--latest` (run `@latest` instead of the pinned
version), `--server_root <dir>` (where the server keeps its storage; default `demo/.run`,
git-ignored and wiped on every start), and `-- <flags>` to hand anything else to the server, e.g.
`node demo.mjs -- --watch-env examples` to live-reload model edits.

One note if you also build from source: in a clone where `bun install` has been run, `npx` spends
about 50 extra seconds walking the installed workspace before the server starts. Point
`--server_root` at a directory outside the clone to skip that — same config, same packages, 8 s
instead of 59 s here.

**Point it at your own package.** `node demo.mjs --package /path/to/my-package` serves any directory
that holds a `publisher.json` ([docs/packages.md](docs/packages.md) is the format) as environment
`demo`; `node demo.mjs --config /path/to/publisher.config.json` uses a config of your own. That is how
another project reuses this repo: keep `demo.mjs`, swap the package.

Everything upstream's README said is preserved at
[docs/UPSTREAM-README.md](docs/UPSTREAM-README.md). The from-source path
(`bun install && bun run build && bun run start`) is unchanged.
