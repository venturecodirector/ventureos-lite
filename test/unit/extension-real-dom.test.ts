import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";

/**
 * Extraction against LinkedIn's markup AS IT IS ACTUALLY SHIPPED.
 *
 * The sibling `extension-structure.test.ts` models a signed-in profile too, but
 * it makes one simplification that turned out to hide the bug this file exists
 * for: it wraps EVERY line in the doubled `aria-hidden` / `visually-hidden`
 * pair. The real page does not. LinkedIn doubles the top card's company and
 * school pills while leaving the headline a plain <div> and the location a
 * plain <span> — and the old reader, on finding any aria-hidden span in the
 * card, read only those. So the headline came back as the employer's name, the
 * location came back empty, and the tests stayed green because the fixture
 * never presented the mixture.
 *
 * These fixtures are therefore built to be inconvenient in the ways the real
 * page is inconvenient: mixed node kinds, obfuscated classes, id anchors
 * instead of sections, lazy-loading images, and a profile with almost nothing
 * filled in.
 */
const SOURCE = readFileSync(join(process.cwd(), "extension/content.js"), "utf8");

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
  websiteUrl?: string;
  photoUrl?: string;
  posts: string[];
  _from: Record<string, string>;
}

function extract(html: string, href = "https://www.linkedin.com/in/nagy-anna/?trk=x"): Extracted {
  const dom = new JSDOM(html, { url: href });
  const fn = new Function("document", "window", "URL", `return (${SOURCE.trim().replace(/;\s*$/, "")})`);
  return fn(dom.window.document, dom.window, dom.window.URL) as Extracted;
}

/** The doubled pair LinkedIn renders for screen readers. */
const dbl = (t: string) =>
  `<span aria-hidden="true">${t}</span><span class="visually-hidden">${t}</span>`;

const REAL_PHOTO =
  "https://media.licdn.com/dms/image/v2/D4D03AQF/profile-displayphoto-shrink_400_400/0/1699?e=1&v=beta&t=abc";
/** The 1×1 transparent GIF LinkedIn shows until the avatar loads. */
const PLACEHOLDER = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

/**
 * The 2025/26 signed-in profile: no Person graph, a useless og:title, and a top
 * card that mixes plain nodes with doubled ones.
 */
const CURRENT_ROLLOUT = `<!doctype html>
<html><head><title>Nagy Anna | LinkedIn</title></head>
<body>
<main class="scaffold-layout__main">
  <section class="artdeco-card ZmKlWvpQdE">
    <div class="ph5 pb5">
      <div class="mt2 relative">
        <div class="AbCdEfGh"><h1 class="inline t-24 v-align-middle break-words">Nagy Anna</h1></div>
        <div class="text-body-medium break-words">Ügyvezető @ Danubia Fogászat | mosolytervezés</div>
        <div class="IjKlMnOp mt2">
          <span class="text-body-small inline t-black--light break-words">Budapest, Budapest, Hungary</span>
          <span class="text-body-small">·</span>
          <a href="/in/nagy-anna/overlay/contact-info/"><span class="text-body-small">Contact info</span></a>
        </div>
        <ul class="QrStUvWx">
          <li class="text-body-small"><a href="#"><span class="t-bold">500+ connections</span></a></li>
        </ul>
      </div>
      <ul class="pv-text-details__right-panel">
        <li><button aria-label="Current company: Danubia Fogászat Kft. Click to skip to experience card">
          <div class="hoverable-link-text">${dbl("Danubia Fogászat Kft.")}</div>
        </button></li>
        <li><button aria-label="Education: Semmelweis Egyetem">
          <div class="hoverable-link-text">${dbl("Semmelweis Egyetem")}</div>
        </button></li>
      </ul>
      <div class="pv-top-card__photo-wrapper">
        <button class="pv-top-card-profile-picture__container">
          <img width="200" height="200" alt="Nagy Anna"
               class="pv-top-card-profile-picture__image--show evi-image lazy-image ember-view"
               src="${PLACEHOLDER}" data-delayed-url="${REAL_PHOTO}">
        </button>
      </div>
    </div>
  </section>

  <div id="about" class="pv-profile-card-anchor"></div>
  <section class="artdeco-card YzAbCdEf">
    <div class="pvs-header__container"><h2 class="pvs-header__title">${dbl("About")}</h2></div>
    <div class="display-flex ph5 pv3"><div class="inline-show-more-text">
      ${dbl("Fogászati rendelőt vezetek Budán 1998 óta. Írjon bátran: anna@danubia.hu vagy +36 30 123 4567.")}
    </div></div>
  </section>

  <div id="experience" class="pv-profile-card-anchor"></div>
  <section class="artdeco-card GhIjKlMn">
    <div class="pvs-header__container"><h2 class="pvs-header__title">${dbl("Experience")}</h2></div>
    <div class="pvs-list__outer-container"><ul>
      <li class="artdeco-list__item"><div class="display-flex flex-column full-width">
        <div class="mr1 hoverable-link-text t-bold">${dbl("Ügyvezető")}</div>
        <span class="t-14 t-normal">${dbl("Danubia Fogászat Kft. · Full-time")}</span>
        <span class="t-14 t-normal t-black--light">${dbl("1998 - Present · 27 yrs")}</span>
      </div></li>
      <li class="artdeco-list__item"><div class="display-flex flex-column full-width">
        <div class="mr1 hoverable-link-text t-bold">${dbl("Rezidens")}</div>
        <span class="t-14 t-normal">${dbl("Semmelweis Egyetem")}</span>
      </div></li>
    </ul></div>
  </section>
</main>
</body></html>`;

