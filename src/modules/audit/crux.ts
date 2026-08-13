/**
 * Chrome UX Report — field data (P2/2).
 *
 * PageSpeed gives us a LAB score: one synthetic load, from Google's machine,
 * on a simulated phone. CrUX gives the other half — what actual Chrome users
 * on actual connections experienced over the last 28 days. When a prospect
 * says "it's fine on my machine", the field data is the answer, and it is free.
 *
 * Two things this deliberately does NOT do:
 *
 *   - score. A site with CrUX coverage and one without would otherwise be
 *     scored on different check sets, and most Hungarian micro-SMB sites have
 *     no coverage at all. Field data is displayed, not weighed.
 *   - guess. Under the traffic threshold Google returns 404, which is a real
 *     answer meaning "not enough visitors to say" — reported as exactly that,
 *     never as a zero or an error.
 */
const ENDPOINT = "https://chromeuxreport.googleapis.com/v1/records:queryRecord";
const TIMEOUT_MS = 8000;

/** One Core Web Vital as CrUX reports it. */
export interface CruxMetric {
  /** The 75th percentile — the number Google itself grades on. */
  p75: number | null;
  /** Share of loads in each bucket, 0-1. */
  good: number;
  needsImprovement: number;
  poor: number;
}

export interface CruxData {
  /** PHONE when phone-only data existed, otherwise every form factor. */
  formFactor: "PHONE" | "ALL";
  lcp: CruxMetric | null;
  inp: CruxMetric | null;
  cls: CruxMetric | null;
  /** e.g. "2026-07-17 – 2026-08-13", as returned. */
  period: string | null;
}

interface CruxHistogramBin {
  start?: number | string;
  end?: number | string;
  density?: number;
}
interface CruxApiMetric {
  histogram?: CruxHistogramBin[];
  percentiles?: { p75?: number | string };
}
interface CruxApiResponse {
  record?: {
    metrics?: Record<string, CruxApiMetric>;
    collectionPeriod?: {
      firstDate?: { year: number; month: number; day: number };
      lastDate?: { year: number; month: number; day: number };
    };
  };
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Pure: CrUX's three-bin histogram into the shape the report renders. */
export function toMetric(raw: CruxApiMetric | undefined): CruxMetric | null {
  if (!raw) return null;
  const bins = raw.histogram ?? [];
  if (bins.length < 3) return null;
  const density = (i: number) => num(bins[i]?.density) ?? 0;
  return {
    p75: num(raw.percentiles?.p75),
    good: density(0),
    needsImprovement: density(1),
    poor: density(2),
  };
}

function fmtDate(d?: { year: number; month: number; day: number }): string | null {
  if (!d) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.year}-${pad(d.month)}-${pad(d.day)}`;
}

/** Pure: the API payload into CruxData, or null when the record is empty. */
export function parseCruxResponse(
  body: CruxApiResponse,
  formFactor: "PHONE" | "ALL",
): CruxData | null {
  const metrics = body.record?.metrics;
  if (!metrics) return null;
  const lcp = toMetric(metrics.largest_contentful_paint);
  const inp = toMetric(metrics.interaction_to_next_paint);
  const cls = toMetric(metrics.cumulative_layout_shift);
  if (!lcp && !inp && !cls) return null;

  const from = fmtDate(body.record?.collectionPeriod?.firstDate);
  const to = fmtDate(body.record?.collectionPeriod?.lastDate);
  return {
    formFactor,
    lcp,
    inp,
    cls,
    period: from && to ? `${from} – ${to}` : null,
  };
}

/**
 * Origin-level field data for a URL.
 *
 * Origin rather than page level on purpose: a small business site has barely
 * enough traffic for the origin to qualify, and none at all for one URL.
 *
 * Phone data first — it matches the mobile PageSpeed strategy and it is the
 * traffic that matters for these businesses — falling back to all form factors
 * so a site with only desktop coverage still reports something.
 *
 * Returns null for "no data" AND for any failure. The caller renders the same
 * honest "nincs elegendő forgalmi adat" either way: we cannot tell a prospect
 * their visitors are fine when we simply could not look.
 */
export async function fetchCrux(
  url: string,
  apiKey: string | null = null,
  doFetch: typeof fetch = fetch,
  /**
   * Called once per HTTP request. This function may make up to four (two form
   * factors × two origins), so the cost panel would undercount by 4× if it
   * assumed one call per invocation.
   */
  onUsage?: (calls: number) => void,
): Promise<CruxData | null> {
  const key = apiKey ?? process.env.CRUX_API_KEY ?? process.env.PAGESPEED_API_KEY;
  if (!key) return null;

  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return null;
  }

  const query = async (
    forOrigin: string,
    formFactor: "PHONE" | "ALL",
  ): Promise<CruxData | null> => {
    try {
      onUsage?.(1);
      const res = await doFetch(`${ENDPOINT}?key=${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          origin: forOrigin,
          ...(formFactor === "PHONE" ? { formFactor: "PHONE" } : {}),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      // 404 is the documented "this origin has insufficient data" answer.
      if (!res.ok) return null;
      return parseCruxResponse((await res.json()) as CruxApiResponse, formFactor);
    } catch {
      return null;
    }
  };

  const found =
    (await query(origin, "PHONE")) ?? (await query(origin, "ALL"));
  if (found) return found;

  // https://telekom.hu and https://www.telekom.hu are DIFFERENT origins to
  // CrUX, and a site's traffic is usually recorded under only one of them.
  // Checking the counterpart is what stops a busy site being reported as
  // having "not enough traffic" — which is how this was found: the bare
  // domain returned nothing while www returned a full record.
  const other = counterpartOrigin(origin);
  if (!other) return null;
  return (await query(other, "PHONE")) ?? (await query(other, "ALL"));
}

