import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";

/**
 * Page shapes too small to deserve a whole fixture file.
 *
 * This replaces three earlier suites, and the reason is worth recording. The
 * first, `extension-extraction`, drove a hand-built fake `document` with a
 * `querySelector` that matched literal strings — it could not model containers,
 * ancestors or nesting AT ALL, which is exactly why it stayed green while the
 * reader was picking a field out of a stranger's list item. The other two used
 * jsdom but invented profiles with an `<h1>` and no profile links, which is not
 * a page LinkedIn ships. Passing tests over impossible pages is worse than no
 * tests: they buy confidence and deliver none.
 *
 * So the shapes below are all built on the same minimum that a real profile
 * always has — an anchor to the profile's own slug — and the substantive cases
 * live in `extension-bounded-extraction.test.ts` against committed fixtures.
 */
const SOURCE = readFileSync(join(process.cwd(), "extension/content.js"), "utf8");

const OWNER = "kovacs-anna-fixture";
const REAL_PHOTO =
  "https://media.licdn.com/dms/image/v2/D4D/profile-displayphoto-shrink_400_400/0/1699?scrubbed=1";
const PLACEHOLDER = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

interface Extracted {
  url: string;
  name?: string;
  headline?: string;
  companyName?: string;
  location?: string;
  jobTitle?: string;
  bio?: string;
  photoUrl?: string;
  posts: string[];
  provenance: Record<string, { source: string }>;
  skipped: Record<string, string>;
  boundary: { ok: boolean; reason: string | null };
}

function extract(html: string, href = `https://www.linkedin.com/in/${OWNER}/`): Extracted {
  const dom = new JSDOM(html, { url: href });
  const fn = new Function(
    "document",
    "window",
    "URL",
    `return (${SOURCE.trim().replace(/;\s*$/, "")})`,
  );
  return fn(dom.window.document, dom.window, dom.window.URL) as Extracted;
}

