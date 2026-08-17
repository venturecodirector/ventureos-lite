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
  | {
      ok: true;
      city: string;
      region: string | null;
      country: string | null;
      full: string;
      /**
       * "high" when the gazetteer recognised the place, "medium" when it did not
       * but the string is shaped like one. A medium result is still stored — the
       * alternative is an empty City field for every place outside the list.
       */
      confidence: "high" | "medium";
      /** Why the confidence is medium, when it is. */
      reason?: string;
    }
  | { ok: false; reason: string };

/**
 * Region qualifiers LinkedIn wraps around a city name.
 *
 * "San Francisco Bay Area" is the reported case: a metro region rather than a
 * city, absent from a Hungarian-focused gazetteer, so the whole location was
 * discarded as `unknown_place` and the field left blank. The city is right there
 * in the string — the qualifier just has to come off first.
 *
 * Longest first, so " Bay Area" is stripped before " Area" and
 * " Metropolitan Area" before either.
 */
const REGION_QUALIFIERS: { pattern: RegExp; label: string }[] = [
  { pattern: /\s+metropolitan\s+area$/i, label: "metropolitan area" },
  { pattern: /\s+metropolitan\s+region$/i, label: "metropolitan region" },
  { pattern: /\s+metro\s+area$/i, label: "metro area" },
  { pattern: /\s+bay\s+area$/i, label: "bay area" },
  { pattern: /\s+és\s+környéke$/i, label: "és környéke" },
  { pattern: /\s+és\s+vonzáskörzete$/i, label: "és vonzáskörzete" },
  { pattern: /\s+vonzáskörzete?$/i, label: "vonzáskörzet" },
  { pattern: /\s+area$/i, label: "area" },
  { pattern: /\s+region$/i, label: "region" },
  { pattern: /\s+régió(ja)?$/i, label: "régió" },
  { pattern: /^greater\s+/i, label: "greater" },
  { pattern: /^nagyobb\s+/i, label: "nagyobb" },
];

/** Strip every region qualifier, reporting which ones came off. */
export function stripRegionQualifiers(raw: string): { value: string; stripped: string[] } {
  let value = raw.replace(/\s+/g, " ").trim();
  const stripped: string[] = [];
  // Repeat: "Greater Budapest Metropolitan Area" carries one at each end.
  let changed = true;
  while (changed) {
    changed = false;
    for (const { pattern, label } of REGION_QUALIFIERS) {
      const next = value.replace(pattern, "");
      if (next !== value && next.trim().length >= 2) {
        value = next.trim();
        stripped.push(label);
        changed = true;
      }
    }
  }
  return { value, stripped };
}

/**
 * Does this read like a place, even if no gazetteer knows it?
 *
 * One to four capitalised words per comma-separated part. Deliberately structural:
 * the gazetteer cannot list every town on earth, and the failure mode it exists to
 * prevent — a stranger's name filed as a city — is caught by
 * `looksLikePersonName` and by the caller's other-people blocklist, not by
 * exhaustive knowledge of geography.
 */
