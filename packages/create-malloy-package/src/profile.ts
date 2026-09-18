// Copyright (c) Credible Data Inc.
// SPDX-License-Identifier: MIT

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The Malloy types this tool is willing to claim a column has.
 *
 * Deliberately smaller than Malloy's type system. Every entry here is something
 * a run of sample values can establish on its own; anything that needs the
 * database's opinion (decimals, intervals, structs) is left as a string, because
 * a wrong type in a generated model is worse than no type at all -- it compiles,
 * it runs, and it answers with the wrong number.
 */
export type ColumnType =
   | "string"
   | "integer"
   | "number"
   | "date"
   | "timestamp"
   | "boolean";

export interface Column {
   /** The header exactly as it appears in the file, before any name cleaning. */
   name: string;
   type: ColumnType;
   /** Distinct non-empty values seen in the rows that were profiled. */
   distinct: number;
   /** Rows where this column was empty or absent. */
   nulls: number;
   /**
    * True when this column is an identifier rather than a quantity: summing it
    * would produce a number with no meaning. Keys are never turned into
    * measures, and they are the columns worth grouping by.
    */
   isKey: boolean;
}

export interface Profile {
   columns: Column[];
   /**
    * Rows actually read. The generated model says so in a comment, because on a
    * file past the read cap this is a sample and every count below is a count
    * over the sample, not over the file.
    */
   rowsProfiled: number;
   /** True when the file was longer than the read cap. */
   truncated: boolean;
}

/**
 * How much of the file to read.
 *
 * The obvious implementation is `fs.readFileSync(file, "utf8")`, and it is the
 * one this started as. It cannot ship. Node's hard ceiling on a single string is
 * `buffer.constants.MAX_STRING_LENGTH`, 512 MiB on 64-bit, and Publisher's own
 * QA has served a 784 MB CSV through this scaffolder -- so the whole-file read
 * does not degrade on a big file, it throws, after the package directory and the
 * copied data file are already on disk. Even well under the ceiling it is the
 * wrong shape: `npm create` is a command someone runs while watching it, and
 * holding a gigabyte to count distinct values in the first few thousand rows is
 * a cost with no matching benefit.
 *
 * 4 MiB is roughly 20,000 rows of a typical export, which is far more than the
 * type of a column needs and enough for the distinct counts to be meaningful.
 */
const READ_CAP_BYTES = 4 * 1024 * 1024;

/**
 * Below this many rows, "every value is different" is not evidence of a key.
 * Three rows of amounts are all distinct about as often as not.
 */
const KEY_ROW_FLOOR = 20;

/**
 * Year-like integers are keys even when they repeat: a `season` or `year` column
 * is something to group by, and `total_season` is not a number anybody wants.
 * The range is wide enough for fiscal and historical data and narrow enough that
 * ordinary quantities, prices and counts fall outside it.
 */
const YEAR_MIN = 1900;
const YEAR_MAX = 2200;

/**
 * Columns whose name says identifier. Checked as a whole word or a suffix, so
 * `id`, `order_id` and `sku` match while `idle` and `video` do not.
 */
const KEY_NAME_RE = /(^|_)(id|ids|key|code|uuid|guid|sku|isbn)$/i;

const BOOL_RE = /^(true|false)$/i;
const INT_RE = /^[+-]?\d+$/;
const NUM_RE = /^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP_RE =
   /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * Anything a Malloy backtick-quoted name cannot carry, plus the replacement
 * character. A header holding U+FFFD means the file was not UTF-8 -- a Latin-1
 * export is the usual case -- and the column names we would emit are mojibake.
 *
 * The backslash is in this class for the same reason the backtick is, and it is
 * the easier one to miss: Malloy's lexer treats it as an escape INSIDE a
 * backtick-quoted identifier, so a header ending in one swallows the closing
 * backtick and the generated model stops parsing while the scaffold still
 * reports success. A backslash in the middle of a header is quieter and no
 * better: a Windows-shaped header compiles and then names the column the lexer
 * un-escaped, which is not the column in the file, so the failure moves from
 * compile time to query time. Escaping it on the way out is the other option,
 * and it would depend on Malloy's escape rules staying where they are; falling
 * back to the model that names no column is the choice this module already
 * makes everywhere else.
 */
