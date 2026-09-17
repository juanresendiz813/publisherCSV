<!--
SPDX-License-Identifier: MIT
-->

# CI/CD for this fork

Three workflows, all keyed on `${{ github.repository }}` — no org, registry or
secret name is hard-coded, so the same files work wherever this repo lands and
for the next project that copies them.

| Workflow | Runs on | What it blocks |
|---|---|---|
| `qa.yml` | PRs, pushes to `development`/`main` | typecheck, lint, prettier; sdk + server test suites; **demo smoke** — the built server must serve the demo package (`.github/ci/smoke.sh`) |
| `sec.yml` | PRs, pushes to `development`/`main`, Mondays | gitleaks over full history; CodeQL (js/ts + python); `bun audit` gate — no critical advisory in production deps beyond `audit-ignore.txt`; actionlint over `.github/workflows` |
| `cd.yml` | `v*` tag push (operator action) or manual dispatch (rehearsal, `sha-*` tag only) | builds the root `Dockerfile`, pushes to `ghcr.io/<owner>/<repo>`, then smokes the pushed image with the demo config mounted |

Shared setup lives in `.github/actions/setup-toolchain` (Bun 1.3.13 from
`.tool-versions`, Node 24, JDK 21, Bun cache, frozen install). Every third-party
action is pinned to a commit SHA with its version in a trailing comment.

## Pointing the smoke at another package

`smoke.sh` takes everything from environment variables (defaults = `examples/nfl-2024`):

```bash
SMOKE_CONFIG=path/to/publisher.config.json \
SMOKE_ENV=examples SMOKE_PACKAGE=my-pkg SMOKE_DASHBOARD=overview \
SMOKE_MODEL=my.malloy SMOKE_SOURCE=orders SMOKE_QUERY=totals \
SMOKE_EXPECT='"order_count":1200;"revenue":98765' \
SMOKE_CHECK_SCRIPT= \
bash .github/ci/smoke.sh
```

- `SMOKE_MODE=boot` (default) starts `packages/server/dist/server.mjs` and waits
  for `PUBLISHER_READY` on stderr (`docs/configuration.md#startup-signals`);
  `SMOKE_MODE=attach` polls an already-running server at `SMOKE_BASE` — that is
  what `cd.yml` uses against the container.
- `SMOKE_EXPECT` is `;`-separated JSON fragments that must all appear in the
  query result; an empty `SMOKE_DASHBOARD` or `SMOKE_CHECK_SCRIPT` skips that step.
- Package `location`s in a config resolve relative to the config file's
  directory, which is why `.github/ci/publisher.config.json` says `../../examples/…`.

To run it locally against a built server on a different port:
`SMOKE_PORT=4300 SMOKE_MCP_PORT=4340 bash .github/ci/smoke.sh`.

## Inherited upstream workflows

| Workflow | What it does | Action | Why |
|---|---|---|---|
| `build.yml` | typecheck, lint/format + drift guards, npx/bun runtime smoke, Docker smoke, calls cross-platform | kept | no secrets; upstream's own gate still adds coverage (Docker build, 3 OSes) |
| `cross-platform-tests.yml` | `workflow_call` — suites on Linux/macOS/Windows | kept | no secrets |
| `app-playwright.yml` | Console browser suite on PRs to `main` | kept | no secrets (injects a stub BigQuery connection only) |
| `k6-tests.yml` | load tests against BigQuery | gated `github.repository == 'malloydata/publisher'` | hard-fails without upstream's `BQ_PRESTO_TRINO_KEY` |
| `connection-integration-tests.yml` | warehouse connection matrix | gated | needs `BQ_PRESTO_TRINO_KEY`, `BIGQUERY_PUBLIC_DATA_SA` |
| `npm-sdk.yml` | publishes `@malloy-publisher/{sdk,app,server}` to npm (OIDC) | **deleted** | pure publishing to upstream's npm scope |
| `docker-image.yml` | publishes `ms2data/malloy-publisher` to Docker Hub | **deleted** | pure publishing; replaced by `cd.yml` → GHCR |
| `release.yml` | version bump + npm + Docker Hub + GitHub Release | **deleted** | upstream's release train; `cd.yml` is ours |
| `skills-npm.yml` | PR version-vs-npm check + publish `@malloy-publisher/skills` | all jobs gated | checks compare against upstream's registry |
| `create-malloy-package-npm.yml` | same for `@malloy-publisher/create-malloy-package` | all jobs gated | same |
| `python-sdk.yml` | PyPI version check, build, publish `malloy-publisher-sdk` | `check_version` + `publish` gated; `build` kept | build needs no secrets |

## Known gaps / follow-ups

1. Switch `SMOKE_CONFIG` to `demo/publisher.config.json` once `feature/one-line-demo` merges; delete `.github/ci/publisher.config.json`.
2. `bun audit` baseline: 10 critical / 128 high overall, 6 critical in production deps (all transitive, listed in `audit-ignore.txt`). Tighten the gate by fixing and removing lines.
3. CodeQL is skipped on a private repo until GitHub Advanced Security is on (`CODEQL_ON_PRIVATE=true` repo variable enables it). gitleaks needs `GITLEAKS_LICENSE` only for org-owned repos.
4. actionlint runs with shellcheck off; turn it on once the inherited workflows are clean under it.
5. `bun install --frozen-lockfile` relies on upstream's lockfile as-is (Bun 1.3.13 accepts it); if the first run rejects it, merge `chore/sync-bun-lock` first.
6. Nothing here has run on GitHub yet — the first real run happens when the operator pushes.
