// Copyright (c) Credible Data Inc.
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
   isProfilableDataFile,
   profileDataFile,
   type Column,
   type Profile,
} from "./profile";

let tmp: string;

beforeEach(() => {
   tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-profile-"));
});

afterEach(() => {
   fs.rmSync(tmp, { recursive: true, force: true });
});

/** Write a file with the exact bytes given -- no newline translation. */
function write(name: string, contents: string | Buffer): string {
   const file = path.join(tmp, name);
   fs.writeFileSync(file, contents);
   return file;
}

function profile(name: string, contents: string | Buffer): Profile {
   const result = profileDataFile(write(name, contents));
   if (result === undefined) {
      throw new Error(`expected ${name} to profile, got undefined`);
   }
   return result;
}

function column(result: Profile, name: string): Column {
   const found = result.columns.find((c) => c.name === name);
   if (found === undefined) {
      throw new Error(
         `no column "${name}" in [${result.columns.map((c) => c.name).join(", ")}]`,
      );
   }
   return found;
}

/** A CSV with one column and the given values under it. */
function oneColumn(values: string[], header = "v"): Profile {
   return profile("one.csv", `${header}\n${values.join("\n")}\n`);
}

describe("profileDataFile: types", () => {
   test("whole numbers are integers", () => {
      expect(oneColumn(["1", "2", "30"]).columns[0].type).toBe("integer");
   });

   test("one decimal makes the whole column a number", () => {
      expect(oneColumn(["1", "2", "3.5"]).columns[0].type).toBe("number");
   });

   test("negatives and exponents are numbers", () => {
      expect(oneColumn(["-1.5", "2e3", "+0.25"]).columns[0].type).toBe(
         "number",
      );
   });

   test("YYYY-MM-DD is a date", () => {
      expect(oneColumn(["2024-01-31", "2024-02-01"]).columns[0].type).toBe(
         "date",
      );
   });

   test("a date with a time is a timestamp", () => {
      expect(
         oneColumn(["2024-01-31T09:30", "2024-02-01T10:00:15Z"]).columns[0]
            .type,
      ).toBe("timestamp");
   });

   test("true and false in any case are booleans", () => {
      expect(oneColumn(["true", "FALSE", "True"]).columns[0].type).toBe(
         "boolean",
      );
   });

   test("0 and 1 are integers, not booleans", () => {
      // DuckDB reads them as integers and so does everyone else. Typing them as
      // booleans would make a flag that sums today stop summing.
      expect(oneColumn(["0", "1", "1"]).columns[0].type).toBe("integer");
   });

   test("anything mixed falls back to string", () => {
      expect(oneColumn(["1", "abc", "3"]).columns[0].type).toBe("string");
      // A date column and a timestamp column are two types, not one, so a
      // column holding both is neither.
      expect(
         oneColumn(["2024-01-31", "2024-02-01T10:00"]).columns[0].type,
      ).toBe("string");
   });

   test("a column of blanks is a string, and every row counts as empty", () => {
      const result = profile("blank.csv", "a,b\n1,\n2,\n3,\n");
      const b = column(result, "b");
      expect(b.type).toBe("string");
      expect(b.nulls).toBe(3);
      expect(b.distinct).toBe(0);
   });

   test("leading zeros stay strings", () => {
      // The trap this whole rule exists for. `007`, an order number and a US
      // zip code all match /^\d+$/, and typing them as integers drops the
      // zeros: the value in the model stops being the value in the file, and a
      // join on the column stops matching.
      expect(oneColumn(["007", "008", "010"]).columns[0].type).toBe("string");
      expect(oneColumn(["01234", "02138"]).columns[0].type).toBe("string");
      // A plain zero is still a number, and so is a zero with a decimal.
      expect(oneColumn(["0", "5", "10"]).columns[0].type).toBe("integer");
      expect(oneColumn(["0.5", "0.25"]).columns[0].type).toBe("number");
   });

   test("integers too long to hold exactly stay strings", () => {
      // 19-digit ids survive a round trip through JSON only as text; read as
      // numbers they come back as a different id.
      expect(
         oneColumn(["1234567890123456789", "1234567890123456790"]).columns[0]
            .type,
      ).toBe("string");
   });

   test("an impossible date is not a date", () => {
      expect(oneColumn(["2024-13-01", "2024-01-01"]).columns[0].type).toBe(
         "string",
      );
   });
});

