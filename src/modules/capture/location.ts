/**
 * Reading a place out of a LinkedIn location line — and refusing to.
 *
 * THE GOVERNING RULE IS "EMPTY BEATS WRONG". A blank city costs a BDR five
 * seconds of typing. A wrong one is worse than blank in a way that compounds:
 * it looks like data, it gets filtered on, it reaches a quote, and nobody
 * re-checks a field that is already filled in.
 *
 * This exists because "Keletso Thophego, CFP" — a stranger from the right-hand
 * rail — was captured as a lead's city. The old test for "is this a place" was
 * "contains a comma, has no digits, under 100 characters", and a person with a
 * credential suffix passes all three. So the test is now positive rather than
 * negative: a location must RESOLVE against a known place, not merely fail to
 * look like something else.
 *
 * WHERE THIS RUNS, AND WHY IT IS HERE RATHER THAN IN THE EXTENSION: the
 * extension can only do the checks that need the page — is this string also the
 * text of some other person's profile link, does it sit inside the bounded top
 * card. List-based checks belong on one authoritative copy of the list, and a
 * gazetteer duplicated into an injected content script would drift from this one
 * within a release. So the extension sends what it read and why it believes it;
 * the server decides whether it resolves.
 */

/** Comparison key: accent-insensitive, case-insensitive, whitespace-collapsed. */
export function placeKey(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[.]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Hungarian settlements. Weighted to where this business actually sells: every
 * county seat, plus the larger towns. Not exhaustive by design — an unknown
 * small village leaves the city blank, which is the correct failure.
 */
const HU_CITIES = [
  "Budapest", "Debrecen", "Szeged", "Miskolc", "Pécs", "Győr", "Nyíregyháza",
  "Kecskemét", "Székesfehérvár", "Szombathely", "Szolnok", "Tatabánya",
  "Kaposvár", "Érd", "Veszprém", "Békéscsaba", "Zalaegerszeg", "Sopron",
  "Eger", "Nagykanizsa", "Dunaújváros", "Hódmezővásárhely", "Salgótarján",
  "Cegléd", "Baja", "Vác", "Szekszárd", "Ózd", "Pápa", "Gödöllő", "Esztergom",
  "Gyula", "Kiskunfélegyháza", "Ajka", "Mosonmagyaróvár", "Kazincbarcika",
  "Orosháza", "Kiskunhalas", "Szentes", "Dunakeszi", "Hajdúböszörmény",
  "Gyöngyös", "Siófok", "Keszthely", "Balatonfüred",
  "Szigetszentmiklós", "Vecsés", "Nagykőrös", "Komárom",
  "Hatvan", "Berettyóújfalu", "Mohács", "Tata", "Bonyhád", "Sárvár",
  "Csongrád", "Makó", "Tiszaújváros", "Békés", "Karcag", "Jászberény",
  "Törökszentmiklós", "Hajdúszoboszló", "Püspökladány", "Marcali", "Barcs",
];

/** Hungarian counties — the middle element of a three-part location line. */
const HU_COUNTIES = [
  "Bács-Kiskun", "Baranya", "Békés", "Borsod-Abaúj-Zemplén", "Csongrád-Csanád",
  "Csongrád", "Fejér", "Győr-Moson-Sopron", "Hajdú-Bihar", "Heves",
  "Jász-Nagykun-Szolnok", "Komárom-Esztergom", "Nógrád", "Pest", "Somogy",
  "Szabolcs-Szatmár-Bereg", "Tolna", "Vas", "Veszprém", "Zala", "Budapest",
];

/** Cities a Hungarian BDR plausibly meets on a profile. */
const INTL_CITIES = [
  "London", "Vienna", "Wien", "Berlin", "Munich", "München", "Hamburg",
  "Frankfurt", "Cologne", "Stuttgart", "Düsseldorf", "Paris", "Lyon",
  "Amsterdam", "Rotterdam", "Brussels", "Antwerp", "Madrid", "Barcelona",
  "Lisbon", "Porto", "Rome", "Milan", "Turin", "Zurich", "Zürich", "Geneva",
  "Basel", "Prague", "Praha", "Brno", "Bratislava", "Košice", "Warsaw",
  "Kraków", "Wrocław", "Bucharest", "Cluj-Napoca", "Timișoara", "Oradea",
  "Belgrade", "Novi Sad", "Subotica", "Zagreb", "Split", "Ljubljana",
  "Maribor", "Sofia", "Athens", "Thessaloniki", "Istanbul", "Dublin",
  "Edinburgh", "Manchester", "Birmingham", "Stockholm", "Gothenburg",
  "Copenhagen", "Oslo", "Helsinki", "Tallinn", "Riga", "Vilnius", "Kyiv",
  "Lviv", "Dubai", "Abu Dhabi", "Tel Aviv", "Singapore", "Hong Kong",
  "Tokyo", "Seoul", "Sydney", "Melbourne", "Toronto", "Vancouver",
  "Montreal", "New York", "Brooklyn", "Boston", "Chicago", "Austin",
  "Seattle", "San Francisco", "Los Angeles", "Miami", "Denver", "Atlanta",
  "Washington", "Luxembourg", "Monaco", "Reykjavík",
];

const COUNTRIES = [
  "Hungary", "Magyarország", "Austria", "Ausztria", "Österreich", "Germany",
  "Németország", "Deutschland", "Slovakia", "Szlovákia", "Slovensko",
  "Romania", "Románia", "România", "Serbia", "Szerbia", "Croatia",
  "Horvátország", "Hrvatska", "Slovenia", "Szlovénia", "Slovenija",
  "Ukraine", "Ukrajna", "Poland", "Lengyelország", "Polska", "Czechia",
  "Czech Republic", "Csehország", "Česko", "United Kingdom", "England",
  "Scotland", "Ireland", "Írország", "Netherlands", "Hollandia", "Belgium",
  "France", "Franciaország", "Spain", "Spanyolország", "España", "Portugal",
  "Italy", "Olaszország", "Italia", "Switzerland", "Svájc", "Schweiz",
  "Sweden", "Svédország", "Denmark", "Dánia", "Norway", "Norvégia",
  "Finland", "Finnország", "Estonia", "Latvia", "Lithuania", "Greece",
  "Görögország", "Turkey", "Törökország", "Bulgaria", "Bulgária",
  "United States", "United States of America", "USA", "Canada", "Kanada",
  "Australia", "Ausztrália", "United Arab Emirates", "Israel", "Singapore",
  "Japan", "Japán", "South Korea", "Luxembourg", "Iceland", "Monaco",
];

const HU_CITY_SET = new Set(HU_CITIES.map(placeKey));
const HU_COUNTY_SET = new Set(HU_COUNTIES.map(placeKey));
const INTL_CITY_SET = new Set(INTL_CITIES.map(placeKey));
const COUNTRY_SET = new Set(COUNTRIES.map(placeKey));

export function isKnownCity(raw: string): boolean {
  const k = placeKey(raw);
  return HU_CITY_SET.has(k) || INTL_CITY_SET.has(k);
}
export function isKnownCountry(raw: string): boolean {
  return COUNTRY_SET.has(placeKey(raw));
}
export function isKnownRegion(raw: string): boolean {
  const k = placeKey(raw);
  // A US state-style "CA" / "NY", a Hungarian county, or a metro-area phrase.
  return HU_COUNTY_SET.has(k) || /^[a-z]{2}$/.test(k) || /\b(area|region|metropolitan|megye)\b/.test(k);
}

/**
 * Does this read like a person rather than a place?
 *
 * Two or three capitalized words with no comma, or anything whose trailing
 * comma-part is a credential rather than a region — "Keletso Thophego, CFP",
 * "Anna Nagy, MBA", "John Smith, PhD". Credentials are short, all-caps or
 * dotted, and are never places.
 */
export function looksLikePersonName(raw: string): boolean {
  const s = raw.replace(/\s+/g, " ").trim();
  if (!s) return false;

  const parts = s.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const tail = parts[parts.length - 1]!;
    const tailIsCredential =
      tail.length <= 6 && /^[A-Z][A-Za-z.]*$/.test(tail) && !isKnownCountry(tail) && !isKnownRegion(tail);
    if (tailIsCredential) return true;
  }

  if (parts.length === 1) {
    const words = s.split(" ");
    if (words.length >= 2 && words.length <= 3 && words.every((w) => /^[\p{Lu}][\p{L}'’-]*$/u.test(w))) {
      // Capitalized word pair with no country part. "New York" and "Novi Sad"
      // are the exceptions the gazetteer rescues, so ask it first.
      return !isKnownCity(s);
    }
  }
  return false;
}

export type LocationParse =
  | { ok: true; city: string; region: string | null; country: string | null; full: string }
  | { ok: false; reason: string };

/**
 * Split a LinkedIn location line into city / region / country.
 *
 * Accepts the three shapes LinkedIn actually emits — "City", "City, Country",
 * "City, Region, Country" — and requires the parts to RESOLVE. A line that
 * parses structurally but names nothing recognisable is rejected, because the
 * whole point is that a plausible-looking string is exactly what went wrong.
 */
export function parseLocation(raw: string | null | undefined): LocationParse {
  const full = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!full) return { ok: false, reason: "no_location_text" };
  if (full.length > 120) return { ok: false, reason: "too_long_for_a_place" };
  if (/[@\d]/.test(full) && !/\b(district|kerület|arrondissement)\b/i.test(full)) {
    return { ok: false, reason: "contains_digits_or_at_sign" };
  }
  if (looksLikePersonName(full)) return { ok: false, reason: "reads_as_a_person_name" };

  const parts = full.split(",").map((p) => p.trim()).filter(Boolean);

  if (parts.length === 1) {
    const only = parts[0]!;
    if (isKnownCity(only)) return { ok: true, city: only, region: null, country: null, full };
    if (isKnownCountry(only)) return { ok: false, reason: "country_only_no_city" };
    return { ok: false, reason: "unknown_place" };
  }

  const last = parts[parts.length - 1]!;
  const first = parts[0]!;

  // The tail must be a country or a region; otherwise this is not a location
  // line at all, which is the check "Keletso Thophego, CFP" fails.
  const tailCountry = isKnownCountry(last);
  const tailRegion = isKnownRegion(last);
  if (!tailCountry && !tailRegion) return { ok: false, reason: "tail_is_not_a_country_or_region" };

  if (!isKnownCity(first)) {
    // A recognisable tail with an unrecognised head: keep nothing rather than
    // storing a stranger's name as a city.
    return { ok: false, reason: "head_is_not_a_known_city" };
  }

  const country = tailCountry ? last : null;
  const region = parts.length >= 3 ? parts[1]! : tailRegion ? last : null;
  return { ok: true, city: first, region, country, full };
}
