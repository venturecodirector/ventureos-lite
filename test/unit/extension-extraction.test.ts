import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The extension's extraction, run as the real file (P1/1e).
 *
 * This exists because the first version read only CSS class names, LinkedIn
 * changed them, and every capture came back with nothing but a URL — a lead
 * called "unknown" with no data. A test over a page whose classes have all been
 * renamed is the only thing that would have caught it, so that is the central
 * case below.
 *
 * content.js is injected, not imported, so it is evaluated here as source
 * against a hand-built fake document. That keeps the shipped file standalone —
 * exactly as the browser gets it — with no build step or duplicated logic.
 */
const SOURCE = readFileSync(join(process.cwd(), "extension/content.js"), "utf8");

interface FakeEl {
  textContent?: string;
  src?: string;
  getAttribute?(name: string): string | null;
  querySelector?(sel: string): FakeEl | null;
}

/** Just enough DOM for the layers under test. */
function fakeDocument(opts: {
  title?: string;
  jsonLd?: unknown;
  meta?: Record<string, string>;
  css?: Record<string, string>;
}) {
  const metaTags = opts.meta ?? {};
  const css = opts.css ?? {};

  const match = (sel: string): FakeEl | null => {
    const metaProp = /^meta\[(?:property|name)="([^"]+)"\]$/.exec(sel);
    if (metaProp) {
      const value = metaTags[metaProp[1]!];
      return value === undefined
        ? null
        : { getAttribute: () => value, textContent: value };
    }
    // CSS selectors are matched literally against what the test supplied.
    for (const [key, value] of Object.entries(css)) {
      if (sel === key) return { textContent: value, src: value };
    }
    return null;
  };

  return {
    title: opts.title ?? "",
    querySelector: match,
    querySelectorAll: (sel: string): FakeEl[] => {
      if (sel === 'script[type="application/ld+json"]') {
        return opts.jsonLd === undefined
          ? []
          : [{ textContent: JSON.stringify(opts.jsonLd) }];
      }
      return [];
    },
  };
}

function run(doc: ReturnType<typeof fakeDocument>) {
  // Parenthesised deliberately: the file starts with a multi-line comment, and
  // a multi-line comment counts as a line terminator for automatic semicolon
  // insertion — `return /* … */ (…)()` silently becomes `return;` and yields
  // undefined. The parentheses keep the expression attached to the return.
  const fn = new Function(
    "document",
    "window",
    "URL",
    `return (${SOURCE.trim().replace(/;\s*$/, "")})`,
  );
  return fn(doc, { location: { href: "https://www.linkedin.com/in/nagy-anna/?trk=abc" } }, URL) as {
    url: string;
    name?: string;
    headline?: string;
    companyName?: string;
    location?: string;
    bio?: string;
    photoUrl?: string;
    posts: string[];
    _from: Record<string, string>;
  };
}

const PERSON_LD = {
  "@context": "https://schema.org",
  "@graph": [
    { "@type": "WebPage", name: "irrelevant" },
    {
      "@type": "Person",
      name: "Nagy Anna",
      jobTitle: ["Ügyvezető"],
      description: "Fogászati rendelőt vezetek Budán, 1998 óta.",
      worksFor: [{ "@type": "Organization", name: "Danubia Kft" }],
      address: { addressLocality: "Budapest", addressCountry: "HU" },
      image: { contentUrl: "https://media.licdn.com/photo.jpg" },
    },
  ],
};

describe("JSON-LD is preferred, because class names rot", () => {
  const out = run(fakeDocument({ jsonLd: PERSON_LD, title: "Nagy Anna | LinkedIn" }));

  it("reads the whole person from the graph", () => {
    expect(out.name).toBe("Nagy Anna");
    expect(out.headline).toBe("Ügyvezető");
    expect(out.companyName).toBe("Danubia Kft");
    expect(out.location).toBe("Budapest, HU");
    expect(out.bio).toContain("Fogászati");
    expect(out.photoUrl).toBe("https://media.licdn.com/photo.jpg");
  });

  it("reports which layer each field came from", () => {
    expect(out._from.name).toBe("json-ld");
    expect(out._from.bio).toBe("json-ld");
  });

  it("strips tracking parameters so a profile dedupes to one lead", () => {
    expect(out.url).toBe("https://www.linkedin.com/in/nagy-anna");
  });
});

describe("the failure that shipped: every CSS class renamed", () => {
  // No JSON-LD, no classes we recognise — only what LinkedIn keeps for link
  // previews. Before this change the result was a URL and nothing else.
  const out = run(
    fakeDocument({
      title: "Nagy Anna - Ügyvezető - Danubia Kft | LinkedIn",
      meta: {
        "og:title": "Nagy Anna - Ügyvezető - Danubia Kft | LinkedIn",
        "og:description": "Fogászati rendelőt vezetek Budán.",
        "og:image": "https://media.licdn.com/og.jpg",
      },
      css: { "h1.some-new-2026-class": "Nagy Anna" },
    }),
  );

  it("still gets a name, a headline and a company", () => {
    expect(out.name).toBe("Nagy Anna");
    expect(out.headline).toBe("Ügyvezető");
    expect(out.companyName).toBe("Danubia Kft");
  });

  it("still gets the about text and the photo", () => {
    expect(out.bio).toBe("Fogászati rendelőt vezetek Budán.");
    expect(out.photoUrl).toBe("https://media.licdn.com/og.jpg");
  });

  it("says it fell back, rather than reporting a clean success", () => {
    expect(out._from.name).toBe("og:title");
    expect(out._from.bio).toBe("og:description");
  });
});

describe("with only a document title", () => {
  const out = run(fakeDocument({ title: "Nagy Anna - Ügyvezető | LinkedIn" }));

  it("recovers what the title carries", () => {
    expect(out.name).toBe("Nagy Anna");
    expect(out.headline).toBe("Ügyvezető");
    expect(out._from.name).toBe("title");
  });

  it("leaves the rest absent rather than inventing it", () => {
    expect(out.companyName).toBeUndefined();
    expect(out.bio).toBeUndefined();
  });
});

describe("robustness", () => {
  it("survives malformed JSON-LD by falling through", () => {
    const doc = fakeDocument({ title: "Nagy Anna | LinkedIn" });
    doc.querySelectorAll = (sel: string) =>
      sel === 'script[type="application/ld+json"]' ? [{ textContent: "{not json" }] : [];
    const out = run(doc);
    expect(out.name).toBe("Nagy Anna");
  });

  it("returns a URL and nothing invented on a page it cannot read", () => {
    const out = run(fakeDocument({}));
    expect(out.url).toBe("https://www.linkedin.com/in/nagy-anna");
    expect(out.name).toBeUndefined();
    // An empty _from is the signal the popup uses to warn the operator.
    expect(Object.keys(out._from)).toHaveLength(0);
  });

  it("never emits null, which is what failed server validation", () => {
    const out = run(fakeDocument({}));
    for (const [key, value] of Object.entries(out)) {
      if (key === "_from" || key === "posts") continue;
      expect(value, `${key} must be a string or absent, never null`).not.toBeNull();
    }
  });
});