describe("profileDataFile: keys", () => {
   /** 30 rows, so the uniqueness floor is cleared. */
   function rows(make: (i: number) => string, header: string): Profile {
      const body = Array.from({ length: 30 }, (_, i) => make(i)).join("\n");
      return profile("keys.csv", `${header}\n${body}\n`);
   }

   test("a column named like an identifier is a key", () => {
      const result = rows((i) => `${i},${i % 3},10`, "order_id,sku,amount");
      expect(column(result, "order_id").isKey).toBe(true);
      // Even though sku repeats -- the name is the stronger signal.
      expect(column(result, "sku").isKey).toBe(true);
      expect(column(result, "amount").isKey).toBe(false);
   });

   test("a year-like integer is a key even when it repeats", () => {
      const result = rows((i) => `2024,${i % 5}`, "season,points");
      expect(column(result, "season").isKey).toBe(true);
      expect(column(result, "points").isKey).toBe(false);
   });

   test("a numeric column where every value differs is read as a key", () => {
      // Worth pinning because it is the heuristic's known cost, not a bug: a
      // measure whose values happen never to repeat is kept out of the
      // measures. Over 20+ rows that pattern is an identifier far more often
      // than it is a quantity, and the generated model prints the distinct
      // count next to the column, so the reader can see why.
      const result = rows((i) => `${i}`, "points");
      expect(column(result, "points").isKey).toBe(true);
   });

   test("a unique integer over the row floor is a key", () => {
      const result = rows((i) => `${i + 500},7`, "ref,qty");
      expect(column(result, "ref").isKey).toBe(true);
   });

   test("uniqueness under the row floor proves nothing", () => {
      // Three rows of prices are all different about as often as not, which is
      // why "every value is distinct" needs a floor under it.
      const result = profile("small.csv", "price\n10\n20\n30\n");
      expect(result.columns[0].isKey).toBe(false);
   });

   test("a decimal column is never a key", () => {
      const result = rows((i) => `${i}.5`, "ratio");
      expect(column(result, "ratio").isKey).toBe(false);
   });

   test("quantities are not keys", () => {
      const result = rows((i) => `${(i % 5) + 1}`, "quantity");
      expect(column(result, "quantity").isKey).toBe(false);
   });
});

