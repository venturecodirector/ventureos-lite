/**
 * Generator for the SYNTHETIC LinkedIn fixtures.
 *
 * Run: node test/fixtures/linkedin/generate-synthetic.mjs
 *
 * These are reconstructions, not recordings. Real recordings come from the
 * extension's "Save DOM snapshot" button and land in this directory as
 * `real-*.html`; those are always the better evidence and the tests prefer them
 * when present. These exist so the work is not blocked on having a live
 * authenticated profile to hand, and so the specific reported failure has a
 * permanent home.
 *
 * Each one encodes a fact from the diagnoseVersion-2 report of the page that
 * actually broke:
 *
 *   totalH1: 0                      -> no <h1> anywhere; the name is an <a> text
 *   idAnchors all absent            -> no #about/#experience to anchor sections
 *   hashed class names              -> nothing may be selected by class
 *   top card liCount 36, nested 11  -> the container the old reader chose had
 *                                      swallowed the right-hand rail
 *   mailto 0, tel 0, outbound []    -> contact details are NOT on the page
 *
 * WHY THE RAIL COMES FIRST IN SOURCE ORDER (fixture a): the reported bug was a
 * connection's name captured as the headline and another connection's name
 * ("Keletso Thophego, CFP") captured as the city. The second one is explained by
 * the old isPlace() test — "has a comma, no digits, under 100 chars" — which a
 * credential suffix passes. The first is only explicable if the rail precedes
 * the profile's own text in DOM order, which is exactly how a CSS-positioned
 * right column gets sourced. Both are reproduced here so both stay fixed.
 */
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const OWNER_SLUG = "anna-kovacs-fixture";
const D_SLUG = "toth-szucs-ors-abel-fixture";
const PHOTO_200 =
  "https://media.licdn.com/dms/image/v2/D4D03AQF/profile-displayphoto-shrink_200_200/0/1699?scrubbed=1";
const PHOTO_400 =
  "https://media.licdn.com/dms/image/v2/D4D03AQF/profile-displayphoto-shrink_400_400/0/1699?scrubbed=1";
const PLACEHOLDER_GIF =
  "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

/** LinkedIn renders most lines twice: once for sight, once for screen readers. */
const dbl = (t) => `<span aria-hidden="true">${t}</span><span class="visually-hidden">${t}</span>`;

/** A hashed class name, of the kind that makes class-based selection useless. */
let hashCounter = 0;
const hash = () => {
  hashCounter += 1;
  // Deterministic so regenerating produces no diff noise.
  return "x" + (hashCounter * 2654435761 % 0xffffffff).toString(36).slice(0, 9);
};

/**
 * The people in the right-hand rail. Two of them are the ones actually
 * mis-captured on the real page, kept verbatim because the regression test
 * asserts against these exact strings.
 */
const RAIL_PEOPLE = [
  { name: "Cristina Amor Maclang", headline: "Virtual Assistant | Lead Generation" },
  { name: "Keletso Thophego, CFP", headline: "Certified Financial Planner" },
  { name: "Person 3", headline: "Head of Operations" },
  { name: "Person 4", headline: "Budapest, Hungary based recruiter" },
  { name: "Person 5", headline: "Founder" },
  { name: "Person 6", headline: "Sales Director" },
];

/** `count` rail entries, cycling the people above; each entry is its own <li>. */
function railList(count) {
  const items = [];
  for (let i = 0; i < count; i += 1) {
    const p = RAIL_PEOPLE[i % RAIL_PEOPLE.length];
    const slug = `person-${(i % RAIL_PEOPLE.length) + 1}-fixture`;
    items.push(
      `<li class="${hash()}">` +
        `<div class="${hash()}">` +
        `<a href="/in/${slug}/" class="${hash()}">` +
        `<img class="${hash()}" src="${PLACEHOLDER_GIF}" data-delayed-url="${PHOTO_200}" alt="${p.name}">` +
        `</a>` +
        `<a href="/in/${slug}/" class="${hash()}">${dbl(p.name)}</a>` +
        `<div class="${hash()}">${dbl(p.headline)}</div>` +
        `<button class="${hash()}">Connect</button>` +
        `</div>` +
        `</li>`,
    );
  }
  return items.join("\n        ");
}

