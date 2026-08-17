/**
 * Matching and ranking for global search (playbook-v2 P3/1).
 *
 * WHY THIS IS TYPESCRIPT AND NOT SQL. The playbook asks for pg_trgm. Two things
 * argued against it:
 *
 *   - The real-world failure here is ACCENTS, not typos: "Kobanyai" not finding
 *     "Kőbányai" is what actually happens, and pg_trgm does not fix that
 *     without `unaccent` layered on top.
 *   - Raw SQL bypasses the Prisma tenant guard, which CLAUDE.md hard rule #1
 *     makes mandatory and an ESLint rule enforces. On the current deployment
 *     RLS is inert too (the app connects as superuser), so that guard is the
 *     only tenancy enforcement there is. Spending it on a search feature is a
 *     bad trade.
 *
 * So candidates are fetched through the guarded client and matched here. At the
 * scale this product targets (P6: 5,000 leads) that is a few milliseconds and a
 * few hundred kilobytes.
 *
 * ⚠️ THE LIMIT, written down for whoever finds this later: this approach is
 * linear in the number of rows per workspace. It is comfortable to ~50,000 and
 * wrong beyond it. Past that, revisit pg_trgm — but fix the RLS gap first
 * (docs DEPLOY-STATE.md) so raw SQL is not the only thing between a query and
 * another tenant's data.
 */

/**
 * Lower-cased and stripped of diacritics.
 *
 * This is the whole reason the module exists: Hungarian names are full of
 * accents that nobody types when searching in a hurry, and "Kobanyai" must find
 * "Kőbányai".
 */
export function foldText(raw: string | null | undefined): string {
  return (raw ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

/** Collapse whitespace too, for word-boundary checks. */
function words(folded: string): string[] {
  return folded.split(/[\s.,;:/\\()[\]{}<>@_-]+/).filter(Boolean);
}

/**
 * Edit distance where an ADJACENT TRANSPOSITION COSTS ONE, abandoned as soon as
 * it exceeds `max`.
 *
 * Damerau-Levenshtein rather than plain Levenshtein, and that choice is
 * load-bearing: transposing two letters is the single most common way people
 * mistype a name, and plain Levenshtein charges it two edits. With a budget of
 * one — which is all a seven-character query should get — "danubai" would fail
 * to find "danubia", i.e. the exact case this whole module exists for.
 *
 * Bounded because an unbounded distance over thousands of candidates is the one
 * way this approach could get slow, and a distance of 9 is not information:
 * anything past the limit is simply "no".
 */
export function boundedLevenshtein(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Two previous rows, because a transposition looks back two of each.
  let twoBack: number[] | null = null;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(
        current[j - 1]! + 1,
        previous[j]! + 1,
        previous[j - 1]! + cost,
      );
      if (
        twoBack &&
        i > 1 &&
        j > 1 &&
        a[i - 1] === b[j - 2] &&
        a[i - 2] === b[j - 1]
      ) {
        value = Math.min(value, twoBack[j - 2]! + 1);
      }
      current.push(value);
      if (value < rowMin) rowMin = value;
    }
    // Every remaining path is already worse than the budget.
    if (rowMin > max) return max + 1;
    twoBack = previous;
    previous = current;
  }
  return previous[b.length]!;
}

/**
 * How much typing error to forgive, by query length.
 *
 * A one- or two-letter query gets nothing: "ab" is one edit from a dozen
 * unrelated words, and tolerance there is noise rather than help.
 *
 * From three characters up it gets one edit, which is deliberate rather than
 * generous — Hungarian surnames are short and mistyped constantly ("Nagi" for
 * "Nagy", "Kis" for "Kiss"), and refusing to forgive a single letter on a
 * four-character name is refusing to help in the most common case there is.
 *
 * The looseness is affordable because of where fuzzy matches sit: below every
 * exact tier, filtered by a minimum score, capped per entity type, and only
 * reached at all when the exact pass found nothing. A few near-misses at the
 * bottom of an otherwise empty list are worth more than an empty list.
 */
export function editBudget(queryLength: number): number {
  if (queryLength <= 2) return 0;
  if (queryLength <= 7) return 1;
  if (queryLength <= 12) return 2;
  return 3;
}

export const SCORE = {
  exact: 100,
  prefix: 80,
  wordPrefix: 70,
  substring: 55,
  /** Fuzzy hits start below every exact kind, so they can never displace one. */
  fuzzy: 40,
} as const;