describe("the top card as LinkedIn actually ships it — plain nodes beside doubled ones", () => {
  const out = extract(CURRENT_ROLLOUT);

  it("reads the headline, not the company pill sitting in the same card", () => {
    // THE REGRESSION. This returned "Danubia Fogászat Kft." before, because one
    // doubled line in the card switched the reader into aria-hidden-only mode.
    expect(out.headline).toBe("Ügyvezető @ Danubia Fogászat | mosolytervezés");
  });

  it("reads the location out of a plain span", () => {
    expect(out.location).toBe("Budapest, Budapest, Hungary");
  });

  it("takes the employer from the aria-label, full stop and all", () => {
    // aria-label is an accessibility contract; LinkedIn cannot drop it the way
    // it drops class names. "Kft." keeps its period because that is how the
    // company is spelled in the records this gets matched against.
    expect(out.companyName).toBe("Danubia Fogászat Kft.");
    expect(out._from.companyName).toBe("aria");
  });

  it("reads the current role, not the previous one", () => {
    expect(out.jobTitle).toBe("Ügyvezető");
  });

  it("reads the About text and the contact details published inside it", () => {
    expect(out.bio).toContain("Fogászati rendelőt vezetek");
    expect(out.email).toBe("anna@danubia.hu");
    expect(out.phone).toBe("+36 30 123 4567");
  });

  it("reads name, headline, company, location, title, bio, email, phone and photo — not just the name", () => {
    // The complaint that started this: "it reads nothing but the name and the
    // URL". Asserted as a whole rather than field by field, because the failure
    // was a whole-capture failure.
    expect(Object.keys(out._from).sort()).toEqual(
      ["bio", "companyName", "email", "headline", "jobTitle", "location", "name", "phone", "photoUrl"].sort(),
    );
  });
});

describe("the profile photo, which lazy-loads", () => {
  it("takes the real address out of data-delayed-url, never the placeholder", () => {
    // The bug the user saw as "an empty avatar": src is a 1×1 data: GIF until
    // the image swaps in, the server cannot fetch a data: URL, so every
    // captured lead fell back to initials.
    const out = extract(CURRENT_ROLLOUT);
    expect(out.photoUrl).toBe(REAL_PHOTO);
    expect(out.photoUrl).not.toMatch(/^data:/);
  });

  it("takes the widest srcset entry once the image has loaded", () => {
    const out = extract(`<!doctype html><html><body><main><section><div>
      <h1>Kis Éva</h1>
      <img class="pv-top-card-profile-picture__image--show" src="${PLACEHOLDER}"
           srcset="https://media.licdn.com/dms/image/small.jpg 100w, https://media.licdn.com/dms/image/big.jpg 400w">
    </div></section></main></body></html>`);
    expect(out.photoUrl).toBe("https://media.licdn.com/dms/image/big.jpg");
  });

  it("finds the avatar by its address when every class name has changed", () => {
    // Content-based, and the last line of defence: LinkedIn serves avatars from
    // a "profile-displayphoto" path, which has outlived several rounds of class
    // renaming.
    const out = extract(`<!doctype html><html><body><main><section><div>
      <h1>Kis Éva</h1>
      <img class="zz1" src="https://media.licdn.com/dms/image/logo.png">
      <img class="zz2" src="${REAL_PHOTO}">
    </div></section></main></body></html>`);
    expect(out.photoUrl).toBe(REAL_PHOTO);
  });

  it("reports NO photo rather than a placeholder when there is nothing real to send", () => {
    // Honest absence: the popup then says the photo was not read, instead of
    // the app silently showing initials for a capture that claimed a picture.
    const out = extract(`<!doctype html><html><body><main><section><div>
      <h1>Kis Éva</h1>
      <img class="pv-top-card-profile-picture__image--show" src="${PLACEHOLDER}">
    </div></section></main></body></html>`);
    expect(out.photoUrl).toBeUndefined();
    expect(out._from.photoUrl).toBeUndefined();
  });
});

