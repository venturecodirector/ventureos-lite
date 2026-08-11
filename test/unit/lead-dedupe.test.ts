import { describe, it, expect } from "vitest";
import {
  normalizeEmail,
  normalizeDomain,
  findDuplicate,
  dedupePreview,
} from "../../src/modules/leads/dedupe";

describe("normalization", () => {
  it("lowercases and trims emails", () => {
    expect(normalizeEmail(" Bob@Example.COM ")).toBe("bob@example.com");
    expect(normalizeEmail("")).toBeNull();
  });

  it("strips scheme/www/path/case from domains and URLs", () => {
    expect(normalizeDomain("https://WWW.Example.com/contact")).toBe("example.com");
    expect(normalizeDomain("Example.com")).toBe("example.com");
    expect(normalizeDomain("http://example.com")).toBe("example.com");
  });
});

describe("findDuplicate (spec §4.2 — same person/domain)", () => {
  const existing = [
    { id: "A", email: "a@x.com", linkedinUrl: null, companyDomain: "x.com" },
  ];

  it("matches by email (case-insensitive)", () => {
    expect(findDuplicate({ email: "A@X.com" }, existing)?.id).toBe("A");
  });

  it("matches by company domain (URL vs bare)", () => {
    expect(findDuplicate({ companyDomain: "https://x.com" }, existing)?.id).toBe("A");
  });

  it("matches by LinkedIn URL", () => {
    const ex = [{ id: "B", linkedinUrl: "https://linkedin.com/in/bob/" }];
    expect(
      findDuplicate({ linkedinUrl: "https://www.linkedin.com/in/bob" }, ex)?.id,
    ).toBe("B");
  });

  it("returns null when nothing matches", () => {
    expect(findDuplicate({ email: "z@z.com", companyDomain: "z.com" }, existing)).toBeNull();
  });
});

describe("dedupePreview (CSV import preview)", () => {
  it("flags duplicates against existing rows and within the batch", () => {
    const existing = [{ id: "A", email: "a@x.com", companyDomain: "x.com" }];
    const rows = [
      { email: "a@x.com" }, // dup of existing — email
      { email: "new@y.com", companyDomain: "y.com" }, // new
      { email: "new@y.com" }, // dup within batch
      { companyDomain: "X.com" }, // dup of existing — domain
    ];
    const res = dedupePreview(rows, existing);
    expect(res[0]).toMatchObject({ status: "duplicate", reason: "email" });
    expect(res[1]).toMatchObject({ status: "new" });
    expect(res[2]).toMatchObject({ status: "duplicate" });
    expect(res[3]).toMatchObject({ status: "duplicate", reason: "domain" });
    expect(res.filter((r) => r.status === "new")).toHaveLength(1);
  });
});
