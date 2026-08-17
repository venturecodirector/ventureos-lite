import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { captureBodySchema } from "../../src/modules/capture/body";
import {
  normalizeEmail,
  normalizePhone,
  normalizeWebsite,
  phoneQualifier,
  pickCompanyWebsite,
} from "../../src/modules/capture/contact";
import { resolveContact } from "../../src/modules/capture/resolve-contact";

/**
 * Email, phone and website — the three fields that are NOT on a LinkedIn
 * profile page.
 *
 * The diagnostics settled that: zero mailto: links, zero tel: links, no outbound
 * hosts. They live behind the contact-info overlay, which is why the extension
 * opens it on an explicit capture. The reading is tested against the committed
 * overlay fixture; the deciding is tested here, because "which of three websites
 * is the company's" and "what is 06 1 234 5678 in E.164" are rules and rules are
 * where the mistakes live.
 */
const CONTACT_JS = readFileSync(join(process.cwd(), "extension/contact.js"), "utf8");
/**
 * The label parser now lives in its own module, so the state machine can reuse it
 * without also inheriting the clicking. contact.js requires it to be injected
 * first, exactly as the popup injects the pair.
 */
const CONTACT_PARSE_JS = readFileSync(join(process.cwd(), "extension/contact-parse.js"), "utf8");
const FIXTURE = join(process.cwd(), "test/fixtures/linkedin/c-contact-info-overlay.html");

interface Entries {
  email: string[];
  phone: { raw: string; qualifier: string | null }[];
  website: { url: string; qualifier: string | null }[];
  other: Record<string, string>;
}

async function readOverlay(html: string): Promise<{ ok: boolean; entries?: Entries; reason?: string }> {
  const dom = new JSDOM(html, { url: "https://www.linkedin.com/in/anna-kovacs-fixture/" });
  const g: Record<string, unknown> = {};
  new Function("globalThis", "document", "window", CONTACT_PARSE_JS)(
    g, dom.window.document, dom.window,
  );
  const fn = new Function(
    "document",
    "window",
    "KeyboardEvent",
    "setTimeout",
    "globalThis",
    `return (${CONTACT_JS.trim().replace(/;\s*$/, "")})`,
  );
  return await fn(
    dom.window.document, dom.window, dom.window.KeyboardEvent, dom.window.setTimeout, g,
  );
}

