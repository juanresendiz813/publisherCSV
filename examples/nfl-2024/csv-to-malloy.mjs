#!/usr/bin/env node
// SPDX-License-Identifier: MIT

// csv-to-malloy — profile a CSV and scaffold a starter Malloy model over it.
//
//   node csv-to-malloy.mjs data/games_2024.csv                    # model on stdout, profile on stderr
//   node csv-to-malloy.mjs data/games_2024.csv --out games.malloy # write the model next to the CSV
//   node csv-to-malloy.mjs data/games_2024.csv --profile          # column report only
//   node csv-to-malloy.mjs big.csv --sample 20000 --name events   # rows to profile; source name
//   node csv-to-malloy.mjs data/games_2024.csv --check http://127.0.0.1:4000/api/v0/environments/examples/packages/nfl-2024/models/nfl.malloy
//                                                    # also POST the model to that model's /compile endpoint and print the diagnostics
//
// No dependencies. It reads the file, infers each column's type (integer,
// number, date, timestamp, boolean, string), counts distinct values and blanks,
// and writes a model with: a `duckdb.table()` source, numeric columns as
// sum/avg measures (integer columns that look like ids or keys stay
// dimensions), `row_count`, and three starter views — a breakdown by the
// lowest-cardinality category, a monthly trend over the first date column, and
// a KPI row. Columns are referenced by their CSV names; only the ones Malloy
// cannot spell as-is (reserved words, spaces, punctuation) are redeclared.
//
// It is a starting point to edit, not a finished model: the dimension worth
// having — nfl.malloy's `home_away` pick, say — still needs a person.

import { readFileSync, writeFileSync } from "node:fs";
import { basename, relative, dirname, resolve } from "node:path";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
if (!file) {
  console.error("usage: csv-to-malloy <file.csv> [--out model.malloy] [--profile] [--sample N] [--name source_name] [--check <model url>]");
  process.exit(2);
}
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : dflt;
};
const SAMPLE = Number(opt("sample", 5000));
const OUT = opt("out", null);
const PROFILE_ONLY = args.includes("--profile");
const CHECK = opt("check", null);

// ── CSV parsing (RFC 4180-ish: quotes, escaped quotes, newlines in quotes) ──
function parseCsv(text, limit) {
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      if (rows.length > limit) break;
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ── Type inference ──────────────────────────────────────────────────────────
const RE_INT = /^-?\d{1,18}$/;
const RE_NUM = /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RE_TS = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const RE_BOOL = /^(true|false)$/i;

function inferColumn(name, values) {
  const present = values.filter((v) => v !== "" && v != null);
  const nulls = values.length - present.length;
  const distinct = new Set(present).size;
  const all = (re) => present.length > 0 && present.every((v) => re.test(v));
  let type = "string";
  if (all(RE_INT)) type = "integer";
  else if (all(RE_NUM)) type = "number";
  else if (all(RE_DATE)) type = "date";
  else if (all(RE_TS)) type = "timestamp";
  else if (all(RE_BOOL)) type = "boolean";
  // An integer column that is unique per row, or named like an id, is a key,
  // not a quantity: nobody wants the sum of `game_id` or the average `season`.
  const looksId = /(^|_)(id|key|code|number|no|num|year|season|week)$/i.test(name);
  const isKey = type === "integer" && (looksId || (present.length > 20 && distinct === present.length));
  const sample = [...new Set(present)].slice(0, 3);
  return { name, type, nulls, distinct, count: values.length, isKey, sample };
}

// ── Malloy emit ─────────────────────────────────────────────────────────────
// Words Malloy will not accept as a bare field name. Over-listing is harmless:
// a column on this list is redeclared under a new name, nothing more.
const RESERVED = new Set(["week", "year", "month", "day", "hour", "minute", "second", "quarter", "date", "timestamp", "source", "query", "view", "dimension", "measure", "join", "is", "pick", "when", "else", "select", "group_by", "aggregate", "order_by", "limit", "top", "where", "having", "nest", "run", "import", "extend", "all", "and", "or", "not", "null", "true", "false", "count", "sum", "avg", "min", "max", "by", "asc", "desc", "cast", "as", "to", "for", "with", "on", "primary_key", "index", "sql", "table", "declare", "number", "string", "boolean", "exclude", "calculate", "sample"]);
const isPlain = (n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n) && !RESERVED.has(n.toLowerCase());
const quoted = (n) => `\`${n.replace(/`/g, "")}\``;
const snake = (n) => n.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "col";
const label = (n) => n.replace(/[_\s]+/g, " ").trim().replace(/^\w/, (c) => c.toUpperCase());