export function looksLikePlace(raw: string): boolean {
  const s = raw.replace(/\s+/g, " ").trim();
  if (!s || s.length > 120) return false;
  if (/[@\d]/.test(s) && !/\b(district|kerület|arrondissement)\b/i.test(s)) return false;
  const parts = s.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0 || parts.length > 4) return false;
  return parts.every((part) => {
    const words = part.split(" ").filter(Boolean);
    if (words.length === 0 || words.length > 4) return false;
    // Capitalised, or a two-letter state/country code.
    return words.every((w) => /^[\p{Lu}][\p{L}'’.-]*$/u.test(w) || /^[A-Z]{2}$/.test(w));
  });
}

/**
 * Split a LinkedIn location line into city / region / country.
 *
 * Accepts the three shapes LinkedIn actually emits — "City", "City, Country",
 * "City, Region, Country" — and requires the parts to RESOLVE. A line that
 * parses structurally but names nothing recognisable is rejected, because the
 * whole point is that a plausible-looking string is exactly what went wrong.
 */
export function parseLocation(
  raw: string | null | undefined,
  opts: { blocklist?: string[] } = {},
): LocationParse {
  const full = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!full) return { ok: false, reason: "no_location_text" };
  if (full.length > 120) return { ok: false, reason: "too_long_for_a_place" };
  if (/[@\d]/.test(full) && !/\b(district|kerület|arrondissement)\b/i.test(full)) {
    return { ok: false, reason: "contains_digits_or_at_sign" };
  }

  /**
   * The blocklist FIRST, ahead of every other check.
   *
   * A stranger's name is the one thing that must never become a city, the caller
   * knows every other person on the page, and this is the most specific reason
   * available — reporting it as a generic "reads as a person name" would hide the
   * fact that we knew exactly who it was.
   */
  const blocked = (opts.blocklist ?? []).map(placeKey).filter((k) => k.length >= 4);
  if (blocked.length > 0) {
    const k = placeKey(full);
    if (blocked.some((b) => k === b || k.includes(b) || b.includes(k))) {
      return { ok: false, reason: "matches_another_person_on_page" };
    }
  }

  /**
   * PARSE BEFORE VALIDATING. "San Francisco Bay Area" is a city wearing a metro
   * qualifier; stripping it turns an `unknown_place` into a gazetteer hit.
   *
   * And the person-name test runs on the STRIPPED string, not the raw one. On the
   * raw one it fired for "Ouagadougou Metropolitan Area" — three capitalised words
   * with no comma, which is also the shape of a full name — and rejected a real
   * city as a person.
   */
  const { value: cleaned, stripped } = stripRegionQualifiers(full);
  if (looksLikePersonName(cleaned)) return { ok: false, reason: "reads_as_a_person_name" };
  const parts = cleaned.split(",").map((p) => p.trim()).filter(Boolean);
  const first = parts[0]!;
  const last = parts[parts.length - 1]!;

  /**
   * The permissive path, and the reason it exists.
   *
   * The gazetteer is Hungarian-focused with a short international list, so it
   * cannot recognise most of the world. Rejecting everything it does not know
   * meant a captured location string — visibly present on the profile — was
   * silently dropped and the City field left blank. A place that is SHAPED like a
   * place is stored at medium confidence and labelled, which is honest and
   * useful; blank is neither.
   */
  const permissive = (city: string, region: string | null, country: string | null): LocationParse =>
    /**
     * The HEAD is checked separately, and this is load-bearing.
     *
     * `looksLikePersonName` only applies its capitalised-word-pair rule to a
     * comma-free string, so "Some Person, Hungary" sailed past it — a real country
     * tail with a human's name as the head — and the permissive path would have
     * filed "Some Person" as a city. A two-word unknown city with a country tail is
     * refused along with it; that is the trade the brief asks for, and the raw
     * string is still stored either way.
     */
    !looksLikePersonName(city) && looksLikePlace(cleaned)
      ? {
          ok: true,
          city,
          region,
          country,
          full,
          confidence: "medium",
          reason: stripped.length > 0 ? "not_in_gazetteer_after_stripping_qualifier" : "not_in_gazetteer",
        }
      : { ok: false, reason: "does_not_read_as_a_place" };

  if (parts.length === 1) {
    if (isKnownCity(first)) {
      return { ok: true, city: first, region: null, country: null, full, confidence: "high" };
    }
    if (isKnownCountry(first)) return { ok: false, reason: "country_only_no_city" };
    return permissive(first, null, null);
  }

  const tailCountry = isKnownCountry(last);
  const tailRegion = isKnownRegion(last);
  const country = tailCountry ? last : null;
  const region = parts.length >= 3 ? parts[1]! : tailRegion ? last : null;

  // Both halves recognised: the strongest result.
  if (isKnownCity(first) && (tailCountry || tailRegion)) {
    return { ok: true, city: first, region, country, full, confidence: "high" };
  }
  // Otherwise fall to shape. The head is still the city — that is the one thing
  // LinkedIn's format guarantees — and the person-name and blocklist checks above
  // are what stop a human's name arriving here.
  return permissive(first, region, country);
}
