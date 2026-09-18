// Copyright (c) Credible Data Inc.
// SPDX-License-Identifier: MIT

import { toMalloyFieldName } from "./names";
import type { Column, ColumnType, Profile } from "./profile";
import { renderTemplate } from "./templates";

/**
 * How many numeric columns become measures.
 *
 * A wide export can carry fifty numeric columns, and a source declaring fifty
 * measures is not a starting point, it is a wall. Five is enough to make the
 * model useful on its first run and few enough that a reader can see all of them
 * at once; the other columns are still there to sum, they just do not get a
 * measure written for them.
 */
const MEASURE_CAP = 5;

/** The same argument for breakdown views, which are longer on the page. */
const VIEW_CAP = 3;

/**
 * The widest a column can be and still be worth grouping by. Past this a bar
 * chart is a wall of bars, and a column with a value per row is an identifier
 * whatever its name says.
 */
const MAX_GROUPABLE_DISTINCT = 50;

/** Narrower than that, and it is not a breakdown at all. */
const MIN_GROUPABLE_DISTINCT = 2;

/** The range of distinct values that makes the most readable starter chart. */
const IDEAL_GROUPABLE_MIN = 3;
const IDEAL_GROUPABLE_MAX = 20;

/** Words sort ahead of numbers when a breakdown column has to be chosen. */
function textualRank(type: ColumnType): number {
   return type === "string" || type === "boolean" ? 0 : 1;
}

function interestRank(distinct: number): number {
   return distinct >= IDEAL_GROUPABLE_MIN && distinct <= IDEAL_GROUPABLE_MAX
      ? 0
      : 1;
}

/**
 * Rows a file needs before "every value in this column is different" is evidence
 * of a key rather than a coincidence. Over three rows it is true of prices about
 * as often as of identifiers.
 */
const MIN_ROWS_FOR_PRIMARY_KEY = 20;

/**
 * The two names this generator has always emitted and must keep emitting.
 * README.md, docs/scaffolding.md and tests/e2e/scaffold.e2e.spec.ts all name
 * them, so they are a contract with everything built on a seeded package, not an
 * implementation detail of the template.
 */
const RECORD_COUNT = "record_count";
const OVERVIEW = "overview";

/** A column, its Malloy name, and whether that name had to be declared. */
interface Field {
   column: Column;
   /** The name every measure and view below refers to it by. */
   name: string;
   /**
    * True when `name` is not what the file calls the column, so the model has to
    * declare `dimension: <name> is \`<header>\`` before anything can use it.
    */
   redeclared: boolean;
}

/**
 * Hands out names that are unique across the whole source.
 *
 * Everything a Malloy source declares shares one namespace -- dimensions,
 * measures and views alike -- and Malloy's answer to a repeat is to refuse the
 * package with "Cannot redefine". That is easy to forget here because the
 * collisions do not look like collisions: a file with a column called
 * `record_count` collides with the measure this has always emitted, and a file
 * with both `amount` and `total_amount` collides with the measure generated FOR
 * `amount`. Both are ordinary column names in a real export, and both produced a
 * package that scaffolded green and then failed to load.
 */
class NameAllocator {
   private readonly taken = new Set<string>();

   constructor(reserved: string[]) {
      for (const name of reserved) {
         this.taken.add(name);
      }
   }

   /** `base`, or `base_2`, `base_3`, ... if that is already spoken for. */
   claim(base: string): string {
      let name = base;
      let n = 2;
      while (this.taken.has(name)) {
         name = `${base}_${n}`;
         n++;
      }
      this.taken.add(name);
      return name;
   }
}

/**
 * Render a starter model for a data file whose columns have been read.
 *
 * The prose lives in templates/model.profiled.malloy like every other generated
 * file's does, and goes through the same strict renderTemplate: every variable
 * this computes has to be referenced by that file or the render throws, which is
 * what keeps a block from being computed here and silently dropped there.
 */