// eslint-disable-next-line no-control-regex
const UNUSABLE_HEADER_RE = /[`\\\u0000-\u001F\u007F\uFFFD]/;

const MAX_HEADER_LENGTH = 200;

/**
 * The most columns this tool is willing to model.
 *
 * Nothing about a data file bounds its width, and a machine-generated export can
 * carry six figures of columns in well under the 4 MiB this reads. Two things go
 * wrong at once past a few thousand. The model stops being a starting point: at
 * 130,000 columns it is a 4.7 MB file with 130,000 dimensions, which nobody
 * opens, let alone edits. And the per-column work in the emitter starts running
 * into the runtime's own limits rather than anything about the data -- the
 * argument-count ceiling on a spread is the one that bit first, and fixing that
 * one line leaves the 4.7 MB model behind it.
 *
 * So a file wider than this falls back to the model that reads it without naming
 * a column, which is correct, loads, and is where every other thing this
 * profiler cannot do safely already lands. 1,000 is two orders of magnitude
 * above the widest real export this was built against -- a 138-column stats file
 * -- and still small enough that the model it produces can be read.
 */
const MAX_COLUMNS = 1000;

/**
 * The --data formats this tool can read the columns of without a dependency.
 *
 * Narrower than LOADABLE_DATA_EXTENSIONS on purpose. Parquet and XLSX are
 * containers, not text: reading their schemas means a Parquet reader and a zip
 * plus XML reader, and the one library that already does both is DuckDB, which
 * would put a 37 MB per-platform native binding inside a package that ships as a
 * single 84 KB file. They keep the starter model they have always had, which is
 * correct, just smaller than it could be. Swapping this parser for a DuckDB
 * DESCRIBE later would widen this list and change nothing else.
 */
const PROFILABLE_EXTENSIONS = [".csv", ".json", ".ndjson"] as const;

/** Whether profileDataFile stands any chance of reading this file's columns. */
export function isProfilableDataFile(file: string): boolean {
   return (PROFILABLE_EXTENSIONS as readonly string[]).includes(
      path.extname(file).toLowerCase(),
   );
}

/** One column's accumulating evidence while rows are scanned. */
interface Accumulator {
   name: string;
   values: Set<string>;
   nulls: number;
   /** Bit mask of the types still possible for every non-null value so far. */
   mask: number;
   min: number;
   max: number;
   /** Rows that carried a value, which is the denominator a key is judged on. */
   present: number;
}

const T_BOOLEAN = 1;
const T_INTEGER = 2;
const T_NUMBER = 4;
const T_DATE = 8;
const T_TIMESTAMP = 16;
const T_ALL = T_BOOLEAN | T_INTEGER | T_NUMBER | T_DATE | T_TIMESTAMP;

/** A parsed file: the header row, and the rows under it. */
interface Table {
   header: string[];
   rows: (string | null)[][];
}

/**
 * The columns of a --data file, or undefined when this tool cannot read them.
 *
 * Undefined is not an error and is never surfaced as one. It means "scaffold the
 * package the way it has always been scaffolded", which is what an unsupported
 * format (Parquet, XLSX), an unreadable file, a file that is not UTF-8, a header
 * this tool cannot safely quote, or a file with a header and no rows all get.
 * The same choice `findSiblingDataFiles` makes for an unreadable directory: a
 * good scaffold is not worth failing over a step that only ever adds to it.
 */
export function profileDataFile(file: string): Profile | undefined {
   const prefix = readPrefix(file);
   if (prefix === undefined) {
      return undefined;
   }
   const table = parseTable(file, prefix.text, prefix.truncated);
   if (table === undefined || table.rows.length === 0) {
      return undefined;
   }
   if (!headerIsUsable(table.header)) {
      return undefined;
   }
   return {
      columns: inferColumns(table),
      rowsProfiled: table.rows.length,
      truncated: prefix.truncated,
   };
}

/**
 * Read at most READ_CAP_BYTES from the front of the file.
 *
 * On a truncated read everything after the last newline is dropped. That does
 * two jobs at once: it removes the half-record the cap landed in the middle of,
 * which would otherwise be profiled as a row of empty and mistyped values, and
 * it removes any multi-byte character the cap split, which would otherwise
 * decode to U+FFFD and take a column's name or a whole file down with it.
 */
function readPrefix(
   file: string,
): { text: string; truncated: boolean } | undefined {
   let fd: number | undefined;
   let buffer: Buffer;
   let truncated: boolean;
   try {
      fd = fs.openSync(file, "r");
      const size = fs.fstatSync(fd).size;
      if (size === 0) {
         return undefined;
      }
      truncated = size > READ_CAP_BYTES;
      const want = Math.min(size, READ_CAP_BYTES);
      buffer = Buffer.alloc(want);
      const read = fs.readSync(fd, buffer, 0, want, 0);
      buffer = buffer.subarray(0, read);
   } catch {
      // An unreadable --data file is not this function's problem to report:
      // validateDataFile has already established the file exists, and the copy
      // that follows will fail loudly if it cannot be read. Falling back to the
      // minimal model is the right answer to "could not look inside".
      return undefined;
   } finally {
      if (fd !== undefined) {
         try {
            fs.closeSync(fd);
         } catch {
            // Nothing useful to do, and nothing depending on it.
         }
      }
   }

   let text = new TextDecoder("utf-8").decode(buffer);
   if (text.charCodeAt(0) === 0xfeff) {
      text = text.slice(1);
   }
   if (truncated) {
      const lastNewline = text.lastIndexOf("\n");
      if (lastNewline < 0) {
         // 4 MiB with no line break at all is not a text table we can sample.
         return undefined;
      }
      text = text.slice(0, lastNewline + 1);
   }
   return { text, truncated };
}

function parseTable(
   file: string,
   text: string,
   truncated: boolean,
): Table | undefined {
   switch (path.extname(file).toLowerCase()) {
      case ".csv":
         return parseCsv(text);
      case ".ndjson":
         return parseNdjson(text);
      case ".json":
         return parseJsonArray(text, truncated);
      default:
         // Parquet and XLSX are binary. They keep today's starter model, which
         // is the whole reason this returns undefined rather than throwing.
         return undefined;
   }
}

/**
 * RFC 4180 CSV, with the three things real exports do that the naive split on
 * "," and "\n" gets wrong: quoted fields containing the delimiter, doubled ""
 * inside a quoted field, and quoted fields containing a line break. CR, LF and
 * CRLF all end a record, because a file written on one platform is routinely
 * read on another and `core.autocrlf` rewrites them in between.
 */
function parseCsv(text: string): Table | undefined {
   const records: string[][] = [];
   let record: string[] = [];
   let field = "";
   let quoted = false;

   for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
         if (c === '"') {
            if (text[i + 1] === '"') {
               field += '"';
               i++;
            } else {
               quoted = false;
            }
         } else {
            field += c;
         }
         continue;
      }
      if (c === '"' && field === "") {
         quoted = true;
         continue;
      }
      if (c === ",") {
         record.push(field);
         field = "";
         continue;
      }
      if (c === "\r" || c === "\n") {
         if (c === "\r" && text[i + 1] === "\n") {
            i++;
         }
         record.push(field);
         records.push(record);
         record = [];
         field = "";
         continue;
      }
      field += c;
   }
   if (field !== "" || record.length > 0) {
      record.push(field);
      records.push(record);
   }

   if (records.length < 2) {
      return undefined;
   }
   const header = records[0].map((h) => h.trim());
   const rows = records
      // A blank line parses as one empty field. It is not a row of data, and
      // counting it as one inflates every null count in the file.
      .slice(1)
      .filter((r) => !(r.length === 1 && r[0].trim() === ""))
      .map((r) => normalizeRow(r, header.length));
   return { header, rows };
}

/**
 * Pad a short record and drop a long one's extra fields. A ragged CSV is common
 * enough (a trailing comma, a hand-edited row) that refusing the whole file over
 * it would cost more than it saves.
 */
function normalizeRow(record: string[], width: number): (string | null)[] {
   const row: (string | null)[] = new Array(width);
   for (let i = 0; i < width; i++) {
      const raw = i < record.length ? record[i] : "";
      row[i] = raw.trim() === "" ? null : raw;
   }
   return row;
}

function parseNdjson(text: string): Table | undefined {
   const objects: Record<string, unknown>[] = [];
   for (const line of text.split(/\r\n|\r|\n/)) {
      if (line.trim() === "") {
         continue;
      }
      let parsed: unknown;
      try {
         parsed = JSON.parse(line);
      } catch {
         // One bad line does not condemn the file; a truncated tail has already
         // been dropped by readPrefix, so this is a genuinely malformed record.
         continue;
      }
      if (isPlainObject(parsed)) {
         objects.push(parsed);
      }
   }
   return tableFromObjects(objects);
}

function parseJsonArray(text: string, truncated: boolean): Table | undefined {
   let parsed: unknown;
   try {
      parsed = JSON.parse(text);
   } catch {
      if (!truncated) {
         return undefined;
      }
      // A truncated JSON array cannot parse, by construction: its closing
      // bracket is past the cap. Close it after the last complete object rather
      // than giving up, so a large .json gets the same sampling a large .csv
      // does instead of silently falling back to the minimal model.
      const lastComplete = text.lastIndexOf("}");
      if (lastComplete < 0) {
         return undefined;
      }
      try {
         parsed = JSON.parse(`${text.slice(0, lastComplete + 1)}]`);
      } catch {
         return undefined;
      }
   }
   if (!Array.isArray(parsed)) {
      return undefined;
   }
   return tableFromObjects(parsed.filter(isPlainObject));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
   return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Column order is first-appearance order across the objects, not the order of
 * any one object and not sorted. JSON records are not required to agree on their
 * keys, and a model whose column order changed between two runs over the same
 * file would make every regenerated package a diff.
 */
function tableFromObjects(
   objects: Record<string, unknown>[],
): Table | undefined {
   if (objects.length === 0) {
      return undefined;
   }
   const header: string[] = [];
   const seen = new Set<string>();
   for (const object of objects) {
      for (const key of Object.keys(object)) {
         if (!seen.has(key)) {
            seen.add(key);
            header.push(key);
         }
      }
   }
   // Own properties only. A plain `object[key]` walks the prototype chain, so a
   // record missing a key that happens to name an Object.prototype member --
   // `constructor`, `toString`, `valueOf`, `hasOwnProperty` -- reads back the
   // inherited FUNCTION instead of the absent value it actually has. That is not
   // a hypothetical file: a key present in one record and missing from the next
   // is the ordinary shape of a JSON export, and it took 33 bytes to turn this
   // whole tool into a stack trace. hasOwnProperty is called off the prototype
   // rather than the record, because the record may carry a key by that name.
   const rows = objects.map((object) =>
      header.map((key) =>
         Object.prototype.hasOwnProperty.call(object, key)
            ? jsonValueToCell(object[key])
            : null,
      ),
   );
   return { header, rows };
}

function jsonValueToCell(value: unknown): string | null {
   if (value === null || value === undefined) {
      return null;
   }
   if (typeof value === "string") {
      return value.trim() === "" ? null : value;
   }
   if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
   }
   // An object or an array in a cell is a nested structure. DuckDB will read it
   // as one, but nothing this profiler infers about it would be true, so it is
   // recorded as an opaque string and types as one.
   //
   // `?? null` is not defensive padding. lib.d.ts declares this overload of
   // JSON.stringify as returning `string`, and it is wrong: a function or an
   // undefined value comes back `undefined`. So the declaration above is what
   // keeps this honest -- typecheck cannot, because as far as it knows the
   // return is already a string, which is exactly why a `=== null` test
   // downstream let `undefined` through to a `.trim()`.
   return JSON.stringify(value) ?? null;
}

function headerIsUsable(header: string[]): boolean {
   if (header.length === 0 || header.length > MAX_COLUMNS) {
      return false;
   }
   const seen = new Set<string>();
   for (const name of header) {
      if (name === "" || name.length > MAX_HEADER_LENGTH) {
         return false;
      }
      if (UNUSABLE_HEADER_RE.test(name)) {
         return false;
      }
      // Two columns with the same header cannot both be referenced: DuckDB
      // renames the duplicate and this tool has no way to know what to. Today's
      // minimal model reads the file without naming any column, so it is still
      // correct where this would not be.
      if (seen.has(name)) {
         return false;
      }
      seen.add(name);
   }
   return true;
}

function inferColumns(table: Table): Column[] {
   const accumulators: Accumulator[] = table.header.map((name) => ({
      name,
      values: new Set<string>(),
      nulls: 0,
      mask: T_ALL,
      min: Number.POSITIVE_INFINITY,
      max: Number.NEGATIVE_INFINITY,
      present: 0,
   }));

   for (const row of table.rows) {
      for (let i = 0; i < accumulators.length; i++) {
         const accumulator = accumulators[i];
         const value = row[i];
         if (value === null) {
            accumulator.nulls++;
            continue;
         }
         accumulator.present++;
         accumulator.values.add(value);
         const trimmed = value.trim();
         accumulator.mask &= typeFlags(trimmed);
         if (accumulator.mask & T_INTEGER) {
            const n = Number(trimmed);
            if (n < accumulator.min) {
               accumulator.min = n;
            }
            if (n > accumulator.max) {
               accumulator.max = n;
            }
         }
      }
   }

   return accumulators.map((accumulator) => {
      const type = resolveType(accumulator);
      return {
         name: accumulator.name,
         type,
         distinct: accumulator.values.size,
         nulls: accumulator.nulls,
         isKey: looksLikeKey(accumulator, type),
      };
   });
}

/**
 * Which types this one value could belong to.
 *
 * The leading-zero rule is the one worth reading twice. `007`, `01234` and a US
 * zip code all match /^\d+$/, and typing them as integers is not a cosmetic
 * mistake: it drops the zeros, so a join on the column stops matching and a
 * printed value stops being the value that was in the file. A number whose text
 * form does not round-trip is a string.
 *
 * The 15-digit ceiling is the same argument at the other end. JavaScript, and
 * every JSON reader downstream of it, holds integers exactly only to 2^53, so a
 * 19-digit order id read as an integer comes back a different 19-digit number.
 */
function typeFlags(value: string): number {
   let flags = 0;
   if (BOOL_RE.test(value)) {
      flags |= T_BOOLEAN;
   }
   if (INT_RE.test(value)) {
      if (roundTripsAsInteger(value)) {
         flags |= T_INTEGER | T_NUMBER;
      }
   } else if (NUM_RE.test(value)) {
      flags |= T_NUMBER;
   }
   if (DATE_RE.test(value) && isRealDate(value)) {
      flags |= T_DATE;
   }
   if (TIMESTAMP_RE.test(value)) {
      flags |= T_TIMESTAMP;
   }
   return flags;
}

function roundTripsAsInteger(value: string): boolean {
   const digits = value.replace(/^[+-]/, "");
   if (digits.length > 1 && digits.startsWith("0")) {
      return false;
   }
   return digits.length <= 15;
}

function isRealDate(value: string): boolean {
   const month = Number(value.slice(5, 7));
   const day = Number(value.slice(8, 10));
   return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

/**
 * The narrowest type every value admitted. A column of integers admits both
 * `integer` and `number`, and integer is the better answer; a column mixing
 * dates and timestamps admits neither, and falls to string rather than guessing
 * which one to coerce.
 */
function resolveType(accumulator: Accumulator): ColumnType {
   if (accumulator.present === 0) {
      return "string";
   }
   if (accumulator.mask & T_BOOLEAN) {
      return "boolean";
   }
   if (accumulator.mask & T_INTEGER) {
      return "integer";
   }
   if (accumulator.mask & T_DATE) {
      return "date";
   }
   if (accumulator.mask & T_TIMESTAMP) {
      return "timestamp";
   }
   if (accumulator.mask & T_NUMBER) {
      return "number";
   }
   return "string";
}

/**
 * Is this column an identifier rather than a quantity?
 *
 * Three signals, cheapest first. The name is the strongest: nobody sums a column
 * called `order_id`. The year range catches `season` and `year`, which repeat
 * often enough that uniqueness never flags them and which nobody sums either.
 * Uniqueness is last and is deliberately floored: over three rows "every value
 * is different" is true of prices as often as of ids.
 *
 * A `number` column is never a key however unique it looks -- an identifier with
 * a decimal point is not a thing -- and neither is a date, a timestamp or a
 * boolean, which are already excluded from measures by type.
 */
function looksLikeKey(accumulator: Accumulator, type: ColumnType): boolean {
   if (type !== "integer" && type !== "string") {
      return false;
   }
   if (KEY_NAME_RE.test(accumulator.name.replace(/[^A-Za-z0-9_]+/g, "_"))) {
      return true;
   }
   if (
      type === "integer" &&
      accumulator.min >= YEAR_MIN &&
      accumulator.max <= YEAR_MAX
   ) {
      return true;
   }
   return (
      type === "integer" &&
      accumulator.present >= KEY_ROW_FLOOR &&
      accumulator.values.size === accumulator.present
   );
}