describe("reading the overlay — fixture (c)", () => {
  it("finds the email, phone and both websites", async () => {
    const res = await readOverlay(readFileSync(FIXTURE, "utf8"));
    expect(res.ok).toBe(true);
    expect(res.entries!.email).toEqual(["Anna.Kovacs@Danubia-Fogaszat.HU"]);
    expect(res.entries!.phone[0]!.raw).toBe("06 1 234 5678");
    expect(res.entries!.website.map((w) => w.url)).toEqual([
      "https://www.danubia-fogaszat.hu",
      "https://annakovacs.example",
    ]);
  });

  it("maps by LABEL, so a birthday never lands in a phone field", async () => {
    const res = await readOverlay(readFileSync(FIXTURE, "utf8"));
    // "Birthday: July 12" and "Connected: March 4, 2024" are both present and
    // both parse as neither a phone nor an email.
    expect(res.entries!.other.birthday).toContain("July 12");
    expect(res.entries!.phone.every((p) => !/july|march/i.test(p.raw))).toBe(true);
    expect(res.entries!.email.every((e) => !/july|march/i.test(e))).toBe(true);
  });

  it("keeps the qualifier so (Mobile) and (Company) survive to the decision", async () => {
    const res = await readOverlay(readFileSync(FIXTURE, "utf8"));
    expect(res.entries!.phone[0]!.qualifier).toContain("Mobile");
    expect(res.entries!.website[0]!.qualifier).toContain("Company");
  });

  it("says why, rather than nothing, when the page has no trigger and no overlay", async () => {
    const res = await readOverlay(
      `<!doctype html><html><body><main><section><div>Nothing here</div></section></main></body></html>`,
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("no_contact_info_trigger");
  });
});

describe("email", () => {
  it("lowercases, because addresses are compared and deduped", () => {
    expect(normalizeEmail("Anna.Kovacs@Danubia-Fogaszat.HU").value).toBe(
      "anna.kovacs@danubia-fogaszat.hu",
    );
  });

  it("strips a mailto: prefix", () => {
    expect(normalizeEmail("mailto:anna@danubia.hu").value).toBe("anna@danubia.hu");
  });

  it.each([
    ["not-an-email", "email_not_a_valid_address"],
    ["two@@at.example", "email_not_a_valid_address"],
    ["no-domain@localhost", "email_not_a_valid_address"],
    ["dots@double..example", "email_not_a_valid_address"],
    ["no-reply@linkedin.com", "email_is_linkedins_own"],
    ["", "no_email_found"],
  ])("refuses %s", (input, reason) => {
    expect(normalizeEmail(input)).toEqual({ value: null, reason });
  });
});

describe("phone, in E.164 with Hungarian defaults", () => {
  it.each([
    // Budapest: area code 1 plus seven digits, so +36 and EIGHT digits.
    ["06 1 234 5678", "+3612345678"],
    ["+36 30 123 4567", "+36301234567"],
    ["(06) 1/234-5678", "+3612345678"],
    ["0036 30 123 4567", "+36301234567"],
    ["30 123 4567", "+36301234567"],
    ["+44 20 7123 4567", "+442071234567"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizePhone(input).value).toBe(expected);
  });

  it.each([
    ["12345", "phone_too_short"],
    ["+36 1 2", "phone_too_short"],
    ["+36 1 234 5678 999", "phone_wrong_length_for_hungary"],
    ["no digits at all", "phone_had_no_digits"],
    ["", "no_phone_found"],
  ])("refuses %s", (input, reason) => {
    expect(normalizePhone(input)).toEqual({ value: null, reason });
  });

  it("keeps the qualifier as a note, since it changes how you use the number", () => {
    expect(phoneQualifier("06 1 234 5678 (Mobile)")).toBe("mobile");
    expect(phoneQualifier("06 1 234 5678 (Home)")).toBe("home");
    expect(phoneQualifier("06 1 234 5678")).toBeNull();
  });
});

describe("website", () => {
  it("reduces to an origin, so two spellings of one site match", () => {
    expect(normalizeWebsite("www.danubia-fogaszat.hu/kapcsolat?utm=x").value).toBe(
      "https://danubia-fogaszat.hu",
    );
    expect(normalizeWebsite("https://Danubia-Fogaszat.hu").value).toBe(
      "https://danubia-fogaszat.hu",
    );
  });

  it("refuses LinkedIn's own addresses", () => {
    expect(normalizeWebsite("https://www.linkedin.com/in/someone").reason).toBe(
      "website_is_linkedins_own",
    );
    expect(normalizeWebsite("https://lnkd.in/abc").reason).toBe("website_is_linkedins_own");
  });

  it("prefers the company site over the personal one", () => {
    // A lead's company domain feeds enrichment and dedupe, so a personal blog in
    // that field is actively harmful, not merely untidy.
    const picked = pickCompanyWebsite([
      { url: "https://annakovacs.example", qualifier: "annakovacs.example (Personal)" },
      { url: "https://www.danubia-fogaszat.hu", qualifier: "www.danubia-fogaszat.hu (Company)" },
    ]);
    expect(picked.value).toBe("https://danubia-fogaszat.hu");
    expect(picked.all).toHaveLength(2);
  });

  it("takes the first when every candidate is personal, rather than inventing a preference", () => {
    const picked = pickCompanyWebsite([
      { url: "https://a.example", qualifier: "(Personal)" },
      { url: "https://b.example", qualifier: "(Blog)" },
    ]);
    expect(picked.value).toBe("https://a.example");
  });
});

describe("resolving a whole capture body", () => {
  const body = (contact: unknown) =>
    captureBodySchema.parse({
      url: "https://www.linkedin.com/in/anna-kovacs-fixture",
      name: "Kovács Anna",
      posts: [],
      contact,
    });

  it("picks one of each and records the qualifier", () => {
    const r = resolveContact(
      body({
        emails: ["Anna.Kovacs@Danubia-Fogaszat.HU"],
        phones: [{ raw: "06 1 234 5678", qualifier: "06 1 234 5678 (Mobile)" }],
        websites: [
          { url: "https://annakovacs.example", qualifier: "(Personal)" },
          { url: "https://www.danubia-fogaszat.hu", qualifier: "(Company)" },
        ],
      }),
    );
    expect(r.email).toBe("anna.kovacs@danubia-fogaszat.hu");
    expect(r.phone).toBe("+3612345678");
    expect(r.phoneNote).toBe("mobile");
    expect(r.websiteUrl).toBe("https://danubia-fogaszat.hu");
    expect(r.allWebsites).toHaveLength(2);
  });

  it("skips a bad candidate and takes the next good one", () => {
    const r = resolveContact(
      body({ emails: ["no-reply@linkedin.com", "anna@danubia.hu"] }),
    );
    expect(r.email).toBe("anna@danubia.hu");
  });

  it("reports a reason per empty field, so a blank box is never ambiguous", () => {
    const r = resolveContact(body(undefined));
    expect(r.email).toBeNull();
    expect(r.reasons.email).toBe("no_email_in_overlay");
    expect(r.reasons.phone).toBe("no_phone_in_overlay");
    expect(r.reasons.websiteUrl).toBe("no_website_in_overlay");
  });

  it("names the validation failure when a candidate existed but was unusable", () => {
    const r = resolveContact(body({ phones: [{ raw: "123", qualifier: null }] }));
    expect(r.phone).toBeNull();
    expect(r.reasons.phone).toBe("phone_too_short");
  });
});
