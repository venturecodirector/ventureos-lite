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
