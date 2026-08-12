import type { PsiScores } from "./types";

/**
 * Google PageSpeed Insights (free API). PAGESPEED_API_KEY is optional (raises
 * quota). Returns null on any failure so the audit degrades gracefully.
 */
interface PsiResponse {
  lighthouseResult?: {
    categories?: Record<string, { score?: number | null }>;
  };
}

export async function fetchPsi(
  url: string,
  apiKey: string | null = null,
): Promise<PsiScores | null> {
  const params = new URLSearchParams({ url, strategy: "mobile" });
  for (const c of ["performance", "seo", "accessibility", "best-practices"]) {
    params.append("category", c);
  }
  // Optional; a workspace value wins over the env one.
  const key = apiKey ?? process.env.PAGESPEED_API_KEY;
  if (key) params.set("key", key);

  const res = await fetch(
    `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${params.toString()}`,
  );
  if (!res.ok) return null;
  const data = (await res.json()) as PsiResponse;
  const cats = data.lighthouseResult?.categories ?? {};
  const pct = (c: string): number | null => {
    const s = cats[c]?.score;
    return typeof s === "number" ? Math.round(s * 100) : null;
  };
  return {
    performance: pct("performance"),
    seo: pct("seo"),
    accessibility: pct("accessibility"),
    bestPractices: pct("best-practices"),
  };
}
