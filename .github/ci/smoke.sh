#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# smoke.sh — boot (or attach to) a Publisher server and prove one package is
# really served: status is "serving" with no load errors, the dashboard is
# discovered, a named query returns known numbers, and the CSV helper's
# --check round-trip compiles against the live model.
#
# Every input is an environment variable so another package (project #2) only
# changes inputs, never this file. Defaults describe examples/nfl-2024.
#
#   SMOKE_MODE           boot | attach            (boot: start the server below; attach: a server already answers at SMOKE_BASE)
#   SMOKE_BASE           http://127.0.0.1:4000    (attach only; boot derives it from SMOKE_HOST/SMOKE_PORT)
#   SMOKE_HOST           127.0.0.1
#   SMOKE_PORT           4000
#   SMOKE_MCP_PORT       4040
#   SMOKE_RUNTIME        node | bun               (what runs the bundle in boot mode)
#   SMOKE_SERVER         packages/server/dist/server.mjs
#   SMOKE_CONFIG         .github/ci/publisher.config.json
#   SMOKE_SERVER_ROOT    (a fresh mktemp -d)      (where the server writes publisher.db + publisher_data)
#   SMOKE_LOG            $RUNNER_TEMP/publisher-smoke.log, else /tmp/publisher-smoke.log
#   SMOKE_READY_TIMEOUT  300                      (seconds to wait for PUBLISHER_READY / serving)
#   SMOKE_ENV            examples
#   SMOKE_PACKAGE        nfl-2024
#   SMOKE_DASHBOARD      season                   (empty string skips the dashboard assertion)
#   SMOKE_MODEL          nfl.malloy
#   SMOKE_SOURCE         team_games
#   SMOKE_QUERY          key_figures
#   SMOKE_EXPECT         '"games_played":285;"total_turnovers":691'
#                                                 (';'-separated fragments that must all appear in the query result)
#   SMOKE_CHECK_SCRIPT   examples/nfl-2024/csv-to-malloy.mjs   (empty string skips the --check step)
#   SMOKE_CHECK_CSV      examples/nfl-2024/data/games_2024.csv
#
# Boot mode waits on the documented startup-signal contract
# (docs/configuration.md#startup-signals): PUBLISHER_READY on stderr means
# serving, PUBLISHER_INIT_FAILED means stop waiting. Attach mode polls
# /api/v0/status instead, because a container's stderr is not ours to tail.
#
# Only curl, grep and node are needed — no jq — so the same script runs on a
# GitHub runner and in Git Bash on Windows.

set -euo pipefail

SMOKE_MODE="${SMOKE_MODE:-boot}"
SMOKE_HOST="${SMOKE_HOST:-127.0.0.1}"
SMOKE_PORT="${SMOKE_PORT:-4000}"
SMOKE_MCP_PORT="${SMOKE_MCP_PORT:-4040}"
SMOKE_RUNTIME="${SMOKE_RUNTIME:-node}"
SMOKE_SERVER="${SMOKE_SERVER:-packages/server/dist/server.mjs}"
SMOKE_CONFIG="${SMOKE_CONFIG:-.github/ci/publisher.config.json}"
SMOKE_LOG="${SMOKE_LOG:-${RUNNER_TEMP:-/tmp}/publisher-smoke.log}"
SMOKE_READY_TIMEOUT="${SMOKE_READY_TIMEOUT:-300}"
SMOKE_ENV="${SMOKE_ENV:-examples}"
SMOKE_PACKAGE="${SMOKE_PACKAGE:-nfl-2024}"
SMOKE_DASHBOARD="${SMOKE_DASHBOARD-season}"
SMOKE_MODEL="${SMOKE_MODEL:-nfl.malloy}"
SMOKE_SOURCE="${SMOKE_SOURCE:-team_games}"
SMOKE_QUERY="${SMOKE_QUERY:-key_figures}"
SMOKE_EXPECT="${SMOKE_EXPECT-\"games_played\":285;\"total_turnovers\":691}"
SMOKE_CHECK_SCRIPT="${SMOKE_CHECK_SCRIPT-examples/nfl-2024/csv-to-malloy.mjs}"
SMOKE_CHECK_CSV="${SMOKE_CHECK_CSV-examples/nfl-2024/data/games_2024.csv}"

