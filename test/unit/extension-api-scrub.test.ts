import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The snapshot scrubber (re-architecture item 2).
 *
 * A snapshot has two jobs that pull against each other: keep enough SHAPE to
 * derive a field mapping from, and keep no PEOPLE, because it goes into version
 * control. Getting the balance wrong is silent in both directions — a snapshot
 * that leaks a real name is a GDPR problem, and one that scrubs the `$type`
 * discriminators is a file that cannot teach us anything.
 */
const SOURCE = readFileSync(join(process.cwd(), "extension/api-scrub.js"), "utf8");

interface Scrub {
  scrubSnapshot(input: {
    slug: string;
    records: unknown[];
    label?: string;
    note?: string;
  }): {
    snapshotVersion: number;
    slugShape: { tokens: number; abbreviated: boolean };
    label: string | null;
    recordCount: number;
    records: { url: string; body: unknown; parseError: string | null; bodySize: number }[];
  };
  scrubValue(v: unknown, key: string, replacer: unknown, depth?: number): unknown;
  createReplacer(): unknown;
}

function load(): Scrub {
  const g: { VentureApiScrub?: Scrub } = {};
  new Function("globalThis", "URL", SOURCE)(g, URL);
  if (!g.VentureApiScrub) throw new Error("api-scrub.js did not register VentureApiScrub");
  return g.VentureApiScrub;
}

const S = load();

/** A response shaped the way LinkedIn's are said to be — used only as a carrier. */
const BODY = {
  data: { "*elements": ["urn:li:fsd_profile:ACoAAB1234"] },
  included: [
    {
      $type: "com.linkedin.voyager.dash.identity.profile.Profile",
      entityUrn: "urn:li:fsd_profile:ACoAAB1234",
      firstName: "Mark",
      lastName: "Goldberger",
      headline: "VP Sales @ Metaview | Startup Advisor",
      publicIdentifier: "mgoldberger",
      profilePicture: {
        displayImageReference: {
          vectorImage: {
            rootUrl: "https://media.licdn.com/dms/image/v2/D5603AQFabc/",
            artifacts: [
              { width: 400, height: 400, fileIdentifyingUrlPathSegment: "profile-displayphoto-shrink_400_400/0/1700?e=1&v=beta&t=zzz" },
            ],
          },
        },
      },
    },
    {
      $type: "com.linkedin.voyager.dash.identity.profile.Position",
      entityUrn: "urn:li:fsd_profilePosition:(ACoAAB1234,987654)",
      companyName: "Metaview",
      title: "VP Sales",
      "*company": "urn:li:fsd_company:12345",
    },
    {
      $type: "com.linkedin.voyager.dash.identity.profile.Profile",
      entityUrn: "urn:li:fsd_profile:ACoAAB9999",
      firstName: "Dana",
      lastName: "Whitfield",
      publicIdentifier: "dwhitfield",
    },
  ],
};

function scrubOne() {
  return S.scrubSnapshot({
    slug: "mgoldberger",
    label: "abbreviated-slug",
    records: [
      {
        url: "https://www.linkedin.com/voyager/api/graphql?queryId=abc123&variables=(urn:ACoAAB1234)",
        method: "GET",
        status: 200,
        contentType: "application/json",
        bodySize: 1234,
        body: JSON.stringify(BODY),
      },
    ],
  });
}

describe("the people are gone", () => {
  const snap = scrubOne();
  const json = JSON.stringify(snap);

  it("removes every real name", () => {
    for (const name of ["Mark", "Goldberger", "Dana", "Whitfield"]) {
      expect(json, `the snapshot still contains "${name}"`).not.toContain(name);
    }
  });

  it("removes the vanity identifiers", () => {
    expect(json).not.toContain("mgoldberger");
    expect(json).not.toContain("dwhitfield");
  });

  it("removes the member ids from every urn", () => {
    expect(json).not.toContain("ACoAAB1234");
    expect(json).not.toContain("ACoAAB9999");
  });

  it("removes the image token", () => {
    expect(json).not.toContain("D5603AQFabc");
    expect(json).not.toContain("t=zzz");
  });

  it("reduces the query string to parameter NAMES", () => {
    const url = snap.records[0]!.url;
    expect(url).toContain("/voyager/api/graphql");
    expect(url).toContain("queryId=<scrubbed>");
    expect(url).not.toContain("abc123");
    expect(url).not.toContain("ACoAAB1234");
  });
});