// The Malloy name each column is reached by: its own name when Malloy can
// spell it, else the redeclared one (`week` -> `week_value`, `Total Yards` ->
// `total_yards`).
function fieldNames(cols) {
  const taken = new Set(cols.map((c) => c.name));
  return new Map(cols.map((c) => {
    if (isPlain(c.name)) return [c.name, c.name];
    let nm = snake(c.name);
    if (RESERVED.has(nm) || taken.has(nm)) nm = `${nm}_value`;
    return [c.name, nm];
  }));
}

function emitModel(cols, csvPath, sourceName) {
  const names = fieldNames(cols);
  const f = (c) => names.get(c.name);
  const renamed = cols.filter((c) => f(c) !== c.name);
  const nums = cols.filter((c) => (c.type === "integer" || c.type === "number") && !c.isKey);
  const cats = cols.filter((c) => (c.type === "string" || c.type === "boolean") && c.distinct >= 2 && c.distinct <= 60);
  const dates = cols.filter((c) => c.type === "date" || c.type === "timestamp");
  const asIs = cols.filter((c) => f(c) === c.name);
  const firstNum = nums[0];
  const metric = firstNum ? `total_${snake(firstNum.name)}` : "row_count";
  const metricLabel = firstNum ? `total ${label(firstNum.name).toLowerCase()}` : "rows";

  const L = [];
  L.push(`// Generated by csv-to-malloy from ${basename(csvPath)} — a starting point, edit freely.`);
  L.push(`// ${cols.length} columns profiled: ${nums.length} numeric (measures), ${cols.length - nums.length} dimensions.`);
  L.push("");
  L.push(`#(doc) One row per line of ${basename(csvPath)}`);
  L.push(`source: ${sourceName} is duckdb.table('${csvPath.replace(/\\/g, "/")}') extend {`);
  if (asIs.length) {
    L.push("");
    L.push("  // Columns used under their CSV names (already fields of the source):");
    for (const t of ["string", "date", "timestamp", "boolean", "integer", "number"]) {
      const group = asIs.filter((c) => c.type === t);
      if (group.length) L.push(`  //   ${t}: ${group.map((c) => c.name).join(", ")}`);
    }
  }
  if (renamed.length) {
    L.push("");
    L.push("  // Columns Malloy cannot name as-is (reserved words, spaces, punctuation), redeclared:");
    L.push("  dimension:");
    for (const c of renamed) {
      L.push(`    #(doc) ${label(c.name)} (${c.type}, ${c.distinct} distinct${c.nulls ? `, ${c.nulls} blank` : ""})`);
      L.push(`    # label="${label(c.name)}"`);
      L.push(`    ${f(c)} is ${quoted(c.name)}`);
    }
  }
  L.push("");
  L.push("  measure:");
  L.push(`    #(doc) Number of rows`);
  L.push(`    # label="Rows"`);
  L.push(`    row_count is count()`);
  for (const c of nums) {
    const ref = f(c) === c.name && !isPlain(c.name) ? quoted(c.name) : f(c);
    const nm = snake(c.name);
    const lc = label(c.name).toLowerCase();
    L.push(`    #(doc) Total ${lc}${c.nulls ? ` (${c.nulls} of ${c.count} sampled rows blank)` : ""}`);
    L.push(`    # label="Total ${lc}"`);
    L.push(`    total_${nm} is ${ref}.sum()`);
    L.push(`    #(doc) Average ${lc} per row`);
    L.push(`    # number="#,##0.0"`);
    L.push(`    # label="Avg ${lc}"`);
    L.push(`    avg_${nm} is ${ref}.avg()`);
  }
  L.push("");
  // Starter views: a breakdown by the lowest-cardinality category, a trend
  // over the first date column if there is one, and a KPI row.
  const cat = [...cats].sort((a, b) => a.distinct - b.distinct)[0];
  if (cat) {
    L.push(`  #(doc) ${label(metricLabel)} by ${label(cat.name).toLowerCase()}`);
    L.push(`  # bar_chart`);
    L.push(`  view: by_${snake(cat.name)} is {`);
    L.push(`    group_by: ${f(cat)}`);
    L.push(`    aggregate: ${metric}`);
    L.push(`    order_by: ${metric} desc`);
    L.push(`  }`);
    L.push("");
  }
  if (dates[0]) {
    const d = dates[0];
    L.push(`  #(doc) ${label(metricLabel)} by month of ${label(d.name).toLowerCase()}`);
    L.push(`  # line_chart`);
    L.push(`  view: by_month is {`);
    L.push(`    group_by:`);
    L.push(`      # label="Month"`);
    L.push(`      ${snake(d.name)}_month is ${f(d)}.month`);
    L.push(`    aggregate: ${metric}`);
    L.push(`    order_by: ${snake(d.name)}_month`);
    L.push(`  }`);
    L.push("");
  }
  L.push(`  #(doc) Rows and the first few averages, for a KPI strip`);
  L.push(`  view: key_figures is {`);
  L.push(`    aggregate: row_count${nums.slice(0, 4).map((c) => `, avg_${snake(c.name)}`).join("")}`);
  L.push(`  }`);
  L.push("}");
  return L.join("\n") + "\n";
}

