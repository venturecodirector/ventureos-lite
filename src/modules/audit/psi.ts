import type { PsiScores } from "./types";

/**
 * Google PageSpeed Insights (free API). PAGESPEED_API_KEY is optional, but in
 * practice not optional at all — see `PsiResult.reason` below.
 */
interface PsiResponse {
  lighthouseResult?: {
    categories?: Record<string, { score?: number | null }>;
  };
}

/**
 * Lighthouse is a real page load on Google's hardware. Thirty seconds is
 * normal for a heavy site; a minute happens.
 *
 * A ceiling exists at all because Node's `fetch` has NONE. Without it, one
 * PageSpeed request that connects and then stalls holds the audit job open
 * indefinitely — and with an audit-queue concurrency of two, two such requests
 * wedge every audit in the workspace behind them, permanently, with no error
 * anywhere. That is not a hypothetical: it is what "queued forever" looks like.
 */
const PSI_TIMEOUT_MS = 75_000;

/**
 * Why there is no PageSpeed data, when there is none.
 *
 * This used to be a bare `null` for every outcome, and the audit simply had no
 * performance checks in it. Silence read as "the site is fine": nothing on
 * screen distinguished a site we measured and liked from one Google refused to
 * measure at all.
 *
 * `quota` is the outcome that matters. WITHOUT AN API KEY, the endpoint bills
 * against a shared anonymous project whose daily quota is routinely exhausted
 * by everyone else on the internet — a live check while writing this returned
 * `429 Quota exceeded ... for consumer project_number:583797351490`. So on a
 * deployment with no `PAGESPEED_API_KEY`, PageSpeed silently never worked, and
 * the operator had no way to learn that from the product.
 */
export type PsiFailure = "quota" | "http" | "timeout" | "network" | "malformed";

export interface PsiResult {
  scores: PsiScores | null;
  reason: PsiFailure | null;
  /** One line an operator can act on. Null when the fetch succeeded. */
  detail: string | null;
}

export async function fetchPsi(
  url: string,
  apiKey: string | null = null,
  /** Called once per HTTP request, for the API-cost panel. Never throws. */
  onUsage?: (calls: number) => void,
): Promise<PsiResult> {
  const params = new URLSearchParams({ url, strategy: "mobile" });
  for (const c of ["performance", "seo", "accessibility", "best-practices"]) {
    params.append("category", c);
  }
  // Optional; a workspace value wins over the env one.
  const key = apiKey ?? process.env.PAGESPEED_API_KEY;
  if (key) params.set("key", key);

  onUsage?.(1);
  let res: Response;
  try {
    res = await fetch(
      `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${params.toString()}`,
      { signal: AbortSignal.timeout(PSI_TIMEOUT_MS) },
    );
  } catch (e) {
    const timedOut = (e as Error).name === "TimeoutError";
    return {
      scores: null,
      reason: timedOut ? "timeout" : "network",
      detail: timedOut
        ? "PageSpeed did not answer within 75 seconds."
        : "PageSpeed could not be reached.",
    };
  }

  if (!res.ok) {
    // 429 with no key means the shared anonymous quota, which is a
    // configuration problem with a one-line fix, not an outage.
    if (res.status === 429) {
      return {
        scores: null,
        reason: "quota",
        detail: key
          ? "PageSpeed quota exhausted for this API key."
          : "PageSpeed quota exhausted — set a PageSpeed API key in Settings → Integrations. " +
            "Without a key the audit shares Google's anonymous quota, which is almost always spent.",
      };
    }
    return {
      scores: null,
      reason: "http",
      detail: `PageSpeed answered HTTP ${res.status}.`,
    };
  }

  let data: PsiResponse;
  try {
    data = (await res.json()) as PsiResponse;
  } catch {
    return { scores: null, reason: "malformed", detail: "PageSpeed sent an unreadable answer." };
  }

  const cats = data.lighthouseResult?.categories ?? {};
  const pct = (c: string): number | null => {
    const s = cats[c]?.score;
    return typeof s === "number" ? Math.round(s * 100) : null;
  };
  const scores: PsiScores = {
    performance: pct("performance"),
    seo: pct("seo"),
    accessibility: pct("accessibility"),
    bestPractices: pct("best-practices"),
  };
  // A 200 that carries no Lighthouse run at all is a failure wearing a success
  // code; reporting it as scores-of-null would print four empty checks.
  if (Object.values(scores).every((v) => v === null)) {
    return { scores: null, reason: "malformed", detail: "PageSpeed returned no Lighthouse scores." };
  }
  return { scores, reason: null, detail: null };
}