export function renderProfiledModel(
   profile: Profile,
   vars: { sourceName: string; dataPath: string },
): string {
   // record_count and overview are claimed before any column is, so a file that
   // happens to have a column by either name gets the suffixed field rather than
   // a model that cannot compile.
   const allocator = new NameAllocator([RECORD_COUNT, OVERVIEW]);
   const fields = toFields(profile.columns, allocator);
   const measures = pickMeasures(fields, allocator);
   const views = buildViews(profile, fields, allocator);
   const primaryKey = pickPrimaryKey(profile, fields);
   return renderTemplate("model.profiled.malloy", {
      sourceName: vars.sourceName,
      dataPath: vars.dataPath,
      profileComment: renderProfileComment(profile, fields),
      primaryKey: primaryKey ? `  primary_key: ${primaryKey.name}\n\n` : "",
      dimensions: renderDimensions(fields),
      measures: renderMeasures(measures),
      views: renderViews(views, measures),
   });
}

/**
 * Name every column.
 *
 * The first column to claim a name keeps it and later ones are suffixed, so the
 * result depends only on the file's column order: the same file always produces
 * the same model. De-duplication is not hypothetical here -- `Total Yards` and
 * `total_yards` clean to one name, and so do `ID` and `id`.
 */
function toFields(columns: Column[], allocator: NameAllocator): Field[] {
   return columns.map((column) => {
      const name = allocator.claim(toMalloyFieldName(column.name));
      return { column, name, redeclared: name !== column.name };
   });
}

interface Measure {
   field: Field;
   name: string;
}

/**
 * Which numeric columns become `total_*` measures, and in what order.
 *
 * Only the cap makes this a choice at all, and the ordering decides who falls
 * off the end. Two signals, in this order:
 *
 * 1. Columns with no empty values first. A column that is a third empty is a
 *    column the file is not really about, and its sum is over a subset the
 *    reader has no reason to expect. On the NFL games file this is what moves
 *    `temp` (66 distinct, 103 of 285 rows empty) below the scores.
 * 2. Then the most distinct values. A column of amounts has a value per row; a
 *    column of statuses has four. It is not a perfect proxy for "the measure
 *    worth having", but it is the only signal in a profile that tracks it, and
 *    it beats the obvious alternative -- take the first numeric column -- which
 *    makes the pick an artefact of whatever wrote the export. On a real orders
 *    file that one chose `quantity` over `amount`.
 *
 * Two exclusions, both about not asserting something false:
 *
 * - Keys never qualify, whatever their type. Summing `order_id` produces a
 *   number with no meaning, and it is the first thing a reviewer looks for in
 *   generated SQL.
 * - Neither do two-valued columns. A 0/1 flag like `overtime` sums to a count
 *   dressed up as a total, and it is already more useful as something to group
 *   by, which is where it ends up.
 *
 * What this deliberately does NOT do is decide which of these is the one worth
 * charting. See buildViews.
 */
function pickMeasures(fields: Field[], allocator: NameAllocator): Measure[] {
   return (
      fields
         .map((field, index) => ({ field, index }))
         .filter(
            (e) =>
               !e.field.column.isKey &&
               e.field.column.distinct > MIN_GROUPABLE_DISTINCT &&
               (e.field.column.type === "integer" ||
                  e.field.column.type === "number"),
         )
         // Sorted on entries carrying their original index, so equal ranks keep
         // file order rather than whatever the sort does with them. A model that
         // reorders itself between two runs over one file is a diff nobody made.
         .sort((a, b) => {
            const aEmpty = a.field.column.nulls > 0 ? 1 : 0;
            const bEmpty = b.field.column.nulls > 0 ? 1 : 0;
            if (aEmpty !== bEmpty) {
               return aEmpty - bEmpty;
            }
            if (a.field.column.distinct !== b.field.column.distinct) {
               return b.field.column.distinct - a.field.column.distinct;
            }
            return a.index - b.index;
         })
         .slice(0, MEASURE_CAP)
         .map((e) => ({
            field: e.field,
            name: allocator.claim(`total_${e.field.name}`),
         }))
   );
}

interface View {
   name: string;
   /** The chart annotation, or undefined for a plain table. */
   chart?: string;
   body: string[];
}

