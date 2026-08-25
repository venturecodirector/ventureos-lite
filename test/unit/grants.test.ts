import { describe, it, expect } from "vitest";
import {
  GRANTS,
  DOCUMENT_GRANTS,
  grantAllowed,
  isTrustedMember,
} from "../../src/lib/grants";

/**
 * Who may do what (spec §3, CLAUDE.md hard rule #7).
 *
 * The rule changed deliberately: a BDR now carries everything an Admin does,
 * with two exceptions. Documents — quotes, contracts, certificates, the
 * templates they are rendered from, and sending any of them — still need the
 * grant handed over one by one. User management is not a grant at all: it sits
 * behind `requireOwner`, so no role short of Owner reaches it.
 */
describe("grantAllowed (server-side grant denial)", () => {
  it("Owner and Admin carry every grant implicitly", () => {
    for (const grant of GRANTS) {
      expect(grantAllowed("OWNER", [], grant), grant).toBe(true);
      expect(grantAllowed("ADMIN", [], grant), grant).toBe(true);
    }
  });

  /**
   * The widening. A BDR needed an explicit grant to run an export, approve a
   * signal, add a workspace field or merge two obvious duplicates — daily work,
   * gated as though it were a legal document.
   */
  it("a BDR carries the everyday capabilities without being granted them", () => {
    for (const grant of GRANTS.filter((g) => !DOCUMENT_GRANTS.includes(g))) {
      expect(grantAllowed("BDR", [], grant), grant).toBe(true);
    }
    expect(grantAllowed("BDR", [], "exports.run")).toBe(true);
    expect(grantAllowed("BDR", [], "signal_engine.approve")).toBe(true);
    expect(grantAllowed("BDR", [], "fields.manage")).toBe(true);
    expect(grantAllowed("BDR", [], "data.merge")).toBe(true);
  });

  it("a BDR is still refused every document capability until it is granted", () => {
    for (const grant of DOCUMENT_GRANTS) {
      expect(grantAllowed("BDR", [], grant), grant).toBe(false);
    }
    expect(grantAllowed("BDR", [], "documents.send")).toBe(false);
    // Templates decide what every future document SAYS, so they are on the
    // document side of the line rather than the everyday side.
    expect(grantAllowed("BDR", [], "templates.edit")).toBe(false);
  });

  it("a granted document capability is allowed, and only that one", () => {
    expect(grantAllowed("BDR", ["documents.quote.create"], "documents.quote.create")).toBe(true);
    expect(grantAllowed("BDR", ["documents.quote.create"], "documents.contract.create")).toBe(
      false,
    );
    expect(grantAllowed("BDR", ["documents.quote.create"], "documents.send")).toBe(false);
  });

  it("a role nobody recognises is refused everything it was not handed", () => {
    expect(grantAllowed("GUEST", [], "exports.run")).toBe(false);
    expect(grantAllowed("", [], "data.merge")).toBe(false);
    expect(grantAllowed("GUEST", ["exports.run"], "exports.run")).toBe(true);
  });

  it("every document grant is a real grant, so a typo cannot widen the set", () => {
    for (const grant of DOCUMENT_GRANTS) {
      expect(GRANTS, grant).toContain(grant);
    }
  });
});

describe("isTrustedMember", () => {
  it("admits every seated role and nobody else", () => {
    expect(isTrustedMember("OWNER")).toBe(true);
    expect(isTrustedMember("ADMIN")).toBe(true);
    expect(isTrustedMember("BDR")).toBe(true);
    expect(isTrustedMember(null)).toBe(false);
    expect(isTrustedMember(undefined)).toBe(false);
    expect(isTrustedMember("GUEST")).toBe(false);
  });
});