describe("the shape survives, because it is the whole point", () => {
  const snap = scrubOne();
  const body = snap.records[0]!.body as typeof BODY;

  it("keeps every key and every array length", () => {
    expect(Object.keys(body)).toEqual(["data", "included"]);
    expect(body.included).toHaveLength(3);
    expect(Object.keys(body.included[0]!)).toEqual(Object.keys(BODY.included[0]!));
  });

  /** THE DISCRIMINATORS ARE SCHEMA, NOT IDENTITY. Scrubbing them ruins the file. */
  it("never touches a $type", () => {
    expect(body.included[0]!.$type).toBe("com.linkedin.voyager.dash.identity.profile.Profile");
    expect(body.included[1]!.$type).toBe("com.linkedin.voyager.dash.identity.profile.Position");
  });

  it("keeps values that are not identity — a headline, a company, a job title", () => {
    expect(body.included[0]!.headline).toBe("VP Sales @ Metaview | Startup Advisor");
    const position = body.included[1]! as unknown as { companyName: string; title: string };
    expect(position.companyName).toBe("Metaview");
    expect(position.title).toBe("VP Sales");
  });

  it("keeps an urn shaped like an urn, with its TYPE segment intact", () => {
    const urn = body.included[0]!.entityUrn;
    expect(urn).toMatch(/^urn:li:fsd_profile:/);
    expect(urn.split(":").length).toBe(BODY.included[0]!.entityUrn.split(":").length);
  });

  it("keeps the artifact dimensions, which are what the photo mapping selects on", () => {
    const artifacts = (body.included[0]! as unknown as {
      profilePicture: { displayImageReference: { vectorImage: { artifacts: { width: number }[] } } };
    }).profilePicture.displayImageReference.vectorImage.artifacts;
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.width).toBe(400);
  });
});

describe("replacement is referential", () => {
  const snap = scrubOne();
  const body = snap.records[0]!.body as typeof BODY;

  /**
   * An `included` array is a graph: entries point at each other by urn. If the
   * same urn scrubbed to two different placeholders the file could not teach us
   * how the cross-references work, which is most of what we need to learn.
   */
  it("maps one urn to one placeholder, everywhere it appears", () => {
    const inData = (body.data as { "*elements": string[] })["*elements"][0];
    const inIncluded = body.included[0]!.entityUrn;
    expect(inData).toBe(inIncluded);
  });

  it("maps two different people to two different placeholders", () => {
    expect(body.included[0]!.entityUrn).not.toBe(body.included[2]!.entityUrn);
    expect(body.included[0]!.firstName).not.toBe(body.included[2]!.firstName);
  });

  it("gives the profile's OWNER the recognisable placeholder", () => {
    // The first distinct name is the person the page is about.
    expect(body.included[0]!.firstName).toBe("Ödön");
    expect(body.included[0]!.lastName).toBe("Anonimizált");
  });

  it("keeps accents, so the accent-folding tests still have something to fold", () => {
    expect(JSON.stringify(snap)).toMatch(/[őűáéíóöúü]/i);
  });
});

describe("the snapshot's own metadata", () => {
  it("preserves the slug's SHAPE without the slug", () => {
    const snap = scrubOne();
    expect(snap.slugShape).toEqual({ tokens: 1, abbreviated: true });
    expect(JSON.stringify(snap)).not.toContain("mgoldberger");
  });

  it("records the label so a directory of snapshots is readable", () => {
    expect(scrubOne().label).toBe("abbreviated-slug");
  });

  it("survives a body that is not JSON at all", () => {
    const snap = S.scrubSnapshot({
      slug: "x",
      records: [
        {
          url: "https://www.linkedin.com/voyager/api/x",
          method: "GET",
          status: 200,
          contentType: "application/json",
          bodySize: 5,
          body: "<html>",
        },
      ],
    });
    expect(snap.records[0]!.parseError).toBeTruthy();
    expect(snap.records[0]!.body).toBeNull();
  });

  it("survives a body that was too big to copy", () => {
    const snap = S.scrubSnapshot({
      slug: "x",
      records: [
        {
          url: "https://www.linkedin.com/voyager/api/big",
          method: "GET",
          status: 200,
          contentType: "application/json",
          bodySize: 9_000_000,
          truncated: true,
          body: null,
        },
      ],
    });
    expect(snap.records[0]!.body).toBeNull();
    expect(snap.records[0]!.bodySize).toBe(9_000_000);
  });

  it("does not hang on a deeply nested body", () => {
    let deep: Record<string, unknown> = { firstName: "Mark" };
    for (let i = 0; i < 200; i += 1) deep = { nested: deep };
    const snap = S.scrubSnapshot({
      slug: "x",
      records: [
        {
          url: "https://www.linkedin.com/voyager/api/deep",
          method: "GET",
          status: 200,
          contentType: "application/json",
          bodySize: 10,
          body: JSON.stringify(deep),
        },
      ],
    });
    expect(snap.records[0]!.parseError).toBeNull();
  });
});

