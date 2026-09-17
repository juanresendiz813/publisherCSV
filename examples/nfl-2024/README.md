<!--
SPDX-License-Identifier: MIT
-->

# nfl-2024 — a sports CSV, a Malloy model, a live dashboard

The 2024 NFL season, served by Malloy Publisher straight from three CSV files. No database to
load, no ETL, no credentials: DuckDB reads the CSVs in place, Malloy joins them, and Publisher
renders the views and a filterable dashboard in its Console and over its REST and MCP APIs.

Built in an evening to show the CSV → model → dashboard path on Publisher.

## What's here

| File                       | Role                                                                                                                                                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data/team_week_2024.csv`  | One row per **team per game** (570 rows): that team's box score — passing/rushing yards, turnovers, sacks, and ~130 more columns. Points are not here.                                                           |
| `data/games_2024.csv`      | One row per **game** (285 rows: regular season + playoffs): kickoff, venue, home/away teams and both final scores.                                                                                               |
| `data/teams.csv`           | One row per franchise (36 rows: 32 teams plus four relocated/renamed aliases): full name, conference, division, colors.                                                                                          |
| `nfl.malloy`               | The model: `team_games` joined to `games` and `teams`. One `pick` decides whether a row's team was the home side; wins, points for/against, differential and the home/away split all follow from it.             |
| `dashboards/season.malloy` | The dashboard: KPI strip, points-per-game by week, home vs away win rate, standings, wins by team and a game log — with Team, Division and Season-phase filter controls. Every tile answers to every control.     |
| `capture.mjs`              | Records the 60–90 s walkthrough (package → model → dashboard → filter) with Playwright; see [Record the walkthrough](#record-the-walkthrough).                                                                   |
| `csv-to-malloy.mjs`        | Helper: profile any CSV and scaffold a starter `.malloy` model over it; see [Start a model from your own CSV](#start-a-model-from-your-own-csv).                                                                 |

## Run it

The one-liner, from the repo root (Node ≥ 20, nothing else installed): it runs the published
Publisher server via `npx` against [`demo/publisher.config.json`](../../demo/publisher.config.json),
which lists this package first, and opens the dashboard once the server is serving.

```bash
node demo.mjs
```

Or from source (Node ≥ 20, Bun ≥ 1.3.13, a JDK for the SDK build; on Windows use Git Bash):

```bash
bun install
bun run build
cd packages/server && bun run ./dist/server.mjs --port 4000 --mcp_port 4040 --host 127.0.0.1 --init
```

Either way, poll until it's serving, then open the Console:

```bash
curl -s http://127.0.0.1:4000/api/v0/status | grep -o '"operationalState":"[a-z]*"'   # -> "serving"
```

- Package page: <http://127.0.0.1:4000/examples/nfl-2024> — the three CSVs under **Package Data**, with row counts.
- Model page: <http://127.0.0.1:4000/examples/nfl-2024/nfl.malloy> — pick `team_games` in the source
  picker, open **Views**, **Add** one (`standings`, say) and **Run**.
- Dashboard: <http://127.0.0.1:4000/examples/nfl-2024/dashboards/season> — pick a **Team** and every
  tile re-runs; the choice lands in the URL (`?TEAM=…`), so the filtered page is a link.

The package is registered in `packages/server/publisher.config.json` (the from-source server) and in
`demo/publisher.config.json` (the one-liner) under the `examples` environment beside `storefront`. `--init` is only needed the first time (or after editing the CSVs
or models outside watch mode), because Publisher serves a copy it makes at startup. For live
editing, start with `--watch-env examples --init` once; after that a saved `.malloy` edit reloads
without a restart (a save that fails to compile is skipped and reported under `loadErrors` on
`/api/v0/status`).

Ask it a question over REST (no UI needed):

```bash
API=http://127.0.0.1:4000/api/v0/environments/examples/packages/nfl-2024/models/nfl.malloy/query

curl -s -X POST $API -H 'content-type: application/json' \
  -d '{"sourceName":"team_games","queryName":"standings","compactJson":true}' | head -c 600

curl -s -X POST $API -H 'content-type: application/json' \
  -d '{"query":"run: team_games -> game_log + { where: team_name = \"Philadelphia Eagles\" }","compactJson":true}' | head -c 600
