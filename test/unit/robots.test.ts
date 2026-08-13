import { describe, it, expect } from "vitest";
import { parseRobots, isAllowed, VENTURE_USER_AGENT } from "@/lib/robots";

/**
 * We fetch other people's sites, so we obey their rules. Getting this wrong is
 * not a bug in our product, it is bad manners on someone else's server — and
 * for the sector batch it would be at scale.
 */
const UA = VENTURE_USER_AGENT;

describe("parseRobots", () => {
  it("returns permissive rules for an empty file", () => {
    const r = parseRobots("", UA);
    expect(isAllowed(r, "/anything")).toBe(true);
  });

  it("applies the wildcard group", () => {
    const r = parseRobots("User-agent: *\nDisallow: /admin", UA);
    expect(isAllowed(r, "/admin")).toBe(false);
    expect(isAllowed(r, "/about")).toBe(true);
  });

  it("prefers a group naming us over the wildcard", () => {
    const txt = [
      "User-agent: *",
      "Disallow: /",
      "",
      `User-agent: ${UA}`,
      "Disallow: /private",
    ].join("\n");
    const r = parseRobots(txt, UA);
    expect(isAllowed(r, "/about")).toBe(true);
    expect(isAllowed(r, "/private")).toBe(false);
  });

  it("groups consecutive user-agent lines together", () => {
    const txt = ["User-agent: SomeBot", `User-agent: ${UA}`, "Disallow: /x"].join("\n");
    const r = parseRobots(txt, UA);
    expect(isAllowed(r, "/x")).toBe(false);
  });

  it("ignores comments and blank lines", () => {
    const r = parseRobots("# hello\nUser-agent: *   # all\nDisallow: /admin # secret", UA);
    expect(isAllowed(r, "/admin")).toBe(false);
  });

  it("reads crawl-delay", () => {
    expect(parseRobots("User-agent: *\nCrawl-delay: 5", UA).crawlDelay).toBe(5);
    expect(parseRobots("User-agent: *\nCrawl-delay: nonsense", UA).crawlDelay).toBeNull();
  });

  it("treats an empty Disallow as permission", () => {
    const r = parseRobots("User-agent: *\nDisallow:", UA);
    expect(isAllowed(r, "/anything")).toBe(true);
  });
});

describe("isAllowed precedence", () => {
  it("lets the longest match win", () => {
    const r = parseRobots("User-agent: *\nDisallow: /files\nAllow: /files/public", UA);
    expect(isAllowed(r, "/files/secret.pdf")).toBe(false);
    expect(isAllowed(r, "/files/public/report.pdf")).toBe(true);
  });

  it("gives Allow the tie", () => {
    const r = parseRobots("User-agent: *\nDisallow: /x\nAllow: /x", UA);
    expect(isAllowed(r, "/x")).toBe(true);
  });

  it("handles wildcards", () => {
    const r = parseRobots("User-agent: *\nDisallow: /*.pdf", UA);
    expect(isAllowed(r, "/docs/a.pdf")).toBe(false);
    expect(isAllowed(r, "/docs/a.html")).toBe(true);
  });

  it("handles end-of-path anchors", () => {
    const r = parseRobots("User-agent: *\nDisallow: /*.php$", UA);
    expect(isAllowed(r, "/index.php")).toBe(false);
    expect(isAllowed(r, "/index.php?safe=1")).toBe(true);
  });

  it("blocks the whole site when told to", () => {
    const r = parseRobots("User-agent: *\nDisallow: /", UA);
    expect(isAllowed(r, "/")).toBe(false);
    expect(isAllowed(r, "/anything/at/all")).toBe(false);
  });

  it("defaults an empty path to the root", () => {
    const r = parseRobots("User-agent: *\nDisallow: /", UA);
    expect(isAllowed(r, "")).toBe(false);
  });
});
