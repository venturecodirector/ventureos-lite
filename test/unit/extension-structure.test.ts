import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";

/**
 * Extraction against the page that actually matters: a SIGNED-IN profile.
 *
 * The earlier tests use a hand-built fake document, which was enough for the
 * JSON-LD and meta-tag layers but cannot model containers, ancestors or section
 * nesting — so it could not catch the real failure. On a signed-in profile
 * LinkedIn ships no Person graph and an og:title of just "Name | LinkedIn", so
 * every field except the name and the photo came back empty while the tests
 * stayed green.
 *
 * The fixture below reproduces that page: React-rendered, no JSON-LD, useless
 * meta tags, every visible line doubled for screen readers, and — the point —
 * CLASS NAMES THAT MEAN NOTHING. If extraction still works here, it is reading
 * the page's structure rather than its styling.
 */
const SOURCE = readFileSync(join(process.cwd(), "extension/content.js"), "utf8");

/** A line as LinkedIn renders it: once for sight, once for screen readers. */
const line = (t: string) =>
  `<span class="a1b2" aria-hidden="true">${t}</span><span class="visually-hidden">${t}</span>`;

const SIGNED_IN_PROFILE = `
<!doctype html>
<html><head>
  <title>Nagy Anna | LinkedIn</title>
  <meta property="og:title" content="Nagy Anna | LinkedIn">
  <meta property="og:image" content="https://media.licdn.com/dms/image/v2/abc/profile.jpg">
</head><body>
  <div class="zz9">
    <main class="qq1">
      <section class="x7y8">
        <div class="p0q1">
          <h1 class="nn3">Nagy Anna</h1>
          ${line("Fogászati rendelőt vezetek Budán · Implantológia")}
          ${line("Budapest, Budapest, Hungary")}
          ${line("500+ connections")}
          ${line("Contact info")}
        </div>
      </section>

      <section class="mm4">
        <h2 class="k2">About</h2>
        <div class="j3">
          ${line("1998 óta vezetem a rendelőt. Négy székkel, hat kollégával dolgozunk, és a saját CBCT-nkkel tervezünk minden implantációt.")}
        </div>
      </section>

      <section class="nn5">
        <h2 class="k2">Experience</h2>
        <ul>
          <li class="e1">
            ${line("Ügyvezető")}
            ${line("Danubia Dental Kft · Full-time")}
            ${line("1998 - Present")}
          </li>
          <li class="e2">
            ${line("Rezidens")}
            ${line("Semmelweis Egyetem")}
          </li>
        </ul>
      </section>

      <section class="oo6">
        <h2 class="k2">Activity</h2>
        <ul>
          <li class="f1">Új CBCT-t állítottunk be a héten, a tervezés innentől sokkal pontosabb.</li>
          <li class="f2">Keresünk egy dentálhigiénikust, szólj ha ismersz valakit.</li>
        </ul>
      </section>
    </main>
  </div>
</body></html>`;

interface Extracted {
  url: string;
  name?: string;
  headline?: string;
  companyName?: string;
  location?: string;
  jobTitle?: string;
  bio?: string;
  email?: string;
  phone?: string;
  photoUrl?: string;
  posts: string[];
  _from: Record<string, string>;
}

function extract(html: string, href = "https://www.linkedin.com/in/nagy-anna/?trk=x"): Extracted {
  const dom = new JSDOM(html, { url: href });
  // Parenthesised for the same ASI reason as the sibling test file.
  const fn = new Function("document", "window", "URL", `return (${SOURCE.trim().replace(/;\s*$/, "")})`);
  return fn(dom.window.document, dom.window, dom.window.URL) as Extracted;
}

describe("a signed-in profile, where every class name is meaningless", () => {
  const out = extract(SIGNED_IN_PROFILE);

  it("reads the name from the heading", () => {
    expect(out.name).toBe("Nagy Anna");
  });

  it("reads the headline from the line under the name", () => {
    expect(out.headline).toBe("Fogászati rendelőt vezetek Budán · Implantológia");
    expect(out._from.headline).toBe("structure");
  });

  it("reads the city, and does not mistake the connection count for it", () => {
    expect(out.location).toBe("Budapest, Budapest, Hungary");
  });

  it("reads the real job title from the experience block", () => {
    expect(out.jobTitle).toBe("Ügyvezető");
  });

  it("reads the employer, dropping LinkedIn's employment-type suffix", () => {
    expect(out.companyName).toBe("Danubia Dental Kft");
  });

  it("reads the About text, not the section heading", () => {
    expect(out.bio).toContain("1998 óta vezetem a rendelőt");
    expect(out.bio).not.toBe("About");
  });

  it("reads recent posts, which is what a brief is written from", () => {
    expect(out.posts).toHaveLength(2);
    expect(out.posts[0]).toContain("CBCT");
  });

  it("does not read each doubled line twice", () => {
    // The screen-reader copy is the trap: naive textContent yields "AnnaAnna".
    expect(out.name).not.toMatch(/Nagy AnnaNagy Anna/);
    expect(out.headline).not.toMatch(/ImplantológiaFogászati/);
  });

  it("takes only the first experience entry, not the previous job", () => {
    expect(out.jobTitle).not.toBe("Rezidens");
    expect(out.companyName).not.toBe("Semmelweis Egyetem");
  });

  it("strips tracking parameters so a re-capture dedupes to one lead", () => {
    expect(out.url).toBe("https://www.linkedin.com/in/nagy-anna");
  });
});

describe("noise the top card is full of", () => {
  it("never reports a button label or a follower count as the headline", () => {
    const out = extract(`<!doctype html><html><body><main><section><div>
      <h1>Kovács Béla</h1>
      ${line("Message")}
      ${line("1,204 followers")}
      ${line("Marketing vezető")}
    </div></section></main></body></html>`);
    expect(out.headline).toBe("Marketing vezető");
  });
});

describe("a profile that renders no aria-hidden pairs at all", () => {
  it("still finds the headline, without swallowing the whole card as one line", () => {
    // The containment filter earns its place here: a container's text is the
    // concatenation of its children's, and would otherwise win "first line".
    const out = extract(`<!doctype html><html><body><main><section><div>
      <h1>Szabó Petra</h1>
      <p>Termékmenedzser</p>
      <p>Debrecen, Hungary</p>
    </div></section></main></body></html>`);
    expect(out.headline).toBe("Termékmenedzser");
    expect(out.location).toBe("Debrecen, Hungary");
  });
});