/**
 * The starter views: a breakdown for the columns worth splitting the data by,
 * and a month line for the first date column.
 *
 * Every one of them counts rows. That is the single most important decision in
 * this file and it is a decision NOT to guess: a scaffolder can see that a file
 * has five numeric columns, but nothing in a profile tells it which one a person
 * came to chart. Picking one anyway is how the first version of this charted
 * total temperature per venue on an NFL schedule -- plausible-looking, silently
 * wrong, and wrong in every view at once, because they all inherited the same
 * pick. A count is never wrong; it is a real answer to "how does this break
 * down"; and every measure is one word away, in the view body or in `overview`
 * right below, for the reader who knows which one they want.
 */
function buildViews(
   profile: Profile,
   fields: Field[],
   allocator: NameAllocator,
): View[] {
   const views: View[] = [];

   for (const field of pickGroupable(profile, fields)) {
      views.push({
         name: allocator.claim(`by_${field.name}`),
         chart: "# bar_chart",
         body: [
            `    group_by: ${field.name}`,
            `    aggregate: ${RECORD_COUNT}`,
            `    order_by: ${RECORD_COUNT} desc`,
         ],
      });
   }

   const time = fields.find(
      (f) => f.column.type === "date" || f.column.type === "timestamp",
   );
   if (time) {
      const bucket = allocator.claim(`${time.name}_month`);
      views.push({
         name: allocator.claim(`${time.name}_by_month`),
         chart: "# line_chart",
         body: [
            `    group_by: ${bucket} is ${time.name}.month`,
            `    aggregate: ${RECORD_COUNT}`,
            `    order_by: ${bucket}`,
         ],
      });
   }
   return views;
}

/**
 * The column to declare as the primary key, if the file makes one obvious.
 *
 * Three conditions, and all three are about being sure rather than being
 * helpful. The whole file must have been read, because uniqueness over a sample
 * is not uniqueness. The column must have no empty values, because a key with a
 * gap in it is not a key. And every value must be different over enough rows for
 * that to mean something. A wrong `primary_key:` is not cosmetic -- it is what
 * Malloy uses to decide whether a join fans out -- so this emits nothing at all
 * rather than its best idea.
 */
function pickPrimaryKey(profile: Profile, fields: Field[]): Field | undefined {
   if (profile.truncated) {
      return undefined;
   }
   return fields.find(
      (f) =>
         f.column.isKey &&
         f.column.nulls === 0 &&
         profile.rowsProfiled >= MIN_ROWS_FOR_PRIMARY_KEY &&
         f.column.distinct === profile.rowsProfiled,
   );
}

/**
 * Columns worth a breakdown view: enough distinct values to split the data, few
 * enough to read. A column with one value groups into a single bar, and a column
 * with a value per row is an identifier however it is typed.
 */
function pickGroupable(profile: Profile, fields: Field[]): Field[] {
   return (
      fields
         .map((field, index) => ({ field, index }))
         .filter((e) => {
            const c = e.field.column;
            if (c.type === "number") {
               // Grouping by a continuous number produces one bar per value. The
               // fix is a range expression, which is a modelling decision this tool
               // is not in a position to make.
               return false;
            }
            return (
               c.distinct >= MIN_GROUPABLE_DISTINCT &&
               c.distinct <= MAX_GROUPABLE_DISTINCT &&
               c.distinct < profile.rowsProfiled
            );
         })
         // Words before numbers, then columns with a handful of values before
         // everything else, then fewest-first, then file order.
         //
         // Both of the leading rules were paid for. Plain fewest-first was the
         // first version, and on the NFL schedule it filled all three view slots
         // with `location`, `overtime` and `div_game` while `roof`, `game_type`
         // and `weekday` -- the columns somebody would actually chart -- did not
         // make the cut, because a real file is full of two-valued flags and a
         // two-way split sorts first. Adding the value-count rule fixed that
         // file and left the wider one beside it wrong: on a 138-column stats
         // export the slots went to `sack_fumbles_lost` and
         // `passing_2pt_conversions`, small integers that happen to land in the
         // readable range, while `team` and `opponent_team` sat unused. A string
         // column is a category almost by definition; a small integer is as
         // often a derived count. Neither rule excludes anything -- together
         // they decide which three of the eligible columns get written.
         .sort((a, b) => {
            const aText = textualRank(a.field.column.type);
            const bText = textualRank(b.field.column.type);
            if (aText !== bText) {
               return aText - bText;
            }
            const aRank = interestRank(a.field.column.distinct);
            const bRank = interestRank(b.field.column.distinct);
            if (aRank !== bRank) {
               return aRank - bRank;
            }
            if (a.field.column.distinct !== b.field.column.distinct) {
               return a.field.column.distinct - b.field.column.distinct;
            }
            return a.index - b.index;
         })
         .slice(0, VIEW_CAP)
         .map((e) => e.field)
   );
}

