import { describe, it, expect } from "vitest";
import {
  parseCsv,
  detectDelimiter,
  stripBom,
  autoMap,
  toCandidates,
  isImportable,
  validateMapping,
  MAX_ROWS,
  type ParsedCsv,
} from "../../src/modules/leads/csv";

/** The sample an operator would actually export from a CRM or Excel. */
const SAMPLE = [
  "Contact name,Job title,Email,LinkedIn URL,Company name,Company domain",
  "Horváth Judit,ügyvezető,judit@aventa.hu,https://linkedin.com/in/judit,Aventa Logistics Kft.,aventa.hu",
  "Nagy Péter,,peter@bimbo.hu,,Bimbó Zrt.,bimbo.hu",
  '"Kovács, Anna",CTO,anna@szigma.hu,,Szigma Kft.,szigma.hu',
].join("\n");

function ok(text: string): ParsedCsv {
  const res = parseCsv(text);
  if (!res.ok) throw new Error(`expected parse to succeed: ${res.error}`);
  return res.data;
}

describe("delimiter detection", () => {
  it("picks comma, semicolon or tab by what the header actually uses", () => {
    expect(detectDelimiter("a,b,c")).toBe(",");
    // Hungarian Excel exports semicolons.
    expect(detectDelimiter("Név;Email;Cég")).toBe(";");
    expect(detectDelimiter("a\tb\tc")).toBe("\t");
  });

  it("ignores delimiters inside quoted headers", () => {
    // One real semicolon; the comma only appears inside quotes.
    expect(detectDelimiter('"Név, teljes";Email')).toBe(";");
  });
});

describe("parsing", () => {
  it("keeps empty fields so later columns do not shift", () => {
    const data = ok(SAMPLE);
    expect(data.headers).toHaveLength(6);
    // Row 2 has an empty Job title AND an empty LinkedIn URL.
    expect(data.rows[1]).toEqual([
      "Nagy Péter",
      "",
      "peter@bimbo.hu",
      "",
      "Bimbó Zrt.",
      "bimbo.hu",
    ]);
    expect(data.rows.every((r) => r.length === 6)).toBe(true);
    expect(data.raggedRows).toEqual([]);
  });

  it("handles a quoted field containing the delimiter", () => {
    const data = ok(SAMPLE);
    expect(data.rows[2][0]).toBe("Kovács, Anna");
    expect(data.rows[2][2]).toBe("anna@szigma.hu");
  });

  it("unescapes doubled quotes", () => {
    const data = ok(['Name,Company', 'X,"The ""Big"" Co"'].join("\n"));
    expect(data.rows[0][1]).toBe('The "Big" Co');
  });

  it("handles a newline inside a quoted field", () => {
    const data = ok(['Name,Notes', '"Anna","line one\nline two"'].join("\n"));
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0][1]).toBe("line one\nline two");
  });

  it("handles CRLF and a trailing newline", () => {
    const data = ok("Name,Email\r\nAnna,a@b.hu\r\n");
    expect(data.rows).toEqual([["Anna", "a@b.hu"]]);
  });

  it("strips the Excel BOM so the first header is clean", () => {
    expect(stripBom("﻿Name")).toBe("Name");
    const data = ok("﻿Contact name,Email\nAnna,a@b.hu");
    expect(data.headers[0]).toBe("Contact name");
    expect(autoMap(data.headers).contactName).toBe(0);
  });

  it("parses a semicolon file end to end", () => {
    const data = ok(["Név;Email;Cég", "Anna;a@b.hu;Alfa Kft."].join("\n"));
    expect(data.delimiter).toBe(";");
    expect(data.rows[0]).toEqual(["Anna", "a@b.hu", "Alfa Kft."]);
  });

  it("reports ragged rows instead of hiding them", () => {
    const data = ok(["A,B,C", "1,2,3", "4,5"].join("\n"));
    expect(data.raggedRows).toEqual([1]);
  });
});