describe("contact details the person published", () => {
  it("reads mailto: and tel: links the page has already rendered", () => {
    // If the user opened the contact overlay themselves before pressing
    // Capture, its links are simply in the DOM. Reading them is not clicking.
    const out = extract(`<!doctype html><html><body><main><section><div>
      <h1>Tóth Gábor</h1><p>Alapító</p>
    </div></section>
    <div class="artdeco-modal"><section class="pv-contact-info">
      <a href="mailto:gabor@peldakft.hu">gabor@peldakft.hu</a>
      <a href="tel:+3612345678">+36 1 234 5678</a>
      <a href="https://www.peldakft.hu/">peldakft.hu</a>
    </section></div></main></body></html>`);
    expect(out.email).toBe("gabor@peldakft.hu");
    expect(out.phone).toBe("+3612345678");
    expect(out.websiteUrl).toBe("https://peldakft.hu");
    expect(out._from.email).toBe("contact-link");
  });

  it("never reports LinkedIn's own addresses as the person's", () => {
    const out = extract(`<!doctype html><html><body><main><section><div>
      <h1>Tóth Gábor</h1><p>Alapító</p>
      <a href="mailto:no-reply@linkedin.com">unsubscribe</a>
      <a href="https://www.linkedin.com/help">Help</a>
    </div></section></main></body></html>`);
    expect(out.email).toBeUndefined();
    expect(out.websiteUrl).toBeUndefined();
  });
});

describe("layouts that are not the one we expected", () => {
  it("reads a profile whose sections are id anchors over plain divs", () => {
    const out = extract(`<!doctype html><html><body><div role="main">
      <div class="card"><h1>Varga Nóra</h1><div>Értékesítési vezető</div><div>Szeged, Hungary</div></div>
      <div id="about"></div>
      <section><h2>About</h2><div>Tizenöt éve dolgozom B2B értékesítésben, főként gyártó cégeknél.</div></section>
    </div></body></html>`);
    expect(out.name).toBe("Varga Nóra");
    expect(out.headline).toBe("Értékesítési vezető");
    expect(out.location).toBe("Szeged, Hungary");
    expect(out.bio).toContain("B2B értékesítésben");
  });

  it("reads a Hungarian-language interface", () => {
    const out = extract(`<!doctype html><html><body><main>
      <section><div><h1>Balogh Zsolt</h1>${dbl("Marketing igazgató")}${dbl("Győr, Hungary")}</div></section>
      <section><h2>${dbl("Névjegy")}</h2><div>${dbl("Húsz éve tervezek kampányokat kis- és középvállalatoknak.")}</div></section>
      <section><h2>${dbl("Tapasztalat")}</h2><ul><li>${dbl("Marketing igazgató")}${dbl("Rába Marketing Kft. · Teljes munkaidős")}</li></ul></section>
    </main></body></html>`);
    expect(out.headline).toBe("Marketing igazgató");
    expect(out.bio).toContain("Húsz éve tervezek");
    expect(out.companyName).toBe("Rába Marketing Kft.");
  });

  it("still returns the name and photo from a profile with nothing else filled in", () => {
    const out = extract(`<!doctype html><html><body><main><section><div>
      <h1>Fekete Imre</h1>
      <img class="pv-top-card-profile-picture__image--show" src="${REAL_PHOTO}">
    </div></section></main></body></html>`);
    expect(out.name).toBe("Fekete Imre");
    expect(out.photoUrl).toBe(REAL_PHOTO);
    expect(out.headline).toBeUndefined();
  });

  it("survives a malformed JSON-LD block instead of losing the whole capture", () => {
    // Every layer is fenced precisely so one broken source costs its own fields
    // and nothing else.
    const out = extract(`<!doctype html><html><head>
      <script type="application/ld+json">{"@type":"Person", broken</script>
    </head><body><main><section><div>
      <h1>Papp Ilona</h1><div>Ügyvéd</div>
    </div></section></main></body></html>`);
    expect(out.name).toBe("Papp Ilona");
    expect(out.headline).toBe("Ügyvéd");
  });
});

