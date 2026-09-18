// Copyright (c) Credible Data Inc.
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MalloyTranslator } from "@malloydata/malloy";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { renderProfiledModel } from "./model";
import {
   profileDataFile,
   type Column,
   type ColumnType,
   type Profile,
} from "./profile";

let tmp: string;

beforeEach(() => {
   tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-model-"));
});

afterEach(() => {
   fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * The parse-stage compile check, and the unit-test replacement for running a
 * server. It is the same technique names.spec.ts uses on source names, applied
 * to the whole generated model.
 *
 * What it proves and what it does not, precisely, because the difference decides
 * which failures the e2e suite still has to catch: a reserved word used bare as
 * a field name IS an error here, with no dialect and no connection, because the
 * grammar rejects it. A column that does not exist in the file is NOT -- that
 * needs real schema resolution against a real DuckDB, which is why
 * tests/e2e/scaffold.e2e.spec.ts boots a server over a seeded CSV.
 */
function parseProblems(model: string): string[] {
   const url = "file://generated.malloy";
   const translator = new MalloyTranslator(url, null, {
      urls: { [url]: model },
   });
   return (translator.translate().problems ?? [])
      .filter((problem) => problem.severity === "error")
      .map((problem) => problem.message);
}

function expectCompiles(model: string): void {
   expect(parseProblems(model)).toEqual([]);
}

function col(name: string, over: Partial<Column> = {}): Column {
   return {
      name,
      type: "string" as ColumnType,
      distinct: 5,
      nulls: 0,
      isKey: false,
      ...over,
   };
}

function prof(columns: Column[], over: Partial<Profile> = {}): Profile {
   return { columns, rowsProfiled: 100, truncated: false, ...over };
}

function render(profile: Profile): string {
   return renderProfiledModel(profile, {
      sourceName: "shop",
      dataPath: "data/orders.csv",
   });
}

/** Profile a CSV written for the test, so the two halves are exercised together. */
function renderCsv(contents: string): string {
   const file = path.join(tmp, "orders.csv");
   fs.writeFileSync(file, contents);
   const profile = profileDataFile(file);
   if (profile === undefined) {
      throw new Error("expected the fixture CSV to profile");
   }
   return render(profile);
}

describe("renderProfiledModel: the contract", () => {
   test("record_count and overview are still there", () => {
      // README.md, docs/scaffolding.md and the e2e suite all name these two.
      // A seeded package that stopped declaring them would break every one of
      // those and none of them loudly.
      const model = renderCsv("id,amount\n1,10\n2,20\n");
      expect(model).toContain("measure: record_count is count()");
      expect(model).toContain("view: overview is {");
      expectCompiles(model);
   });

   test("the source still reads the copied data path", () => {
      expect(renderCsv("a,b\n1,2\n")).toContain(
         "duckdb.table('data/orders.csv')",
      );
   });

   test("nothing is left unrendered", () => {
      expect(renderCsv("a,b\n1,2\n")).not.toContain("{{");
   });
});

describe("renderProfiledModel: names", () => {
   test("an ordinary column is used bare; an awkward one is redeclared", () => {
      const model = renderCsv(
         "region,count,year,Total Yards,2024\n" +
            "west,1,2020,10,x\neast,2,2021,20,y\nwest,3,2022,30,z\n",
      );
      // The one name Malloy is happy with is used as it is.
      expect(model).toContain("group_by: region");
      expect(model).not.toContain("dimension: region");
      // Every other one is declared once, quoted, and used by its clean name.
      expect(model).toContain("dimension: count_field is `count`");
      expect(model).toContain("dimension: year_field is `year`");
      expect(model).toContain("dimension: total_yards is `Total Yards`");
      expect(model).toContain("dimension: _2024 is `2024`");
      // And the whole thing parses, which is the assertion that would have
      // caught every one of those had they been emitted bare.
      expectCompiles(model);
   });

   test("a reserved word emitted bare would fail this check", () => {
      // The negative control. Without it, "expectCompiles passes" proves
      // nothing about whether the reserved-word handling is doing any work.
      expect(
         parseProblems(
            "source: shop is duckdb.table('t') extend {\n" +
               "  measure: record_count is count()\n" +
               "  view: v is { group_by: count }\n" +
               "}",
         ).length,
      ).toBeGreaterThan(0);
   });

   test("two headers that clean to one name do not collide", () => {
      const model = renderCsv("Total Yards,total_yards\n1,2\n3,4\n");
      expect(model).toContain("dimension: total_yards is `Total Yards`");
      expect(model).toContain("dimension: total_yards_2 is `total_yards`");
      expectCompiles(model);
   });

   test("a column named record_count does not redefine the measure", () => {
      // An ordinary column name in an export of aggregates, and it lands on the
      // one name this generator has always emitted. Malloy's answer to a repeat
      // is to refuse the package, so the column gets suffixed instead.
      const model = render(
         prof([
            col("record_count", { type: "integer", distinct: 50 }),
            col("region"),
         ]),
      );
      expect(model).toContain("measure: record_count is count()");
      expect(model).toContain("dimension: record_count_2 is `record_count`");
      expectCompiles(model);
   });

   test("a column named like a generated measure does not collide with it", () => {
      // `amount` generates `total_amount`, and the file already has a column by
      // that name.
      const model = render(
         prof([
            col("amount", { type: "number", distinct: 90 }),
            col("total_amount", { type: "number", distinct: 80 }),
         ]),
      );
      expectCompiles(model);
      // Both measures exist under distinct names, and neither shadows the
      // column the file actually carries.
      expect(model).toContain("measure: total_amount_2 is amount.sum()");
      expect(model).toContain(
         "measure: total_total_amount is total_amount.sum()",
      );
   });
});

describe("renderProfiledModel: measures", () => {
   test("numeric columns become sums and keys do not", () => {
      const model = render(
         prof([
            col("order_id", { type: "integer", distinct: 100, isKey: true }),
            col("amount", { type: "number", distinct: 90 }),
         ]),
      );
      expect(model).toContain("measure: total_amount is amount.sum()");
      expect(model).not.toContain("total_order_id");
      expectCompiles(model);
   });

   test("a two-valued flag is grouped by, not summed", () => {
      const model = render(
         prof([
            col("is_return", { type: "integer", distinct: 2 }),
            col("amount", { type: "number", distinct: 90 }),
         ]),
      );
      expect(model).not.toContain("total_is_return");
      expect(model).toContain("group_by: is_return");
   });

   test("a column that is mostly empty ranks below a complete one", () => {
      // The NFL schedule is the live case: `temp` has the most distinct values
      // in the file and is empty on 103 of 285 rows, so on cardinality alone it
      // outranked every score in the file.
      const model = render(
         prof(
            [
               col("temp", { type: "integer", distinct: 66, nulls: 103 }),
               col("home_score", { type: "integer", distinct: 43 }),
            ],
            { rowsProfiled: 285 },
         ),
      );
      const scoreAt = model.indexOf("total_home_score");
      const tempAt = model.indexOf("total_temp");
      expect(scoreAt).toBeGreaterThan(-1);
      expect(tempAt).toBeGreaterThan(-1);
      expect(scoreAt).toBeLessThan(tempAt);
   });

   test("no numeric column at all still produces a model", () => {
      const model = render(prof([col("region"), col("status")]));
      expect(model).toContain("measure: record_count is count()");
      expect(model).toContain("view: overview is {");
      expectCompiles(model);
   });
});

describe("renderProfiledModel: views", () => {
   test("every view counts rows rather than guessing a metric", () => {
      // The decision this test exists to pin. A scaffolder can see that a file
      // has five numeric columns; nothing in a profile says which one a person
      // came to chart. Picking one charted total temperature per venue on an
      // NFL schedule -- in every view at once, because they all inherited it.
      const model = render(
         prof([
            col("region", { distinct: 4 }),
            col("amount", { type: "number", distinct: 90 }),
         ]),
      );
      expect(model).toContain("group_by: region");
      expect(model).toContain("aggregate: record_count");
      expect(model).not.toContain("aggregate: total_amount");
      // The measure is still declared, one word away.
      expect(model).toContain("measure: total_amount is amount.sum()");
   });

   test("columns with a handful of values are charted before flags", () => {
      const model = render(
         prof([
            col("location", { distinct: 2 }),
            col("overtime", { type: "integer", distinct: 2 }),
            col("div_game", { type: "integer", distinct: 2 }),
            col("roof", { distinct: 3 }),
            col("game_type", { distinct: 5 }),
         ]),
      );
      expect(model).toContain("view: by_roof is {");
      expect(model).toContain("view: by_game_type is {");
      // Three view slots, and the two-way splits do not fill them.
      expect(model).not.toContain("view: by_overtime is {");
   });

   test("a column with a value per row is not charted", () => {
      const model = render(
         prof([col("note", { distinct: 100 })], { rowsProfiled: 100 }),
      );
      expect(model).not.toContain("view: by_note is {");
   });

   test("the first date column gets a month line", () => {
      const model = render(
         prof([
            col("order_date", { type: "date", distinct: 40 }),
            col("region", { distinct: 4 }),
         ]),
      );
      expect(model).toContain("view: order_date_by_month is {");
      expect(model).toContain("group_by: order_date_month is order_date.month");
      expectCompiles(model);
   });
});

describe("renderProfiledModel: primary key", () => {
   test("a unique, complete key column over enough rows is declared", () => {
      const model = render(
         prof([col("game_id", { distinct: 285, isKey: true }), col("region")], {
            rowsProfiled: 285,
         }),
      );
      expect(model).toContain("primary_key: game_id");
      expectCompiles(model);
   });

   test("a sampled file declares no primary key", () => {
      // Uniqueness over the front of a file is not uniqueness, and a wrong
      // primary key is what Malloy uses to decide whether a join fans out.
      const model = render(
         prof([col("game_id", { distinct: 285, isKey: true })], {
            rowsProfiled: 285,
            truncated: true,
         }),
      );
      expect(model).not.toContain("primary_key:");
   });

   test("a key with an empty value is not a primary key", () => {
      const model = render(
         prof([col("game_id", { distinct: 284, nulls: 1, isKey: true })], {
            rowsProfiled: 285,
         }),
      );
      expect(model).not.toContain("primary_key:");
   });
});

describe("renderProfiledModel: determinism", () => {
   test("the same file renders byte-identically twice", () => {
      // No Set iteration order and no clock in the output: a regenerated
      // package has to be a no-op diff, or nobody can regenerate one.
      const csv =
         "id,region,amount,when\n" +
         "1,west,10.5,2024-01-01\n2,east,20.5,2024-02-01\n3,west,5.25,2024-03-01\n";
      expect(renderCsv(csv)).toBe(renderCsv(csv));
   });

   test("equal cardinalities keep the file's column order", () => {
      const model = render(
         prof([
            col("b_amount", { type: "integer", distinct: 50 }),
            col("a_amount", { type: "integer", distinct: 50 }),
         ]),
      );
      expect(model.indexOf("total_b_amount")).toBeLessThan(
         model.indexOf("total_a_amount"),
      );
   });
});

describe("renderProfiledModel: the profile comment", () => {
   test("it reports every column and the counts behind each decision", () => {
      const model = renderCsv("order_id,amount\n1,10\n2,20\n");
      expect(model).toContain("// Columns read from 2 rows of the file:");
      expect(model).toContain("order_id");
      expect(model).toContain("identifier, not summed");
      expect(model).toContain("distinct");
   });

   test("a sampled file says the counts are over a sample", () => {
      const model = render(
         prof([col("region")], { rowsProfiled: 10, truncated: true }),
      );
      expect(model).toContain("// Columns read from the first 10 rows");
      expect(model).toContain("not over the whole file");
   });
});