describe("malformed input produces a clear error, never a silent import", () => {
  it("rejects an empty file", () => {
    expect(parseCsv("")).toEqual({ ok: false, error: "That file is empty." });
    expect(parseCsv("   \n  \n")).toMatchObject({ ok: false });
  });

  it("rejects a file with no recognisable columns", () => {
    const res = parseCsv("this is just a sentence\nand another");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/header row/i);
  });

  it("rejects a header-only file", () => {
    const res = parseCsv("Name,Email");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/no data rows/i);
  });

  it("refuses a file larger than the row cap rather than truncating", () => {
    const big = ["Name,Email", ...Array.from({ length: MAX_ROWS + 1 }, (_, i) => `n${i},e${i}@x.hu`)];
    const res = parseCsv(big.join("\n"));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain(String(MAX_ROWS));
  });
});

describe("column auto-mapping", () => {
  it("maps every field of a typical export to the right column", () => {
    const data = ok(SAMPLE);
    expect(autoMap(data.headers)).toEqual({
      contactName: 0,
      title: 1,
      email: 2,
      linkedinUrl: 3,
      companyName: 4,
      companyDomain: 5,
    });
  });

  it("does not let 'Company domain' steal the company-name slot", () => {
    // The regression that made imports map the name column to the domain.
    const m = autoMap(["Company name", "Company domain"]);
    expect(m.companyName).toBe(0);
    expect(m.companyDomain).toBe(1);
  });

  it("never claims one column for two fields", () => {
    const m = autoMap(["Name", "Email", "Company"]);
    const used = Object.values(m).filter((v) => v !== undefined);
    expect(new Set(used).size).toBe(used.length);
  });

  it("maps Hungarian headers", () => {
    const m = autoMap(["Név", "Beosztás", "E-mail", "Cégnév", "Weboldal"]);
    expect(m.contactName).toBe(0);
    expect(m.title).toBe(1);
    expect(m.email).toBe(2);
    expect(m.companyName).toBe(3);
    expect(m.companyDomain).toBe(4);
  });

  it("leaves unmatched fields unmapped rather than guessing wildly", () => {
    const m = autoMap(["Foo", "Bar"]);
    expect(m.email).toBeUndefined();
    expect(m.contactName).toBeUndefined();
  });
});

describe("candidate extraction", () => {
  it("projects mapped columns and drops empty values", () => {
    const data = ok(SAMPLE);
    const candidates = toCandidates(data, autoMap(data.headers));
    expect(candidates[0]).toEqual({
      contactName: "Horváth Judit",
      title: "ügyvezető",
      email: "judit@aventa.hu",
      linkedinUrl: "https://linkedin.com/in/judit",
      companyName: "Aventa Logistics Kft.",
      companyDomain: "aventa.hu",
    });
    // The row with the empty title must still carry the RIGHT email.
    expect(candidates[1].email).toBe("peter@bimbo.hu");
    expect(candidates[1].title).toBeUndefined();
  });

  it("treats a row with nothing identifying as not importable", () => {
    expect(isImportable({})).toBe(false);
    expect(isImportable({ title: "CTO" })).toBe(false);
    expect(isImportable({ email: "a@b.hu" })).toBe(true);
    expect(isImportable({ companyName: "Alfa" })).toBe(true);
  });

  it("tolerates a short row without throwing", () => {
    const data = ok(["A,B,C", "only-one"].join("\n"));
    const candidates = toCandidates(data, { contactName: 0, email: 2 });
    expect(candidates[0]).toEqual({ contactName: "only-one" });
  });
});

describe("mapping validation", () => {
  it("blocks an empty mapping", () => {
    const data = ok(SAMPLE);
    expect(validateMapping(data, {})).toHaveLength(1);
  });

  it("blocks a mapping that yields no importable rows", () => {
    const data = ok(["A,B", ",", "x,y"].join("\n"));
    // Map only the title field — nothing identifying.
    const problems = validateMapping(data, { title: 0 });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0].message).toMatch(/column mapping/i);
  });

  it("passes a good mapping", () => {
    const data = ok(SAMPLE);
    expect(validateMapping(data, autoMap(data.headers))).toEqual([]);
  });
});