/**
 * ── THE RSC FLIGHT PAYLOAD ──────────────────────────────────────────────────
 *
 * LinkedIn's profile moved onto React Server Components, and its payload is not
 * a JSON document — it is numbered rows, each holding a JSON fragment:
 *
 *     0:{"a":"$@1","b":"…"}
 *     1:I[54321,["static/chunks/profile.js"],"default"]
 *     2:["$","div",null,{…}]
 *
 * `JSON.parse` throws on the whole thing, so the scrubber used to record a
 * `parseError` and a null body. That failed SAFE — nothing personal reached a
 * committed file, which is the property that matters most — but it also meant
 * the snapshot carried nothing, so the payload could not be mapped.
 *
 * Both halves are required, and these tests pin both.
 */
describe("an RSC flight body", () => {
  const flight = [
    '0:{"name":"Sherzod Shermatov","headline":"CTO at Realbotix","entityUrn":"urn:li:fsd_profile:ACoAAB123"}',
    '1:I[54321,["static/chunks/app/profile-page.js"],"default"]',
    '2:["$","section",null,{"emailAddress":"sherzod@realbotix.example","className":"pv-top-card"}]',
    "3:not json at all, just text",
  ].join("\n");

  const scrub = () =>
    S.scrubSnapshot({
      slug: "sherzod-shermatov",
      records: [
        {
          url: "https://www.linkedin.com/flagship-web/rsc-action/actions/component?componentId=x",
          method: "POST",
          status: 200,
          contentType: "application/octet-stream",
          bodySize: flight.length,
          body: flight,
        },
      ],
      label: "rsc-profile",
    });

  it("parses it into rows instead of giving up", () => {
    const record = scrub().records[0]! as unknown as {
      bodyFormat: string;
      parseError: string | null;
      body: { format: string; rowCount: number; rows: unknown[] };
    };
    expect(record.parseError).toBeNull();
    expect(record.bodyFormat).toBe("rsc-flight");
    expect(record.body.format).toBe("rsc-flight");
    expect(record.body.rowCount).toBe(4);
  });

  it("keeps the row ids and tags, which are the format's structure", () => {
    const rows = (scrub().records[0]! as unknown as {
      body: { rows: Array<{ id: string | null; tag: string | null }> };
    }).body.rows;
    expect(rows.map((r) => r.id)).toEqual(["0", "1", "2", "3"]);
    // The single-letter tag distinguishes a module row from a data row.
    expect(rows[1]!.tag).toBe("I");
    expect(rows[0]!.tag).toBeNull();
  });

  /** THE PROPERTY THAT MATTERS: no person survives, in any row. */
  it("scrubs the people inside the fragments", () => {
    const json = JSON.stringify(scrub());
    for (const secret of [
      "Sherzod",
      "Shermatov",
      "sherzod@realbotix.example",
      "ACoAAB123",
    ]) {
      expect(json, `${secret} survived the scrub`).not.toContain(secret);
    }
  });

  /**
   * A fragment that does not parse is where a real name would survive, so it is
   * reported by LENGTH and never by text.
   */
  it("reports an unparsable row by length, never by content", () => {
    const rows = (scrub().records[0]! as unknown as {
      body: { rows: Array<{ id: string | null; unparsedLength?: number; value?: unknown }> };
    }).body.rows;
    const bad = rows.find((r) => r.id === "3")!;
    expect(bad.unparsedLength).toBeGreaterThan(0);
    expect(bad.value).toBeUndefined();
    expect(JSON.stringify(bad)).not.toContain("not json at all");
  });

  it("keeps the discriminators that make the payload readable", () => {
    // The urn is replaced, but it is still a urn of the same type — that part is
    // schema, not identity.
    const json = JSON.stringify(scrub());
    expect(json).toContain("urn:li:fsd_profile:");
    expect(json).toContain("static/chunks");
  });

  it("still says so when a body is neither JSON nor flight", () => {
    const out = S.scrubSnapshot({
      slug: "x",
      records: [
        {
          url: "https://www.linkedin.com/blob",
          method: "POST",
          status: 200,
          contentType: "application/octet-stream",
          bodySize: 5,
          body: "opaque bytes",
        },
      ],
    });
    const record = out.records[0]! as unknown as { parseError: string | null; body: unknown };
    expect(record.parseError).toBe("NotJsonOrFlight");
    expect(record.body).toBeNull();
  });
});