/** The profile's own column: photo anchor, name anchor, headline, location. */
function ownerColumn({ name, headline, location, connections = "500+ connections", slug = OWNER_SLUG }) {
  return `
      <div class="${hash()}">
        <a href="/in/${slug}/" class="${hash()}" aria-label="${name}">
          <img class="${hash()}" width="200" height="200" alt="${name}"
               src="${PLACEHOLDER_GIF}"
               srcset="${PHOTO_200} 200w, ${PHOTO_400} 400w">
        </a>
      </div>
      <div class="${hash()}">
        <a href="/in/${slug}/" class="${hash()}">${dbl(name)}</a>
      </div>
      <div class="${hash()}">${dbl(headline)}</div>
      <div class="${hash()}">
        <span class="${hash()}">${dbl(location)}</span>
        <span class="${hash()}">·</span>
        <a href="/in/${slug}/overlay/contact-info/" id="top-card-text-details-contact-info" class="${hash()}">${dbl("Contact info")}</a>
      </div>
      <ul class="${hash()}">
        <li class="${hash()}"><a href="/in/${slug}/connections/" class="${hash()}">${dbl(connections)}</a></li>
      </ul>`;
}

function page({ title, lang = "en", body }) {
  return `<!doctype html>
<html lang="${lang}"><head>
  <meta charset="utf-8">
  <title>${title}</title>
  <meta property="og:title" content="${title}">
  <!-- No JSON-LD Person graph: this is the signed-in view. -->
  <code id="bpr-guid-${hashCounter}" style="display:none"></code>
</head>
<body class="${hash()}">
  <nav class="${hash()}"><a href="/feed/" class="${hash()}">Home</a></nav>
  ${body}
</body></html>
`;
}

// ---------------------------------------------------------------------------
// (a) authenticated profile WITH a populated right rail — the reported bug
// ---------------------------------------------------------------------------
// The rail is a SIBLING of the profile's own column inside one container, and
// comes FIRST in source order. 36 <li> and 11 nested sections, matching the
// diagnostics of the container the old reader mistook for the top card.
const nestedBlocks = Array.from(
  { length: 11 },
  (_, i) =>
    `<section class="${hash()}"><div class="${hash()}">${dbl(`Nested block ${i + 1}`)}</div></section>`,
).join("\n        ");

const fixtureA = page({
  title: "Kovács Anna | LinkedIn",
  body: `<main class="${hash()}">
    <section class="${hash()}">
      <aside class="${hash()}">
        <div class="${hash()}"><h2 class="${hash()}">${dbl("People you may know")}</h2></div>
        <ul class="${hash()}">
        ${railList(35)}
        </ul>
        ${nestedBlocks}
      </aside>
${ownerColumn({
  name: "Kovács Anna",
  headline: "Ügyvezető @ Danubia Fogászat | mosolytervezés",
  location: "Budapest, Budapest, Hungary",
})}
    </section>

    <section class="${hash()}">
      <div class="${hash()}"><h2 class="${hash()}">${dbl("About")}</h2></div>
      <div class="${hash()}"><div class="${hash()}">${dbl(
        "Fogászati rendelőt vezetek Budán 1998 óta. Négy székkel és hat kollégával dolgozunk, minden implantációt saját CBCT-vel tervezünk.",
      )}</div></div>
    </section>

    <section class="${hash()}">
      <div class="${hash()}"><h2 class="${hash()}">${dbl("Experience")}</h2></div>
      <ul class="${hash()}">
        <li class="${hash()}">
          <div class="${hash()}">${dbl("Ügyvezető")}</div>
          <span class="${hash()}">${dbl("Danubia Fogászat Kft. · Full-time")}</span>
          <span class="${hash()}">${dbl("1998 - Present · 27 yrs")}</span>
        </li>
        <li class="${hash()}">
          <div class="${hash()}">${dbl("Rezidens")}</div>
          <span class="${hash()}">${dbl("Semmelweis Egyetem")}</span>
        </li>
      </ul>
    </section>

    <aside class="${hash()}">
      <div class="${hash()}"><h2 class="${hash()}">${dbl("More profiles for you")}</h2></div>
      <ul class="${hash()}">
        ${railList(6)}
      </ul>
    </aside>
  </main>`,
});