/**
 * Score one field against the query. 0 means no match.
 *
 * The tiers matter more than the numbers: someone typing the first letters of a
 * name they know must not have it pushed down by a coincidental near-match
 * somewhere else, so every exact-ish tier outranks every fuzzy one.
 */
export function scoreField(query: string, field: string | null | undefined): number {
  const q = foldText(query);
  const f = foldText(field);
  if (q.length === 0 || f.length === 0) return 0;

  if (f === q) return SCORE.exact;
  if (f.startsWith(q)) {
    // A prefix of a short field is a better hit than a prefix of a long one:
    // "dan" matching "Danubia" beats it matching "Dan's Very Long Holding Kft".
    return SCORE.prefix + Math.round((q.length / f.length) * 10);
  }
  if (words(f).some((w) => w.startsWith(q))) return SCORE.wordPrefix;
  if (f.includes(q)) return SCORE.substring;

  const budget = editBudget(q.length);
  if (budget === 0) return 0;

  // Compare against whole words as well as the whole field: a typo in a
  // surname should still find "Nagy Anna" when the query is one word.
  const candidates = [f, ...words(f)];
  let best = budget + 1;
  for (const candidate of candidates) {
    const distance = boundedLevenshtein(q, candidate, budget);
    if (distance < best) best = distance;
    if (best === 0) break;
  }
  return best <= budget ? SCORE.fuzzy - best * 5 : 0;
}

/** Best score for ONE term across several fields. */
function bestFieldScore(term: string, fields: Array<string | null | undefined>): number {
  let best = 0;
  for (const field of fields) {
    const score = scoreField(term, field);
    if (score > best) best = score;
  }
  return best;
}

/**
 * Score a whole query — which may be several words — against several fields.
 *
 * EVERY TERM MUST MATCH SOMETHING, and terms are scored independently. That is
 * what makes "Nagy Fogászat" find "Nagy Béla Fogászat": the words are not
 * adjacent in the field, so treating the query as one string scores zero, which
 * is how a perfectly reasonable search silently returns nothing.
 *
 * Requiring all terms rather than any keeps a second word NARROWING the search,
 * the way every search box a person has ever used behaves. The average is the
 * score, so a query matching two fields precisely outranks one matching both
 * vaguely.
 */
export function scoreFields(
  query: string,
  fields: Array<string | null | undefined>,
): number {
  const terms = words(foldText(query));
  // One term (or none after folding): score the query as typed, so trailing
  // punctuation like "anna@" still counts as a prefix.
  if (terms.length <= 1) return bestFieldScore(query, fields);

  let total = 0;
  for (const term of terms) {
    const best = bestFieldScore(term, fields);
    if (best === 0) return 0;
    total += best;
  }
  return Math.round(total / terms.length);
}

/**
 * Tax id matching ignores punctuation entirely.
 *
 * A Hungarian adószám is written 12345678-1-42, 12345678142, or with spaces,
 * and someone pasting one from an invoice should not have to guess which form
 * we stored.
 */
/**
 * How alike two strings are, 0..1 (playbook-v2 P5/2 duplicate detection).
 *
 * Normalised edit distance rather than trigram overlap: the strings being
 * compared here are company and person names — short, and usually differing by
 * a suffix, an accent or a typo, which is exactly what edit distance measures
 * well and what trigram overlap measures badly at this length.
 *
 * Both sides are folded first, so "Danubia Kft" and "danubia kft" are identical
 * rather than merely similar.
 */
export function similarity(a: string, b: string): number {
  const x = foldText(a);
  const y = foldText(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const longest = Math.max(x.length, y.length);
  // A cap keeps the DP bounded. `boundedLevenshtein` answers cap+1 rather than
  // the true distance once it gives up, which is fine here: the ratio it
  // produces is already below any threshold worth acting on.
  const distance = boundedLevenshtein(x, y, Math.ceil(longest / 2));
  return Math.max(0, 1 - distance / longest);
}

export function taxIdMatches(query: string, taxId: string | null | undefined): boolean {
  const digits = (s: string) => s.replace(/\D/g, "");
  const q = digits(query);
  const t = digits(taxId ?? "");
  if (q.length < 4 || t.length === 0) return false;
  return t.startsWith(q) || t.includes(q);
}