/** A minimal but POSSIBLE profile: an owner anchor with a photo, plus lines. */
function profile(opts: {
  title?: string;
  head?: string;
  img?: string;
  srcset?: string;
  delayed?: string;
  headline?: string;
  location?: string;
  extra?: string;
  slug?: string;
}) {
  const slug = opts.slug ?? OWNER;
  const imgAttrs = [
    opts.img ? `src="${opts.img}"` : "",
    opts.srcset ? `srcset="${opts.srcset}"` : "",
    opts.delayed ? `data-delayed-url="${opts.delayed}"` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `<!doctype html><html><head><title>${opts.title ?? "Kovács Anna | LinkedIn"}</title>${opts.head ?? ""}</head>
<body><main><section>
  <div><a href="/in/${slug}/"><img alt="Kovács Anna" ${imgAttrs}></a></div>
  <div><a href="/in/${slug}/">Kovács Anna</a></div>
  <div>${opts.headline ?? "Ügyvezető @ Danubia Fogászat"}</div>
  <div>${opts.location ?? "Budapest, Hungary"}</div>
  ${opts.extra ?? ""}
</section></main></body></html>`;
}

describe("the profile photo", () => {
  it("takes the widest srcset candidate", () => {
    const out = extract(
      profile({
        img: PLACEHOLDER,
        srcset: "https://media.licdn.com/dms/image/small.jpg 100w, https://media.licdn.com/dms/image/big.jpg 400w",
      }),
    );
    expect(out.photoUrl).toBe("https://media.licdn.com/dms/image/big.jpg");
  });

  it("prefers data-delayed-url over the lazy-load placeholder in src", () => {
    const out = extract(profile({ img: PLACEHOLDER, delayed: REAL_PHOTO }));
    expect(out.photoUrl).toBe(REAL_PHOTO);
  });

  it("reports no photo, with a reason, rather than a placeholder", () => {
    // A data: URL is not a photograph. Sending one made the server report "the
    // photo could not be fetched" for every captured lead.
    const out = extract(profile({ img: PLACEHOLDER }));
    expect(out.photoUrl).toBeUndefined();
    expect(out.skipped.photoUrl).toBe("only_placeholder_sources");
  });

  it("takes a plain https src when that is all there is", () => {
    const out = extract(profile({ img: REAL_PHOTO }));
    expect(out.photoUrl).toBe(REAL_PHOTO);
  });
});

describe("the logged-out public view, which does ship a Person graph", () => {
  const graph = {
    "@graph": [
      {
        "@type": "Person",
        name: "Kovács Anna",
        jobTitle: ["Ügyvezető"],
        description: "Fogászati rendelőt vezet Budán, 1998 óta, négy székkel.",
        worksFor: [{ name: "Danubia Fogászat Kft." }],
        address: { addressLocality: "Budapest", addressCountry: "Hungary" },
      },
    ],
  };

  it("uses the graph for fields the card did not supply", () => {
    const out = extract(
      profile({
        head: `<script type="application/ld+json">${JSON.stringify(graph)}</script>`,
        // No experience section, so company can only come from the graph.
      }),
    );
    expect(out.companyName).toBe("Danubia Fogászat Kft.");
    expect(out.provenance.companyName?.source).toBe("derived");
    expect(out.bio).toContain("Fogászati rendelőt");
  });

  it("survives a malformed graph instead of losing the capture", () => {
    const out = extract(
      profile({ head: `<script type="application/ld+json">{"@type":"Person", broken</script>` }),
    );
    expect(out.name).toBe("Kovács Anna");
    expect(out.headline).toBe("Ügyvezető @ Danubia Fogászat");
  });
});

describe("headings LinkedIn renders twice", () => {
  it("matches a section heading that reads 'TapasztalatTapasztalat'", () => {
    const dbl = (t: string) =>
      `<span aria-hidden="true">${t}</span><span class="visually-hidden">${t}</span>`;
    const out = extract(
      profile({
        extra: "",
        img: REAL_PHOTO,
      }).replace(
        "</main>",
        `<section><h2>${dbl("Tapasztalat")}</h2><ul><li>
           <div>${dbl("Gyártásvezető")}</div>
           <span>${dbl("Alföld Présüzem Zrt. · Teljes munkaidős")}</span>
         </li></ul></section></main>`,
      ),
    );
    expect(out.jobTitle).toBe("Gyártásvezető");
    expect(out.companyName).toBe("Alföld Présüzem Zrt.");
  });
});

describe("recent posts, which feed the person brief", () => {
  it("reads the activity section and stops at three", () => {
    const out = extract(
      profile({ img: REAL_PHOTO }).replace(
        "</main>",
        `<section><h2>Activity</h2><ul>
           <li>Új CBCT-t állítottunk be a héten, a tervezés pontosabb lett.</li>
           <li>Keresünk egy dentálhigiénikust, szólj ha ismersz valakit.</li>
           <li>Harmadik bejegyzés, szintén elég hosszú ahhoz hogy beleszámítson.</li>
           <li>Negyedik bejegyzés, ami már nem kell.</li>
         </ul></section></main>`,
      ),
    );
    expect(out.posts).toHaveLength(3);
    expect(out.posts[0]).toContain("CBCT");
  });

  it("returns an empty list when there is no activity section", () => {
    expect(extract(profile({ img: REAL_PHOTO })).posts).toEqual([]);
  });
});

describe("Sales Navigator, where the same person has a different address", () => {
  const SALES = "https://www.linkedin.com/sales/lead/ACwAAB1234567,NAME_SEARCH,a1b2";

  it("keys on the public profile the page links to, so one human is one lead", () => {
    const out = extract(
      `<!doctype html><html><head><title>Kovács Anna | LinkedIn</title></head>
       <body><main><section>
         <div><a href="/in/${OWNER}/"><img src="${REAL_PHOTO}" alt="Kovács Anna"></a></div>
         <div><a href="/in/${OWNER}/">Kovács Anna</a></div>
         <div>Ügyvezető</div><div>Budapest, Hungary</div>
       </section></main></body></html>`,
      SALES,
    );
    expect(out.url).toBe(`https://www.linkedin.com/in/${OWNER}`);
  });

  it("strips the search context when the page names no public profile", () => {
    const out = extract(
      `<!doctype html><html><head><title>Kovács Anna | LinkedIn</title></head>
       <body><main><section><div>Kovács Anna</div></section></main></body></html>`,
      SALES,
    );
    expect(out.url).toBe("https://www.linkedin.com/sales/lead/ACwAAB1234567");
  });

  it("strips tracking parameters from an ordinary profile URL", () => {
    const out = extract(profile({ img: REAL_PHOTO }), `https://www.linkedin.com/in/${OWNER}/?trk=abc`);
    expect(out.url).toBe(`https://www.linkedin.com/in/${OWNER}`);
  });
});

describe("the name, when the card and the title disagree", () => {
  it("rejects a card name that shares nothing with the page title", () => {
    // A card name that agrees with neither the title nor the slug is a sign the
    // reader is looking at the wrong element, so it falls back to the title.
    const out = extract(
      profile({ title: "Kovács Anna | LinkedIn" }).replace(
        `<a href="/in/${OWNER}/">Kovács Anna</a>`,
        `<a href="/in/${OWNER}/">Completely Different Human</a>`,
      ),
    );
    expect(out.name).toBe("Kovács Anna");
    expect(out.provenance.name?.source).toBe("title");
  });

  it("accepts a name whose tokens match the title in a different order", () => {
    const out = extract(
      profile({ title: "Anna Kovács | LinkedIn" }).replace(
        `<a href="/in/${OWNER}/">Kovács Anna</a>`,
        `<a href="/in/${OWNER}/">Kovács Anna</a>`,
      ),
    );
    expect(out.name).toBe("Kovács Anna");
    expect(out.provenance.name?.source).toBe("topcard");
  });
});
