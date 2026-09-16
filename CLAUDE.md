<!--
Copyright (c) Credible Data Inc.
SPDX-License-Identifier: MIT
-->

## Workspace (this is a derived project, not upstream)

This clone is one of several in a multi-agent workspace led by **Maximus** (AGENT LEAD). Coordination
lives OUTSIDE the repo in the shared folder `..\..\Agent Coordination Board\` (relative to this clone's
canonical location at `<workspace>\Repo\publisher`; specialist clones sit at `<workspace>\Agents\<ROLE>\publisher`).
Read there, in order: `TEAM_GUIDE.md` (stack, build/test/run, ports, roster, AUTHORITY MAP, merge pipeline),
`AGENT-BOARD.md` (live status, kanban, claims, log), `KNOWN-GOTCHAS.md` (grep before diagnosing),
`ARCHITECTURE.md` (codebase map). Rules that apply in this clone: work on `feature/|fix/|chore/|test/|security/<slug>`
off `development`, never commit to `development` or `main` directly, pin every git command with `git -C "<this clone>"`,
and hand PRs to Maximus — only Maximus merges. Upstream `malloydata/publisher` is the read-only `upstream` remote;
pull from it only on a logged decision.

## Using Publisher

See @AGENTS.md for how to run Publisher, connect an agent to the MCP endpoint, and use the bundled skills.