/**
 * ── THE TWO THINGS A SYNTHETIC FIXTURE DID NOT CATCH ────────────────────────
 *
 * The RSC tests above used a fragment shaped like `{"name":"…","emailAddress":"…"}`
 * — an object with meaningful keys. Real flight rows do not look like that, and
 * the first real snapshot went through a "working" scrubber carrying 52
 * strangers' slugs, 126 member ids, a live email address, a mobile number and
 * 1351 name occurrences.
 *
 * These use the shapes that actually occur. Both were live leaks.
 */
describe("the shapes that leaked from a real payload", () => {
  const scrubOne = (body: string) =>
    JSON.stringify(
      S.scrubSnapshot({
        slug: "tom-vechy-vecsernyes",
        records: [
          {
            url: "https://www.linkedin.com/flagship-web/in/tom-vechy-vecsernyes/",
            method: "POST",
            status: 200,
            contentType: "application/octet-stream",
            bodySize: body.length,
            body,
          },
        ],
        label: "regression",
      }),
    );

  /**
   * LEAK 1: a first name alone is shape-identical to a component name.
   *
   * `"Tom"` matched the PascalCase rule and was kept as structure, 1351 times
   * over. It is only recoverable because the SLUG is in the payload and spells
   * out its own tokens — so the slug's parts became redaction targets.
   */
  it("redacts a first name that looks exactly like a PascalCase token", () => {
    const out = scrubOne(
      '0:["$","div",null,{"modelStates":[{"value":{"stringValue":"Tom"}},' +
        '{"value":{"stringValue":"Vecsernyes"}}],"componentName":"ProfileTopCard"}]',
    );
    expect(out).not.toMatch(/\bTom\b/);
    expect(out).not.toMatch(/Vecsernyes/i);
    // And a real component name of the same shape is untouched.
    expect(out).toContain("ProfileTopCard");
  });

  /**
   * LEAK 2: a phone number is "just digits and punctuation".
   *
   * The structural rule for numeric strings had no length bound, so a Hungarian
   * mobile came through intact while every short layout value ("0.5x", "1:1")
   * needed to be kept.
   */
  it("redacts a phone number but keeps short numeric layout values", () => {
    const out = scrubOne(
      '0:["$","span",null,{"phone":"+36308902438","scale":"0.5x","ratio":"1:1","span":"12"}]',
    );
    expect(out).not.toContain("36308902438");
    expect(out).toContain("0.5x");
    expect(out).toContain("1:1");
  });

  /** LEAK 3: the slug in the URL PATH — only the query string was scrubbed. */
  it("scrubs the profile slug out of the record's own url", () => {
    const out = scrubOne('0:{"a":1}');
    expect(out).not.toContain("tom-vechy-vecsernyes");
    expect(out).toContain("/in/");
  });

  /** LEAK 4: a member id concatenated onto a structural name. */
  it("strips a member id even when it is glued to something structural", () => {
    const out = scrubOne(
      '0:{"key":"ACoAACSmga4B13yH9cuPcCC2w4f4dcEC22p95XkContactInfoDetailSection"}',
    );
    expect(out).not.toContain("ACoAACSmga4B");
    // The structural half survives, because that part is schema.
    expect(out).toContain("ContactInfoDetailSection");
  });

  /**
   * And the other half: a discriminator the mapping needs must NOT be redacted.
   * A fixture can be perfectly clean and completely useless.
   */
  it("keeps the viewName that says which contact field a subtree is", () => {
    const out = scrubOne(
      '0:["$","div",null,{"viewTrackingSpecs":{"viewName":"contact-email"},' +
        '"children":"tom.vechy@seyu.hu"}]',
    );
    expect(out).toContain("contact-email");
    expect(out).not.toContain("tom.vechy@seyu.hu");
    expect(out).toContain("<email>");
  });
});

/**
 * ── THE VOCABULARY A SNAPSHOT MUST KEEP ─────────────────────────────────────
 *
 * Measured against a full 20-record capture, the first allow-list was redacting
 * the payload's own vocabulary: 7543 of 7563 `$type` values and 279 of 285
 * `legacyControlName` values. `$type` is the primary semantic discriminator in an
 * SDUI payload and `legacyControlName` is one of the two names the contact
 * mapping keys off — so the fixture came out clean and useless, which is the
 * failure this file's own documentation warns about.
 */