describe("profileDataFile: CSV parsing", () => {
   test("quoted fields carrying the delimiter", () => {
      const result = profile(
         "q.csv",
         'name,city\n"Doe, Jane",Austin\n"Roe, John",Denver\n',
      );
      expect(result.rowsProfiled).toBe(2);
      expect(column(result, "name").distinct).toBe(2);
      expect(column(result, "city").distinct).toBe(2);
   });

   test('doubled "" is one literal quote', () => {
      const result = profile("q2.csv", 'label\n"say ""hi"""\n"plain"\n');
      expect(result.rowsProfiled).toBe(2);
      expect(column(result, "label").distinct).toBe(2);
   });

   test("a quoted field can hold a line break", () => {
      const result = profile(
         "q3.csv",
         'note,n\n"line one\nline two",1\n"single",2\n',
      );
      // Two rows, not three: the break inside the quotes is data.
      expect(result.rowsProfiled).toBe(2);
      expect(column(result, "n").type).toBe("integer");
   });

   test("CRLF and a bare CR both end a row", () => {
      expect(profile("crlf.csv", "a,b\r\n1,2\r\n3,4\r\n").rowsProfiled).toBe(2);
      expect(profile("cr.csv", "a,b\r1,2\r3,4\r").rowsProfiled).toBe(2);
   });

   test("a UTF-8 BOM does not become part of the first column name", () => {
      // The BOM is invisible in every editor and turns `id` into a name
      // with an unprintable character on the front of it, which then fails
      // to resolve against the table with no clue why.
      const result = profile("bom.csv", `\u{FEFF}id,amount\n1,10\n2,20\n`);
      expect(result.columns.map((c) => c.name)).toEqual(["id", "amount"]);
   });

   test("headers are trimmed", () => {
      const result = profile("sp.csv", "id , amount \n1,10\n");
      expect(result.columns.map((c) => c.name)).toEqual(["id", "amount"]);
   });

   test("a short row is padded and a long one is trimmed", () => {
      const result = profile("ragged.csv", "a,b,c\n1,2\n1,2,3,4\n1,2,3\n");
      expect(result.rowsProfiled).toBe(3);
      expect(column(result, "c").nulls).toBe(1);
   });

   test("blank lines are not rows", () => {
      const result = profile("blanks.csv", "a\n1\n\n2\n\n");
      expect(result.rowsProfiled).toBe(2);
      expect(result.columns[0].nulls).toBe(0);
   });

   test("a header-only file has nothing to profile", () => {
      expect(profileDataFile(write("head.csv", "a,b,c\n"))).toBeUndefined();
   });

   test("an empty file has nothing to profile", () => {
      expect(profileDataFile(write("empty.csv", ""))).toBeUndefined();
   });
});

describe("profileDataFile: what it refuses", () => {
   test("Parquet and XLSX are not read", () => {
      // They are binary containers. Reading them means a dependency, and the
      // starter model they get today is correct, just smaller.
      expect(profileDataFile(write("x.parquet", "PAR1"))).toBeUndefined();
      expect(profileDataFile(write("x.xlsx", "PK"))).toBeUndefined();
      expect(isProfilableDataFile("a/b/x.parquet")).toBe(false);
      expect(isProfilableDataFile("a/b/x.XLSX")).toBe(false);
      expect(isProfilableDataFile("a/b/x.CSV")).toBe(true);
   });

   test("a file that is not UTF-8 is refused rather than mangled", () => {
      // Latin-1 is what a spreadsheet exports on a Windows machine. Decoded as
      // UTF-8 the header becomes mojibake, and a model naming a mojibake column
      // is worse than a model naming none.
      const latin1 = Buffer.concat([
         Buffer.from("r", "latin1"),
         Buffer.from([0xe9]), // e-acute in Latin-1, invalid on its own in UTF-8
         Buffer.from("gion,n\n1,2\n", "latin1"),
      ]);
      expect(profileDataFile(write("latin1.csv", latin1))).toBeUndefined();
   });

   test("a duplicated header is refused", () => {
      // DuckDB renames the second one and this tool has no way to know what to,
      // so every reference it wrote would be to the wrong column.
      expect(profileDataFile(write("dup.csv", "a,a\n1,2\n"))).toBeUndefined();
   });

   test("a header holding a backtick is refused", () => {
      // The generated model quotes headers with backticks, so a header
      // containing one would end the quote early and emit broken Malloy.
      expect(
         profileDataFile(write("tick.csv", "a`b,c\n1,2\n")),
      ).toBeUndefined();
   });

   test("an empty header is refused", () => {
      expect(
         profileDataFile(write("blank.csv", "a,,c\n1,2,3\n")),
      ).toBeUndefined();
   });

   test("a missing file is undefined, not a throw", () => {
      expect(profileDataFile(path.join(tmp, "nope.csv"))).toBeUndefined();
   });
});