// ---------------------------------------------------------------------------
// (b) the same profile with NO right rail
// ---------------------------------------------------------------------------
const fixtureB = page({
  title: "Kovács Anna | LinkedIn",
  body: `<main class="${hash()}">
    <section class="${hash()}">
${ownerColumn({
  name: "Kovács Anna",
  headline: "Ügyvezető @ Danubia Fogászat | mosolytervezés",
  location: "Budapest, Budapest, Hungary",
})}
    </section>
    <section class="${hash()}">
      <div class="${hash()}"><h2 class="${hash()}">${dbl("About")}</h2></div>
      <div class="${hash()}">${dbl(
        "Fogászati rendelőt vezetek Budán 1998 óta. Négy székkel és hat kollégával dolgozunk.",
      )}</div>
    </section>
    <section class="${hash()}">
      <div class="${hash()}"><h2 class="${hash()}">${dbl("Experience")}</h2></div>
      <ul class="${hash()}">
        <li class="${hash()}">
          <div class="${hash()}">${dbl("Ügyvezető")}</div>
          <span class="${hash()}">${dbl("Danubia Fogászat Kft. · Full-time")}</span>
        </li>
      </ul>
    </section>
  </main>`,
});

// ---------------------------------------------------------------------------
// (c) the contact-info overlay, as it exists once opened
// ---------------------------------------------------------------------------
// Parsed by LABEL, never by position: the sections appear in whatever order
// LinkedIn feels like, and a profile may have any subset of them.
const fixtureC = page({
  title: "Kovács Anna | LinkedIn",
  body: `<main class="${hash()}">
    <section class="${hash()}">
${ownerColumn({
  name: "Kovács Anna",
  headline: "Ügyvezető @ Danubia Fogászat | mosolytervezés",
  location: "Budapest, Budapest, Hungary",
})}
    </section>
  </main>
  <div role="dialog" aria-labelledby="pv-contact-info" class="${hash()}">
    <h2 id="pv-contact-info" class="${hash()}">${dbl("Contact info")}</h2>
    <div class="${hash()}">
      <section class="${hash()}">
        <h3 class="${hash()}">${dbl("Kovács Anna's Profile")}</h3>
        <a href="https://www.linkedin.com/in/${OWNER_SLUG}" class="${hash()}">linkedin.com/in/${OWNER_SLUG}</a>
      </section>
      <section class="${hash()}">
        <h3 class="${hash()}">${dbl("Website")}</h3>
        <ul class="${hash()}">
          <li class="${hash()}"><a href="https://www.danubia-fogaszat.hu" class="${hash()}">www.danubia-fogaszat.hu</a><span class="${hash()}">(Company)</span></li>
          <li class="${hash()}"><a href="https://annakovacs.example" class="${hash()}">annakovacs.example</a><span class="${hash()}">(Personal)</span></li>
        </ul>
      </section>
      <section class="${hash()}">
        <h3 class="${hash()}">${dbl("Phone")}</h3>
        <ul class="${hash()}">
          <li class="${hash()}"><span class="${hash()}">06 1 234 5678</span><span class="${hash()}">(Mobile)</span></li>
        </ul>
      </section>
      <section class="${hash()}">
        <h3 class="${hash()}">${dbl("Email")}</h3>
        <a href="mailto:Anna.Kovacs@Danubia-Fogaszat.HU" class="${hash()}">Anna.Kovacs@Danubia-Fogaszat.HU</a>
      </section>
      <section class="${hash()}">
        <h3 class="${hash()}">${dbl("Connected")}</h3>
        <span class="${hash()}">March 4, 2024</span>
      </section>
      <section class="${hash()}">
        <h3 class="${hash()}">${dbl("Birthday")}</h3>
        <span class="${hash()}">July 12</span>
      </section>
    </div>
    <button aria-label="Dismiss" class="${hash()}">Dismiss</button>
  </div>`,
});