```

Or over MCP, from an agent: _"Use Malloy to show the 2024 NFL home vs away split."_

## The model at a glance

- **Sources:** `team_games` (fact, one row per team per game) with `join_one` to `games` (by
  `game_id`) and twice to `teams` (as the team and as `opponent`).
- **The key dimension:** `home_away is pick 'Home' when games.home_team = team else 'Away'`. From it:
  `points_for`, `points_against`, `point_diff`, `result`.
- **Other dimensions:** `team_name`, `conference`, `division`, `opponent_name`, `week_number`
  (`week` is a Malloy reserved word, so the column is renamed once here), `phase` (regular season /
  playoffs), `game_date`, `total_yards`, `turnovers`.
- **Measures:** `games_played` (distinct games), `wins`, `losses`, `ties`, `win_pct`,
  `total_points_for/against`, `total_point_diff`, `avg_points_for/against`, `high_score`,
  `avg_yards`, `avg_passing_yards`, `avg_rushing_yards`, `total_turnovers`, `total_sacks`.
- **Views:** `standings`, `wins_by_team`, `scoring_by_week`, `home_vs_away`, `home_away_split`,
  `game_log`, `offense_leaders`, `division_standings`, `key_figures`, and `season_overview` (the
  `# dashboard` one-query form of the dashboard).

Two things worth knowing before you copy the pattern: a view cannot share a name with a field of
the source it extends (the dashboard's tiles are `home_away_chart` and `game_log_table`, not
`home_away` and `games`), and standings count the playoffs until the **Season phase** control says
otherwise — the Eagles open at 18-3, not 14-3, and the tile's subtitle says so.

## Record the walkthrough

`capture.mjs` drives a headless Chromium through the four scenes above and writes
`capture/nfl-2024-walkthrough.{webm,mp4,gif}` (git-ignored). It needs the server running and, for
the mp4 and gif, `ffmpeg` on PATH; the raw `.webm` is written either way.

```bash
node examples/nfl-2024/capture.mjs                                        # server on :4000
PUBLISHER_BASE=http://127.0.0.1:4100 node examples/nfl-2024/capture.mjs   # another port
CAPTURE_TEAM="Detroit Lions" node examples/nfl-2024/capture.mjs           # filter to a different team
```

The log prints a timestamp per scene; the pacing is the `sleep`s in the script.

## Start a model from your own CSV

`csv-to-malloy.mjs` is the generic half of this example. It profiles a CSV (type, distinct values,
blanks per column) and writes a starter model: a `duckdb.table()` source, numeric columns as
sum/avg measures (id-looking integers stay dimensions), `row_count`, and three starter views — a
breakdown by the lowest-cardinality category, a monthly trend over the first date column, and a KPI
row. Columns keep their CSV names; only the ones Malloy cannot spell as-is (reserved words such as
`week`, spaces, punctuation) are redeclared.

```bash
cd examples/nfl-2024
node csv-to-malloy.mjs data/games_2024.csv --profile              # the column report only
node csv-to-malloy.mjs data/games_2024.csv                        # the model, on stdout
node csv-to-malloy.mjs data/games_2024.csv --out games_starter.malloy
node csv-to-malloy.mjs big.csv --sample 20000 --name events       # profile more rows; name the source
```

Drop the output into a package next to its CSV and reload (`GET …/packages/<pkg>?reload=true`), or
check it first without saving anything: `--check <model url>` posts the model to that model's
`/compile` endpoint (scope `append`, so it is validated as a new definition beside the existing
model) and prints the diagnostics, exiting 1 on an error:

```bash
node csv-to-malloy.mjs data/games_2024.csv --check \
  http://127.0.0.1:4000/api/v0/environments/examples/packages/nfl-2024/models/nfl.malloy > /dev/null
# -> compile …/compile: HTTP 200 success 0 problem(s)
```

Both CSVs here compile clean that way (`games_2024.csv`: 21 columns → 8 numeric measures, 1
redeclared column; `team_week_2024.csv`: 138 columns → 130 numeric). It is a starting point, not a
finished model: the dimension worth having — this package's `home_away` pick — still needs a person.

## Dataset

[nflverse](https://github.com/nflverse) open data, downloaded 2026-09-16 and trimmed to one season:

- `team_week_2024.csv` = `stats_team_week_2024.csv` from the
  [`nflverse-data` `stats_team` release](https://github.com/nflverse/nflverse-data/releases/tag/stats_team), unchanged.
- `games_2024.csv` = the 2024 rows of `games.csv` from the
  [`nflverse-data` `schedules` release](https://github.com/nflverse/nflverse-data/releases/tag/schedules),
  keeping 21 of its 46 columns (ids, betting lines and QB/coach names dropped).
- `teams.csv` = [`teams_colors_logos.csv`](https://github.com/nflverse/nflverse-pbp/blob/master/teams_colors_logos.csv)
  from `nflverse-pbp`, unchanged.

See the nflverse repositories for the data's terms of use.