describe("the payload's vocabulary survives", () => {
  const scrub = (body: string, slug = "tom-vechy-vecsernyes") =>
    JSON.stringify(
      S.scrubSnapshot({
        slug,
        records: [
          {
            url: "https://www.linkedin.com/flagship-web/rsc-action/actions/component",
            method: "POST",
            status: 200,
            contentType: "application/octet-stream",
            bodySize: body.length,
            body,
          },
        ],
      }),
    );

  it("keeps a dotted namespace, which is what $type is", () => {
    const out = scrub(
      '0:{"$type":"proto.sdui.actions.core.Navigate","inner":{"$type":"com.linkedin.sdui.requests.profile.fetchProfile"}}',
    );
    expect(out).toContain("proto.sdui.actions.core.Navigate");
    expect(out).toContain("com.linkedin.sdui.requests.profile.fetchProfile");
  });

  it("keeps SCREAMING_SNAKE enum values", () => {
    const out = scrub('0:{"presentationStyle":"PRESENTATION_STYLE_DEFAULT","press":"SHORT_PRESS"}');
    expect(out).toContain("PRESENTATION_STYLE_DEFAULT");
    expect(out).toContain("SHORT_PRESS");
  });

  it("keeps snake_case identifiers, including the contact discriminators", () => {
    const out = scrub('0:{"legacyControlName":"contact_email","pageKey":"d_flagship3_profile_view_base"}');
    expect(out).toContain("contact_email");
    expect(out).toContain("d_flagship3_profile_view_base");
  });

  /**
   * And the door those three opened, closed. A slug token EMBEDDED in an
   * identifier is not caught by the whole-string token replacement, and
   * snake_case, kebab and dotted paths are exactly the shapes a name can hide in.
   */
  it("still redacts an identifier that carries a name inside it", () => {
    const out = scrub('0:{"a":"tom_vechy_profile_card","b":"profile-load-vecsernyes","c":"x.y.vechy"}');
    expect(out).not.toMatch(/vechy/i);
    expect(out).not.toMatch(/vecsernyes/i);
    // A genuine identifier of the same shape is untouched.
    expect(scrub('0:{"a":"profile_card_experience"}')).toContain("profile_card_experience");
  });
});

/**
 * ── RUNNING IT TWICE MUST NOT CHANGE THE ANSWER ─────────────────────────────
 *
 * `scripts/rescrub-snapshot.ts` exists so a snapshot recorded before a scrubber
 * fix can be brought up to date without asking somebody for another ten-minute
 * browser session. Its first version was not idempotent in two ways, and both
 * damaged the fixture rather than the privacy:
 *
 *   · it re-placeholdered its own output — `<text:24>` became `<text:9>`, then
 *     `<text:8>` — so each run shrank the one thing a redacted value still
 *     carried, which is how long the original was;
 *   · it handed an already-placeholdered slug a FRESH cast name, so a record
 *     whose url said `odon-anonimizalt` had a body saying `cecilia-proba`. A
 *     fixture that contradicts itself teaches something false.
 */
describe("scrubbing twice changes nothing", () => {
  const body =
    '0:{"$type":"proto.sdui.components.core.Text","firstName":"Tom","lastName":"Vecsernyes",' +
    '"vanityName":"tom-vechy-vecsernyes","url":"https://example.com/a/b","note":"a longer free sentence"}';
  const once = () =>
    S.scrubSnapshot({
      slug: "tom-vechy-vecsernyes",
      records: [
        {
          url: "https://www.linkedin.com/flagship-web/in/tom-vechy-vecsernyes/",
          method: "POST",
          status: 200,
          contentType: "application/octet-stream",
          bodySize: body.length,
          body,
        },
      ],
    });

  it("a placeholder survives a second pass unchanged", () => {
    const first = once().records[0]! as unknown as { body: { rows: Array<{ value: Record<string, string> }> } };
    const value = first.body.rows[0]!.value;
    // Feed the scrubbed row back through the flight walker.
    const replacer = (S as unknown as { createReplacer(): unknown }).createReplacer();
    const again = (S as unknown as {
      scrubFlightBody(row: unknown, replacer: unknown, url: string): { value: Record<string, string> };
    }).scrubFlightBody({ id: "0", tag: null, value }, replacer, "https://x/in/tom-vechy-vecsernyes/");
    expect(again.value).toEqual(value);
  });

  it("keeps a name key redacted and a slug key stable", () => {
    const row = (once().records[0]! as unknown as {
      body: { rows: Array<{ value: Record<string, string> }> };
    }).body.rows[0]!.value;
    expect(row.firstName).not.toBe("Tom");
    expect(row.lastName).not.toMatch(/Vecsernyes/i);
    // The slug key resolves to the same placeholder the url uses.
    expect(row.vanityName).toMatch(/^[a-z]+-[a-z]+$/);
    expect(row.vanityName).not.toMatch(/vechy/i);
    // And the payload's own vocabulary is untouched.
    expect(row.$type).toBe("proto.sdui.components.core.Text");
  });
});