// ---------------------------------------------------------------------------
// (d) accented name, Hungarian location, Hungarian interface
// ---------------------------------------------------------------------------
// Also the awkward case for the name validator: the title says "Örs Ábel
// Tóth-Szűcs" and the card says "Tóth-Szűcs Örs Ábel" — Hungarian puts the
// family name first. A validator comparing strings would reject a correct name;
// one comparing token SETS accepts it.
const fixtureD = page({
  title: "Örs Ábel Tóth-Szűcs | LinkedIn",
  lang: "hu",
  body: `<main class="${hash()}">
    <section class="${hash()}">
      <aside class="${hash()}">
        <div class="${hash()}"><h2 class="${hash()}">${dbl("Akiket ismerhetsz")}</h2></div>
        <ul class="${hash()}">${railList(4)}</ul>
      </aside>
${ownerColumn({
  name: "Tóth-Szűcs Örs Ábel",
  headline: "Gyártásvezető · Kecskemét",
  location: "Kecskemét, Bács-Kiskun, Magyarország",
  connections: "1 284 kapcsolat",
  slug: D_SLUG,
})}
    </section>
    <section class="${hash()}">
      <div class="${hash()}"><h2 class="${hash()}">${dbl("Névjegy")}</h2></div>
      <div class="${hash()}">${dbl(
        "Húsz éve dolgozom autóipari gyártásban, jelenleg présüzemi folyamatokat vezetek Kecskeméten.",
      )}</div>
    </section>
    <section class="${hash()}">
      <div class="${hash()}"><h2 class="${hash()}">${dbl("Tapasztalat")}</h2></div>
      <ul class="${hash()}">
        <li class="${hash()}">
          <div class="${hash()}">${dbl("Gyártásvezető")}</div>
          <span class="${hash()}">${dbl("Alföld Présüzem Zrt. · Teljes munkaidős")}</span>
        </li>
      </ul>
    </section>
  </main>`,
});

// ---------------------------------------------------------------------------
// (e) deliberately mangled: a SECOND /in/ identity inside the top card
// ---------------------------------------------------------------------------
// The boundary test must fail loudly here and capture must degrade to name-only,
// rather than silently reading fields out of a container holding two people.
const fixtureE = page({
  title: "Kovács Anna | LinkedIn",
  body: `<main class="${hash()}">
    <section class="${hash()}">
      <div class="${hash()}">
        <a href="/in/${OWNER_SLUG}/" class="${hash()}">
          <img class="${hash()}" width="200" alt="Kovács Anna" src="${PLACEHOLDER_GIF}" srcset="${PHOTO_400} 400w">
        </a>
        <a href="/in/${OWNER_SLUG}/" class="${hash()}">${dbl("Kovács Anna")}</a>
        <div class="${hash()}">${dbl("Ügyvezető @ Danubia Fogászat")}</div>
        <div class="${hash()}">${dbl("Budapest, Budapest, Hungary")}</div>
        <!-- the intruder: another person inside the same card -->
        <a href="/in/person-2-fixture/" class="${hash()}">${dbl("Keletso Thophego, CFP")}</a>
      </div>
    </section>
  </main>`,
});

const files = [
  ["a-authenticated-with-right-rail.html", fixtureA],
  ["b-no-right-rail.html", fixtureB],
  ["c-contact-info-overlay.html", fixtureC],
  ["d-accented-name-hungarian-location.html", fixtureD],
  ["e-mangled-two-identities.html", fixtureE],
];

for (const [name, html] of files) {
  writeFileSync(join(HERE, name), html, "utf8");
  console.log(`${name}  ${html.length} bytes`);
}