/** The same origin with www added or removed, or null when it has neither form. */
export function counterpartOrigin(origin: string): string | null {
  try {
    const u = new URL(origin);
    u.hostname = u.hostname.startsWith("www.")
      ? u.hostname.slice(4)
      : `www.${u.hostname}`;
    return u.origin;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Plain language
// ---------------------------------------------------------------------------

/** Google's own Core Web Vitals thresholds. */
export const CRUX_THRESHOLDS = {
  lcp: { good: 2500, poor: 4000 },
  inp: { good: 200, poor: 500 },
  cls: { good: 0.1, poor: 0.25 },
} as const;

export type CruxVerdict = "good" | "needs-improvement" | "poor";

export function verdictFor(metric: keyof typeof CRUX_THRESHOLDS, p75: number | null): CruxVerdict | null {
  if (p75 === null) return null;
  const t = CRUX_THRESHOLDS[metric];
  if (p75 <= t.good) return "good";
  if (p75 <= t.poor) return "needs-improvement";
  return "poor";
}

export function formatMetric(metric: keyof typeof CRUX_THRESHOLDS, p75: number | null): string {
  if (p75 === null) return "—";
  if (metric === "cls") return p75.toFixed(2);
  return p75 >= 1000 ? `${(p75 / 1000).toFixed(1)} s` : `${Math.round(p75)} ms`;
}

/**
 * The sentence a prospect actually understands, in Hungarian.
 *
 * Built from the LCP histogram because loading speed is what a visitor
 * experiences as "slow". The share quoted is needs-improvement + poor: those
 * are the visitors for whom the site did not feel fast.
 */
export function fieldSummaryHu(data: CruxData | null): string {
  if (!data || !data.lcp) return "Nincs elegendő forgalmi adat a valós látogatói méréshez.";
  const slow = Math.round((data.lcp.needsImprovement + data.lcp.poor) * 100);
  const scope = data.formFactor === "PHONE" ? "mobilos látogatóinak" : "látogatóinak";
  if (slow === 0) {
    return `Valós ${scope} gyakorlatilag mindegyike gyorsnak érzékeli az oldalt.`;
  }
  return `Valós ${scope} ${slow}%-a lassúnak érzékeli az oldalt (Chrome-mérés, ${
    data.period ?? "elmúlt 28 nap"
  }).`;
}

/** The same line for the internal view and the sales PDF. */
export function fieldSummaryEn(data: CruxData | null): string {
  if (!data || !data.lcp) return "No field data — not enough traffic for Chrome to report on.";
  const slow = Math.round((data.lcp.needsImprovement + data.lcp.poor) * 100);
  const scope = data.formFactor === "PHONE" ? "real phone visitors" : "real visitors";
  return slow === 0
    ? `Practically all ${scope} experience the site as fast.`
    : `${slow}% of ${scope} experience the site as slow.`;
}
