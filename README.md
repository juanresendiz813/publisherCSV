<!--
Copyright (c) Credible Data Inc.
SPDX-License-Identifier: MIT
-->

# publisherCSV

[![qa](https://github.com/juanresendiz813/publisherCSV/actions/workflows/qa.yml/badge.svg)](https://github.com/juanresendiz813/publisherCSV/actions/workflows/qa.yml)
[![sec](https://github.com/juanresendiz813/publisherCSV/actions/workflows/sec.yml/badge.svg)](https://github.com/juanresendiz813/publisherCSV/actions/workflows/sec.yml)

**Raw CSVs → a Malloy model → a live, filterable dashboard, served over REST and MCP, from one
command.**

This is my fork of [Malloy Publisher](https://github.com/malloydata/publisher), carrying a showcase
the upstream repo does not: a self-contained NFL-season package built from three raw CSV files, plus
a `demo.mjs` runner that boots the published Publisher server and opens the dashboard with no build,
no database and no credentials. It is for anyone evaluating Publisher or Malloy who wants to see the
whole path end to end in a couple of minutes, and for anyone who wants to serve their *own* CSV
package the same way — `demo.mjs --package` is the seam. Derived from
[malloydata/publisher](https://github.com/malloydata/publisher), MIT-licensed, tracking upstream
deliberately rather than automatically.

## Try it in one line

```bash
git clone https://github.com/juanresendiz813/publisherCSV.git && cd publisherCSV && node demo.mjs
```

That is the whole setup. [`demo.mjs`](demo.mjs) needs **Node.js 20 or newer** and nothing else — no
Bun, no build, no `npm install`. It runs the published Publisher server through `npx` (pinned to
`@malloy-publisher/server@0.4.0`), points it at [`demo/publisher.config.json`](demo/publisher.config.json),
waits until the server reports `serving`, prints the URLs and opens the dashboard in your browser.
The first run downloads the server (about 30 MB, plus its dependencies): 2 min 50 s from
`node demo.mjs` to the dashboard on a Windows 11 laptop over home Wi-Fi. Later runs skip the
download and start from the npx cache: 9 s on the same machine, from a fresh clone. Verified on
Windows 11 (Node 24) from Git Bash, from PowerShell, and from a fresh clone with no `node_modules`,
and on Ubuntu 24.04 under WSL2 (Node 22), cloning this repo from GitHub into the Linux filesystem:
2 min 8 s cold, 8.6 s warm, same dashboard and same numbers. That is WSL2 rather than a bare-metal
Linux box; macOS runs the same code path but is untested.

`Ctrl-C` stops everything — the runner, `npx` and the server, with no port left listening — and so
does stopping it from outside the terminal, the way a supervisor or a CI job does: `kill -INT` or
`kill -TERM` on the runner's PID on Linux, `taskkill /pid <pid> /T /F` (a tree kill) on Windows.
Both verified on Windows 11 and on Ubuntu 24.04 under WSL2. The runner forwards the signal it was
sent and the published server handles only `SIGTERM`, so a `SIGINT` stop frees both ports without
logging the worker-pool drain a `kill -TERM` logs — fewer lines on the way out, not a worse stop.
`kill -9` is the exception, because nothing can run on `SIGKILL`: it leaves the server behind, still
holding both ports, and on Linux that orphan is in a session of its own where a second `Ctrl-C` and
closing the terminal will not reach it. Clear it by hand:
`ps -eo pid,pgid,args | grep malloy-publisher` prints the server's `npm exec` and `node` rows and
the pgid they share, then `kill -9 -<pgid>` clears it. The `-e` is not optional — a plain `ps` lists
only the processes on your own terminal, and this orphan is precisely the one that no longer has
one. `npm run demo` is the same command. Flags: `--port` / `--mcp_port` / `--host`
(defaults 4000 / 4040 / 127.0.0.1), `--no-open`, `--latest` (run `@latest` instead of the pinned
version), `--server_root <dir>` (where the server keeps its storage; default `demo/.run`,
git-ignored and wiped on every start), and `-- <flags>` to hand anything else to the server, e.g.
`node demo.mjs -- --watch-env examples` to live-reload model edits. `node demo.mjs --help` prints
the list.

One note if you also build from source: in a clone where `bun install` has been run, `npx` spends
about 50 extra seconds walking the installed workspace first. Point `--server_root` at a directory
outside the clone to skip that — same config, same packages, 8 s instead of 59 s here.

## What you get

[`examples/nfl-2024`](examples/nfl-2024) is the 2024 NFL season served straight from three
[nflverse](https://github.com/nflverse) CSVs — 285 games, 570 team-games, and 32 franchises (36 team
rows: four are legacy aliases for relocated or renamed clubs). DuckDB reads them in place, one
Malloy model joins them, and Publisher renders **10 views** and a **6-tile dashboard** with Team,
Division and Season-phase controls; every tile answers to every control, and the choice lands in
the URL, so a filtered view is a link. The numbers it lands on: the Eagles at 18-3 including the
playoffs, home teams winning 54.7% of games, 23.0 points per team per game.

Once it is serving:

- **Dashboard** — <http://127.0.0.1:4000/examples/nfl-2024/dashboards/season>
- **Console** — <http://127.0.0.1:4000> (browse packages, models, views; upstream's `storefront`
  example sits next to ours)
- **REST** — everything the Console does is under `/api/v0`, and the server publishes its own
  OpenAPI spec at <http://127.0.0.1:4000/api-doc.yaml>
- **MCP** — `http://127.0.0.1:4040/mcp`, so Claude, Cursor, Codex or an agent of your own can ask
  the model questions directly

```bash
curl -s http://127.0.0.1:4000/api/v0/status | grep -o '"operationalState":"[a-z]*"'   # -> "serving"
```

[`examples/nfl-2024/README.md`](examples/nfl-2024/README.md) is the walkthrough: what each CSV
holds, how the model's one `pick` decides which side was home (wins, points for and against and the
home/away split all follow from it), every view and tile, the REST calls that reproduce the numbers
above, and the two gotchas worth knowing before copying the pattern. The same folder holds
[`capture.mjs`](examples/nfl-2024/capture.mjs), which records a 72-second package → model →
dashboard → filter walkthrough with Playwright, and
[`csv-to-malloy.mjs`](examples/nfl-2024/csv-to-malloy.mjs), below. The clip itself is a git-ignored
build artifact rather than a committed file — run the script to make your own.

<!-- Walkthrough video: link it here once it is hosted. -->

## Bring your own CSV

The demo runner is not nfl-specific. Any directory holding a `publisher.json` is a package it can
serve:

```bash
node demo.mjs --package /path/to/my-package        # served as environment "demo"
node demo.mjs --config /path/to/publisher.config.json   # or bring a whole config
```

[docs/packages.md](docs/packages.md) is the package format. If you have a CSV but no model yet,
`csv-to-malloy.mjs` writes the first draft — it profiles the file (types, distinct values, blanks
per column) and emits a `duckdb.table()` source with measures, a `row_count`, and three starter
views:

```bash
node examples/nfl-2024/csv-to-malloy.mjs orders.csv --profile            # the column report only
node examples/nfl-2024/csv-to-malloy.mjs orders.csv --out orders.malloy  # the starter model
node examples/nfl-2024/csv-to-malloy.mjs orders.csv --check \
  http://127.0.0.1:4000/api/v0/environments/examples/packages/nfl-2024/models/nfl.malloy
```

`--check` posts the generated model to a running server's `/compile` endpoint and prints the
diagnostics, exiting non-zero on an error, so you find out it compiles before you save anything. It
is a starting point, not a finished model: the dimension worth having still needs a person.

## From source

The one-liner runs the *published* server. To build this repo instead:

```bash
bun install
bun run build
bun run start        # REST + Console on :4000, MCP on :4040
```

Prerequisites: **Node.js 20+**, **Bun 1.3.13+**, and a **JDK 21** — the JDK is used only by
`build:sdk`, for the OpenAPI client generator. On Windows, build from **Git Bash**; the npm scripts
are POSIX shell. [docs/development.md](docs/development.md) is upstream's fuller guide.

Docker is the other from-source path: the root [`Dockerfile`](Dockerfile) builds the image, and
[`docker-compose.example.yml`](docker-compose.example.yml) is a starting compose file. Keep the
server on loopback or behind an authenticating gateway — see Security below.

## CI/CD

Three workflows, all keyed on `${{ github.repository }}`, so nothing hard-codes an org or a
registry:

| Workflow | Runs on | What it blocks |
|---|---|---|
| `qa.yml` | PRs, pushes to `development` / `main` | typecheck, lint, prettier; sdk + server test suites; a demo smoke run that boots the built server and asserts the nfl-2024 package actually serves |
| `sec.yml` | PRs, pushes to `development` / `main`, Mondays | gitleaks over full history; CodeQL (js/ts + python); a `bun audit` gate on production criticals; actionlint |
| `cd.yml` | a `v*` tag push, or manual dispatch | builds the root `Dockerfile`, pushes to `ghcr.io/<owner>/<repo>`, then smokes the pushed image by digest |

[`.github/ci/README.md`](.github/ci/README.md) has the details — how to point the smoke script at
another package, which inherited upstream workflows I kept, gated or deleted, and the audit
allowlist with a reason per entry.

Two things have to be set on the GitHub repo before the first run is green: a `GITLEAKS_LICENSE`
secret (gitleaks fails closed on org-owned repos), and CodeQL's *default setup* left **off**, since
`sec.yml` runs CodeQL itself and the two conflict.

## Layout

```
demo.mjs                 the one-liner runner (zero dependencies, Node 20+)
demo/                    publisher.config.json it serves; demo/.run is scratch, git-ignored
examples/nfl-2024/       our showcase: 3 CSVs, nfl.malloy, dashboards/, capture.mjs, csv-to-malloy.mjs
examples/                upstream's example packages (storefront, governed-analytics, html-data-app, data-app)
packages/                the engine: server (REST + MCP), app (Console), sdk, cli, skills, python-client
.github/                 workflows (qa, sec, cd), the shared toolchain action, and ci/ scripts
docs/                    upstream's reference docs, plus UPSTREAM-README.md
```

## Upstream

Malloy Publisher is the analytics engine for [Malloy](https://malloydata.dev): you write down what
your data means once — sources, joins, measures, who may see what — and the server hands that one
model to every surface, over REST to applications and BI tools and over MCP to agents, so queries
compose against the model instead of against raw tables. It is created and maintained by
[Credible](https://www.credibledata.com) and licensed MIT.

Upstream's own documentation is unchanged in [`docs/`](docs/) — start at its
[index](docs/README.md) — and upstream's README is preserved as
[docs/UPSTREAM-README.md](docs/UPSTREAM-README.md). This fork tracks upstream by deliberate,
recorded decision, never automatically: upstream is a read-only remote here, and I do not send
changes back to it.

## License

MIT, inherited from [malloydata/publisher](https://github.com/malloydata/publisher)
(Credible Data Inc.) — see [LICENSE](LICENSE). SPDX headers stay on inherited files.

## Security

The server is stateless and **unauthenticated** on both ports, and it can read any data the models
connect to. Keep it on loopback (`--host 127.0.0.1`, which `demo.mjs` passes by default) and put an
authenticating gateway in front before exposing it further. To report a vulnerability, see
[SECURITY.md](SECURITY.md).