// ── Main ────────────────────────────────────────────────────────────────────
const text = readFileSync(file, "utf8").replace(/^﻿/, "");
const rows = parseCsv(text, SAMPLE);
if (rows.length < 2) {
  console.error(`${file}: no data rows`);
  process.exit(1);
}
const header = rows[0];
const body = rows.slice(1);
const cols = header.map((name, i) => inferColumn(name, body.map((r) => r[i] ?? "")));

const profile = cols
  .map((c) => `${c.name.padEnd(30)} ${c.type.padEnd(9)} distinct=${String(c.distinct).padEnd(6)} blank=${String(c.nulls).padEnd(5)}${c.isKey ? " key " : "     "} e.g. ${c.sample.join(" | ")}`)
  .join("\n");
console.error(`${basename(file)}: ${body.length} rows profiled, ${cols.length} columns\n${profile}\n`);
if (PROFILE_ONLY) process.exit(0);

const sourceName = opt("name", snake(basename(file).replace(/\.csv$/i, "")));
const csvPath = OUT ? relative(dirname(resolve(OUT)), resolve(file)) : file;
const model = emitModel(cols, csvPath, sourceName);
if (OUT) {
  writeFileSync(OUT, model);
  console.error(`wrote ${OUT}`);
} else process.stdout.write(model);

// --check: compile the model against a running Publisher without saving
// anything, via the model's /compile endpoint with scope "append" (the source
// is validated as a NEW definition beside the model named in the URL). Exit 1
// on any error-severity problem so the flag works in a script.
if (CHECK) {
  const url = `${CHECK.replace(/\/+$/, "")}/compile`;
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: model, scope: "append" }) });
  const body = await res.json().catch(() => ({}));
  const problems = body.problems ?? [];
  console.error(`compile ${url}: HTTP ${res.status} ${body.status ?? ""} ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  ${p.severity ?? "?"} ${p.line ?? "?"}:${p.column ?? "?"} ${p.message}`);
  if (!res.ok || problems.some((p) => p.severity === "error")) process.exit(1);
}