describe("Sales Navigator, where the same person has a different address", () => {
  const SALES = "https://www.linkedin.com/sales/lead/ACwAAB1234567,NAME_SEARCH,a1b2";

  /**
   * A lead is keyed on its LinkedIn URL. A Sales Navigator address is a
   * different string for the same human, so capturing someone from both views
   * would file them as two leads — and the two would then diverge.
   */
  it("keys on the public profile the page names, not the sales address", () => {
    const out = extract(
      `<!doctype html><html><body><main><section><div>
        <h1>Nagy Anna</h1><div>Ügyvezető</div>
        <a href="https://www.linkedin.com/in/nagy-anna" aria-label="View LinkedIn profile">LinkedIn</a>
      </div></section></main></body></html>`,
      SALES,
    );
    expect(out.url).toBe("https://www.linkedin.com/in/nagy-anna");
  });

  it("strips the search context, which changes with how you got there", () => {
    // Without this every visit from a different search is a new lead.
    const out = extract(
      `<!doctype html><html><body><main><section><div><h1>Nagy Anna</h1></div></section></main></body></html>`,
      SALES,
    );
    expect(out.url).toBe("https://www.linkedin.com/sales/lead/ACwAAB1234567");
  });

  it("matches the profile link by name when nothing says which link it is", () => {
    const out = extract(
      `<!doctype html><html><body><main><section><div>
        <h1>Nagy Anna</h1>
        <a href="/in/nagy-anna-b2c3">profile</a>
      </div></section></main></body></html>`,
      SALES,
    );
    expect(out.url).toBe("https://www.linkedin.com/in/nagy-anna-b2c3");
  });

  it("refuses to guess when the page links to several other people", () => {
    // "Similar leads" and colleagues are also /in/ links. Filing a capture
    // under the wrong person is a quiet and expensive mistake, so ambiguity
    // falls back to the sales address rather than picking one.
    const out = extract(
      `<!doctype html><html><body><main><section><div>
        <h1>Nagy Anna</h1>
        <a href="/in/kovacs-bela">Kovács Béla</a>
        <a href="/in/szabo-petra">Szabó Petra</a>
      </div></section></main></body></html>`,
      SALES,
    );
    expect(out.url).toBe("https://www.linkedin.com/sales/lead/ACwAAB1234567");
  });

  it("leaves an ordinary profile URL exactly as it always handled it", () => {
    const out = extract(
      `<!doctype html><html><body><main><section><div>
        <h1>Nagy Anna</h1><a href="/in/valaki-mas">Valaki Más</a>
      </div></section></main></body></html>`,
      "https://www.linkedin.com/in/nagy-anna/?trk=abc",
    );
    expect(out.url).toBe("https://www.linkedin.com/in/nagy-anna");
  });
});

describe("the logged-out public view, which does ship a Person graph", () => {
  it("prefers the graph over everything scraped from the page", () => {
    const out = extract(`<!doctype html><html><head>
      <title>Nagy Anna | LinkedIn</title>
      <script type="application/ld+json">${JSON.stringify({
        "@graph": [
          {
            "@type": "Person",
            name: "Nagy Anna",
            jobTitle: ["Ügyvezető"],
            description: "Fogászati rendelőt vezet Budán.",
            worksFor: [{ name: "Danubia Fogászat Kft." }],
            address: { addressLocality: "Budapest", addressCountry: "HU" },
            image: { contentUrl: REAL_PHOTO },
          },
        ],
      })}</script>
    </head><body><main><section><div><h1>Wrong Name</h1></div></section></main></body></html>`);
    expect(out.name).toBe("Nagy Anna");
    expect(out.companyName).toBe("Danubia Fogászat Kft.");
    expect(out.photoUrl).toBe(REAL_PHOTO);
    expect(out._from.name).toBe("json-ld");
  });
});
