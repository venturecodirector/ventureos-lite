import { describe, it, expect } from "vitest";
import { grantAllowed } from "../../src/lib/grants";

describe("grantAllowed (server-side grant denial)", () => {
  it("Owner and Admin carry every grant implicitly", () => {
    expect(grantAllowed("OWNER", [], "documents.quote.create")).toBe(true);
    expect(grantAllowed("ADMIN", [], "templates.edit")).toBe(true);
  });

  it("a BDR without the grant is denied", () => {
    expect(grantAllowed("BDR", [], "documents.quote.create")).toBe(false);
  });

  it("a BDR is allowed only the grants explicitly assigned", () => {
    expect(
      grantAllowed("BDR", ["documents.quote.create"], "documents.quote.create"),
    ).toBe(true);
    expect(
      grantAllowed("BDR", ["documents.quote.create"], "documents.contract.create"),
    ).toBe(false);
  });
});