if [ "$SMOKE_MODE" = "boot" ]; then
  SMOKE_BASE="http://${SMOKE_HOST}:${SMOKE_PORT}"
else
  SMOKE_BASE="${SMOKE_BASE:-http://127.0.0.1:4000}"
fi

PKG_API="${SMOKE_BASE}/api/v0/environments/${SMOKE_ENV}/packages/${SMOKE_PACKAGE}"
MODEL_API="${PKG_API}/models/${SMOKE_MODEL}"

SERVER_PID=""
fail() {
  echo "SMOKE FAIL: $*" >&2
  if [ -n "$SERVER_PID" ] && [ -f "$SMOKE_LOG" ]; then
    echo "--- last 60 lines of ${SMOKE_LOG} ---" >&2
    tail -n 60 "$SMOKE_LOG" >&2 || true
  fi
  exit 1
}
ok() { echo "ok: $*"; }

cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    # Give the worker pool a moment to follow its parent down.
    sleep 1
    kill -9 "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# ---------------------------------------------------------------- 1. server
if [ "$SMOKE_MODE" = "boot" ]; then
  [ -f "$SMOKE_SERVER" ] || fail "server bundle not found at ${SMOKE_SERVER} (run 'bun run build' first)"
  [ -f "$SMOKE_CONFIG" ] || fail "config not found at ${SMOKE_CONFIG}"
  SMOKE_SERVER_ROOT="${SMOKE_SERVER_ROOT:-$(mktemp -d)}"
  mkdir -p "$SMOKE_SERVER_ROOT" "$(dirname "$SMOKE_LOG")"
  : > "$SMOKE_LOG"
  echo "booting: ${SMOKE_RUNTIME} ${SMOKE_SERVER} --config ${SMOKE_CONFIG} --host ${SMOKE_HOST} --port ${SMOKE_PORT} --mcp_port ${SMOKE_MCP_PORT} --init --no-mcp-config --server_root ${SMOKE_SERVER_ROOT}"
  "$SMOKE_RUNTIME" "$SMOKE_SERVER" \
    --config "$SMOKE_CONFIG" \
    --host "$SMOKE_HOST" --port "$SMOKE_PORT" --mcp_port "$SMOKE_MCP_PORT" \
    --init --no-mcp-config \
    --server_root "$SMOKE_SERVER_ROOT" \
    > "$SMOKE_LOG" 2>&1 &
  SERVER_PID=$!
  echo "server pid ${SERVER_PID}; log ${SMOKE_LOG}"

  i=0
  while :; do
    if grep -q "PUBLISHER_INIT_FAILED" "$SMOKE_LOG"; then
      fail "server printed PUBLISHER_INIT_FAILED: $(grep -m1 'PUBLISHER_INIT_FAILED' "$SMOKE_LOG")"
    fi
    if grep -q "PUBLISHER_UNSUPPORTED_NODE" "$SMOKE_LOG"; then
      fail "$(grep -m1 'PUBLISHER_UNSUPPORTED_NODE' "$SMOKE_LOG")"
    fi
    if grep -q "PUBLISHER_READY" "$SMOKE_LOG"; then
      READY_LINE="$(grep -m1 'PUBLISHER_READY' "$SMOKE_LOG")"
      echo "$READY_LINE"
      case "$READY_LINE" in
        *"load_errors=0"*) ok "PUBLISHER_READY after ${i}s with load_errors=0" ;;
        *) fail "PUBLISHER_READY reports load errors: ${READY_LINE}" ;;
      esac
      break
    fi
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      fail "server process exited before PUBLISHER_READY"
    fi
    if [ "$i" -ge "$SMOKE_READY_TIMEOUT" ]; then
      fail "no PUBLISHER_READY within ${SMOKE_READY_TIMEOUT}s"
    fi
    sleep 1
    i=$((i + 1))
  done