/**
 * The profile, written into the model as a comment.
 *
 * Every number the generator used to make its choices is here, so a reader can
 * see why a column became a measure rather than a dimension without reading the
 * generator. It is the answer to the fair objection that a scaffolder should not
 * guess: it still guesses, but it shows its work, and the line it got wrong is
 * the line you delete.
 */
function renderProfileComment(profile: Profile, fields: Field[]): string {
   // Folded rather than spread. `Math.max(6, ...names)` passes one argument per
   // column, and an argument list is bounded by the engine, not by this file:
   // V8 throws RangeError past roughly 125,000 while JSC takes 200,000 without
   // complaint. That difference is invisible here -- the suite runs under Bun
   // and the shipped bundle runs under Node -- so the rule this line is written
   // to follow is simply never to spread a collection whose size comes from the
   // user's file, whatever the current limit happens to be.
   const nameWidth = fields.reduce(
      (width, field) => Math.max(width, field.column.name.length),
      6,
   );
   const rows = profile.rowsProfiled;
   const lines = [
      `// Columns read from ${profile.truncated ? "the first " : ""}${rows} row${
         rows === 1 ? "" : "s"
      } of the file:`,
      "//",
   ];
   for (const field of fields) {
      const c = field.column;
      const parts = [
         `//   ${c.name.padEnd(nameWidth)}`,
         c.type.padEnd(9),
         `${c.distinct} distinct`,
      ];
      if (c.nulls > 0) {
         parts.push(`${c.nulls} empty`);
      }
      if (c.isKey) {
         parts.push("identifier, not summed");
      }
      lines.push(parts.join("  ").trimEnd());
   }
   if (profile.truncated) {
      lines.push(
         "//",
         "// The file is larger than the scaffolder reads, so those counts are over",
         "// that sample and not over the whole file. The types are what the sample",
         "// supports; a value further down that does not fit will still be read by",
         "// DuckDB, which sees all of it, and can disagree.",
      );
   }
   return lines.join("\n");
}

function renderDimensions(fields: Field[]): string {
   const redeclared = fields.filter((f) => f.redeclared);
   if (redeclared.length === 0) {
      return "";
   }
   const lines = [
      "  // Column names the file spells differently from Malloy: a space, a",
      "  // reserved word, a leading digit, or a name already used above.",
      "  // Declared once here so nothing below has to quote them.",
   ];
   for (const field of redeclared) {
      lines.push(`  dimension: ${field.name} is \`${field.column.name}\``);
   }
   return `${lines.join("\n")}\n\n`;
}

function renderMeasures(measures: Measure[]): string {
   const lines = [`  measure: ${RECORD_COUNT} is count()`];
   for (const measure of measures) {
      lines.push(`  measure: ${measure.name} is ${measure.field.name}.sum()`);
   }
   return `${lines.join("\n")}\n`;
}

function renderViews(views: View[], measures: Measure[]): string {
   const blocks = views.map((view) =>
      [
         ...(view.chart ? [`  ${view.chart}`] : []),
         `  view: ${view.name} is {`,
         ...view.body,
         "  }",
      ].join("\n"),
   );
   blocks.push(
      [
         `  view: ${OVERVIEW} is {`,
         "    aggregate:",
         `      ${RECORD_COUNT}`,
         ...measures.map((m) => `      ${m.name}`),
         "  }",
      ].join("\n"),
   );
   return `\n${blocks.join("\n\n")}\n`;
}