describe("profileDataFile: NDJSON and JSON", () => {
   test("NDJSON columns are the union of the objects' keys, in first-seen order", () => {
      const result = profile(
         "e.ndjson",
         '{"id":1,"city":"Austin"}\n{"city":"Denver","tier":"gold"}\n',
      );
      expect(result.columns.map((c) => c.name)).toEqual(["id", "city", "tier"]);
      expect(result.rowsProfiled).toBe(2);
      expect(column(result, "id").nulls).toBe(1);
   });

   test("JSON numbers and booleans keep their types", () => {
      const result = profile(
         "r.json",
         '[{"n":1,"ok":true},{"n":2,"ok":false}]',
      );
      expect(column(result, "n").type).toBe("integer");
      expect(column(result, "ok").type).toBe("boolean");
   });

   test("a nested value is opaque, not exploded", () => {
      const result = profile(
         "n.ndjson",
         '{"id":1,"tags":["a","b"]}\n{"id":2,"tags":["c"]}\n',
      );
      expect(column(result, "tags").type).toBe("string");
      expect(result.columns.map((c) => c.name)).toEqual(["id", "tags"]);
   });

   test("a JSON file that is not an array of objects is refused", () => {
      expect(profileDataFile(write("o.json", '{"a":1}'))).toBeUndefined();
      expect(profileDataFile(write("s.json", "[1,2,3]"))).toBeUndefined();
      expect(profileDataFile(write("bad.json", "{oops"))).toBeUndefined();
   });

   test("one unparseable NDJSON line does not condemn the file", () => {
      const result = profile("mixed.ndjson", '{"id":1}\nnot json\n{"id":2}\n');
      expect(result.rowsProfiled).toBe(2);
   });
});

describe("profileDataFile: the bounded read", () => {
   /**
    * Bigger than the 4 MiB cap, and built so the answer is checkable: every row
    * is the same width, so "rows profiled" times "bytes per row" has to land on
    * the cap rather than on the file.
    */
   function bigCsv(): { file: string; totalRows: number; rowBytes: number } {
      const header = "id,amount\n";
      const row = (i: number) => `${String(i).padStart(9, "0")},12345\n`;
      const rowBytes = row(0).length;
      const totalRows = Math.ceil((6 * 1024 * 1024) / rowBytes);
      const parts = [header];
      for (let i = 0; i < totalRows; i++) {
         parts.push(row(i));
      }
      return { file: write("big.csv", parts.join("")), totalRows, rowBytes };
   }

   test("a file past the cap profiles from its front and says so", () => {
      const { file, totalRows, rowBytes } = bigCsv();
      expect(fs.statSync(file).size).toBeGreaterThan(4 * 1024 * 1024);
      const result = profileDataFile(file);
      expect(result).toBeDefined();
      const profiled = result as Profile;

      expect(profiled.truncated).toBe(true);
      // The point of the whole exercise: it read the cap, not the file.
      expect(profiled.rowsProfiled).toBeLessThan(totalRows);
      const cap = Math.floor((4 * 1024 * 1024) / rowBytes);
      // Within one row of the cap, off by the header and the dropped partial
      // line. A whole-file read would land on totalRows instead.
      expect(Math.abs(profiled.rowsProfiled - cap)).toBeLessThanOrEqual(2);
      expect(profiled.columns.map((c) => c.name)).toEqual(["id", "amount"]);
   });

   test("the row the cap landed in the middle of is dropped, not profiled", () => {
      // A half-record would profile as a row of empty and mistyped values, and
      // the second column is the one that shows it: every value in the file is
      // the same five digits, so anything other than one distinct value and
      // zero empties means a partial line was counted.
      const { file } = bigCsv();
      const profiled = profileDataFile(file) as Profile;
      const amount = profiled.columns[1];
      expect(amount.name).toBe("amount");
      expect(amount.type).toBe("integer");
      expect(amount.distinct).toBe(1);
      expect(amount.nulls).toBe(0);
   });

   test("a file under the cap is not marked truncated", () => {
      expect(profile("small.csv", "a\n1\n2\n").truncated).toBe(false);
   });
});