else
  echo "attaching to ${SMOKE_BASE}"
  i=0
  while :; do
    status="$(curl -sf "${SMOKE_BASE}/api/v0/status" 2>/dev/null || true)"
    case "$status" in
      *'"operationalState":"serving"'*) ok "serving after ${i}s"; break ;;
    esac
    if [ "$i" -ge "$SMOKE_READY_TIMEOUT" ]; then
      fail "${SMOKE_BASE}/api/v0/status did not report serving within ${SMOKE_READY_TIMEOUT}s (last: ${status:0:300})"
    fi
    sleep 1
    i=$((i + 1))
  done
fi

# ---------------------------------------------------------------- 2. status
status="$(curl -sf "${SMOKE_BASE}/api/v0/status")" || fail "GET /api/v0/status failed"
case "$status" in
  *'"operationalState":"serving"'*) ok 'status.operationalState == "serving"' ;;
  *) fail "status is not serving: ${status:0:300}" ;;
esac
case "$status" in
  *'"loadErrors"'*) fail "status carries a loadErrors key: $(printf '%s' "$status" | grep -o '"loadErrors":\[[^]]*\]' | head -c 600)" ;;
  *) ok "status has no loadErrors key" ;;
esac
case "$status" in
  *"\"name\":\"${SMOKE_PACKAGE}\""*) ok "package ${SMOKE_PACKAGE} listed on status" ;;
  *) fail "package ${SMOKE_PACKAGE} missing from status" ;;
esac

# ------------------------------------------------------------ 3. dashboards
if [ -n "$SMOKE_DASHBOARD" ]; then
  dashboards="$(curl -sf "${PKG_API}/dashboards")" || fail "GET ${PKG_API}/dashboards failed"
  case "$dashboards" in
    *"\"name\":\"${SMOKE_DASHBOARD}\""*) ok "dashboard ${SMOKE_DASHBOARD} discovered" ;;
    *) fail "dashboard ${SMOKE_DASHBOARD} not in ${PKG_API}/dashboards: ${dashboards:0:300}" ;;
  esac
fi

# ----------------------------------------------------------------- 4. query
body="{\"sourceName\":\"${SMOKE_SOURCE}\",\"queryName\":\"${SMOKE_QUERY}\",\"compactJson\":true}"
result="$(curl -sf -X POST "${MODEL_API}/query" -H 'content-type: application/json' -d "$body")" \
  || fail "POST ${MODEL_API}/query ${body} failed"
# The result is a JSON string inside the envelope, so its quotes arrive
# escaped (\"games_played\":285). Strip the backslashes before matching.
flat="$(printf '%s' "$result" | tr -d '\\')"
IFS=';' read -r -a fragments <<< "$SMOKE_EXPECT"
for frag in "${fragments[@]}"; do
  [ -n "$frag" ] || continue
  if printf '%s' "$flat" | grep -qF -- "$frag"; then
    ok "query ${SMOKE_SOURCE}->${SMOKE_QUERY} contains ${frag}"
  else
    fail "query ${SMOKE_SOURCE}->${SMOKE_QUERY} lacks ${frag}: $(printf '%s' "$flat" | grep -o '"result":"[^"]*"' | head -c 400)"
  fi
done

# ------------------------------------------------------------ 5. --check
if [ -n "$SMOKE_CHECK_SCRIPT" ]; then
  [ -f "$SMOKE_CHECK_SCRIPT" ] || fail "check script not found: ${SMOKE_CHECK_SCRIPT}"
  [ -f "$SMOKE_CHECK_CSV" ] || fail "check CSV not found: ${SMOKE_CHECK_CSV}"
  if node "$SMOKE_CHECK_SCRIPT" "$SMOKE_CHECK_CSV" --check "$MODEL_API" > /dev/null; then
    ok "csv-to-malloy --check compiled ${SMOKE_CHECK_CSV} against ${SMOKE_MODEL}"
  else
    fail "node ${SMOKE_CHECK_SCRIPT} ${SMOKE_CHECK_CSV} --check ${MODEL_API} exited non-zero"
  fi
fi

echo "SMOKE OK: ${SMOKE_PACKAGE} served by ${SMOKE_BASE}"
