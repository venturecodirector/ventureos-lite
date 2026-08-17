import { describe, it, expect } from "vitest";
import { validateRows, type ExistingRow } from "../../src/modules/import/validate";
import type { CsvCandidate } from "../../src/modules/leads/csv";
import type { FieldDef } from "../../src/modules/fields/types";

/**
 * Row validation (playbook-v2 P5/3). The v1 import had one verdict per row and
 * silently dropped everything else; every assertion here is about a row getting
 * a REASON instead.
 */
function existing(over: Partial<ExistingRow> = {}): ExistingRow {
  return { id: "l1", email: null, linkedinUrl: null, companyDomain: null, ...over };
}

function row(over: Partial<CsvCandidate> = {}): CsvCandidate {
  return { contactName: "Kovács Anna", ...over };
}

describe("row validation", () => {
  it("passes a clean new row", () => {
    const res = validateRows([row({ email: "anna@danubia.hu" })], []);
    expect(res.newCount).toBe(1);
    expect(res.rows[0].problems).toEqual([]);
  });

  it("names a bad email rather than dropping the row silently", () => {
    const res = validateRows([row({ email: "anna(at)danubia.hu" })], []);
    expect(res.skipCount).toBe(1);
    expect(res.rows[0].problems[0].code).toBe("bad_email");
    expect(res.rows[0].problems[0].message).toContain("anna(at)danubia.hu");
  });

  it("names a URL without a scheme", () => {
    const res = validateRows([row({ linkedinUrl: "linkedin.com/in/anna" })], []);
    expect(res.rows[0].problems[0].code).toBe("bad_url");
  });

  it("refuses a row with nothing identifying in it", () => {
    const res = validateRows([{ title: "CEO" }], []);
    expect(res.rows[0].problems[0].code).toBe("no_identity");
    expect(res.rows[0].status).toBe("skip");
  });

  it("catches a duplicate inside the file itself", () => {
    const res = validateRows(
      [row({ email: "anna@danubia.hu" }), row({ email: "ANNA@danubia.hu" })],
      [],
    );
    expect(res.rows[0].problems).toEqual([]);
    expect(res.rows[1].problems[0].code).toBe("duplicate_in_file");
  });

  it("matches an existing lead by email, LinkedIn URL, then company domain", () => {
    const rows = validateRows(
      [
        row({ email: "anna@danubia.hu" }),
        row({ linkedinUrl: "https://linkedin.com/in/anna" }),
        row({ companyDomain: "https://www.danubia.hu/" }),
      ],
      [
        existing({ id: "by-email", email: "anna@danubia.hu" }),
        existing({ id: "by-li", linkedinUrl: "https://linkedin.com/in/anna" }),
        existing({ id: "by-domain", companyDomain: "danubia.hu" }),
      ],
    ).rows;
    expect(rows[0].existingLeadId).toBe("by-email");
    expect(rows[1].existingLeadId).toBe("by-li");
    expect(rows[2].existingLeadId).toBe("by-domain");
  });

  it("skips a workspace duplicate in skip mode and updates it in update mode", () => {
    const candidates = [row({ email: "anna@danubia.hu" })];
    const rows = [existing({ email: "anna@danubia.hu" })];

    const skipMode = validateRows(candidates, rows, { mode: "skip" });
    expect(skipMode.rows[0].status).toBe("skip");
    expect(skipMode.rows[0].problems[0].code).toBe("duplicate_in_workspace");

    const updateMode = validateRows(candidates, rows, { mode: "update" });
    expect(updateMode.rows[0].status).toBe("update");
    expect(updateMode.updateCount).toBe(1);
  });

  it("validates custom-field cells against the definitions", () => {
    const defs: FieldDef[] = [
      {
        id: "f1",
        entity: "lead",
        key: "band",
        label: "Band",
        type: "SELECT",
        options: [{ value: "a", label: "A" }],
        required: false,
        archived: false,
        position: 0,
        help: null,
      },
    ];
    const res = validateRows([row({ customFields: { band: "z" } })], [], {
      customFields: defs,
    });
    expect(res.rows[0].status).toBe("skip");
    expect(res.rows[0].problems[0].code).toBe("custom_field");
    expect(res.rows[0].problems[0].message).toContain("Band");
  });

  it("counts problems by code for the summary line", () => {
    const res = validateRows(
      [row({ email: "nope" }), row({ email: "also-nope" }), { title: "CEO" }],
      [],
    );
    expect(res.byCode.bad_email).toBe(2);
    expect(res.byCode.no_identity).toBe(1);
  });

  it("reports the file-row index, so the operator can find the line", () => {
    const res = validateRows([row(), row({ email: "nope" })], []);
    expect(res.rows[1].index).toBe(1);
  });
});
