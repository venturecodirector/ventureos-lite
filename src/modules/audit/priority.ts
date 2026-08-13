/**
 * Issue prioritisation and effort tags (P2/4).
 *
 * A report that lists twenty failures ranked by nothing hands the reader a
 * problem, not a plan. Every check carries two static properties — how much
 * fixing it is worth, and how much work it is — and the pair sorts the
 * findings into the four things a business owner actually asks: what is cheap
 * and worth it, what is worth planning, what can wait, what to ignore.
 *
 * Both properties are DECLARED, not inferred: no AI anywhere in this item.
 * The registry seeds them and the Owner retunes them in Settings, the same way
 * the category weights already work.
 */
import type { AuditCheck } from "./types";
import { CHECK_META, type AuditCategory } from "./categories";

export const IMPACTS = ["low", "medium", "high"] as const;
export const EFFORTS = ["quick", "day", "project"] as const;

export type Impact = (typeof IMPACTS)[number];
export type Effort = (typeof EFFORTS)[number];

export const EFFORT_LABEL: Record<Effort, { en: string; hu: string }> = {
  quick: { en: "Quick fix", hu: "Gyors javítás" },
  day: { en: "About a day", hu: "Kb. egy nap" },
  project: { en: "Project", hu: "Projekt" },
};

export const IMPACT_LABEL: Record<Impact, { en: string; hu: string }> = {
  high: { en: "High impact", hu: "Nagy hatás" },
  medium: { en: "Medium impact", hu: "Közepes hatás" },
  low: { en: "Low impact", hu: "Kis hatás" },
};

export interface CheckPriority {
  impact: Impact;
  effort: Effort;
}

/**
 * The seed values.
 *
 * Impact is judged on what it costs the BUSINESS, not on how much a developer
 * cares: a missing impresszum is a legal exposure, a missing HSTS header is
 * not something a customer will ever feel. Effort is judged on the work to fix
 * it on a typical small-business site.
 */
export const DEFAULT_CHECK_PRIORITY: Record<string, CheckPriority> = {
  // security & trust
  https: { impact: "high", effort: "day" },
  httpsRedirect: { impact: "medium", effort: "quick" },
  sslExpiry: { impact: "high", effort: "quick" },
  hsts: { impact: "low", effort: "quick" },
  xcto: { impact: "low", effort: "quick" },
  xfo: { impact: "low", effort: "quick" },
  csp: { impact: "low", effort: "day" },
  mixedContent: { impact: "medium", effort: "day" },

  // email hygiene
  spf: { impact: "medium", effort: "quick" },
  dmarc: { impact: "medium", effort: "quick" },

  // Hungarian legal — an actual fine, not an inconvenience
  impresszum: { impact: "high", effort: "quick" },
  privacyPolicy: { impact: "high", effort: "day" },
  aszf: { impact: "high", effort: "day" },
  cookie: { impact: "medium", effort: "day" },

  // findability
  title: { impact: "high", effort: "quick" },
  metaDescription: { impact: "medium", effort: "quick" },
  openGraph: { impact: "medium", effort: "quick" },
  canonical: { impact: "low", effort: "quick" },
  schemaOrg: { impact: "medium", effort: "day" },
  h1: { impact: "medium", effort: "quick" },
  headingHierarchy: { impact: "low", effort: "day" },
  altCoverage: { impact: "medium", effort: "day" },
  sitemap: { impact: "medium", effort: "quick" },
  robots: { impact: "low", effort: "quick" },
  psiSeo: { impact: "medium", effort: "project" },

  // analytics & conversion — where the money leaks
  analytics: { impact: "high", effort: "quick" },
  clickToCall: { impact: "high", effort: "quick" },
  contactForm: { impact: "high", effort: "day" },
  booking: { impact: "high", effort: "project" },
  contact: { impact: "high", effort: "quick" },

  // accessibility
  a11yCritical: { impact: "high", effort: "project" },
  a11ySerious: { impact: "medium", effort: "project" },
  psiAccessibility: { impact: "medium", effort: "project" },

  // speed
  viewport: { impact: "high", effort: "project" },
  pageWeight: { impact: "high", effort: "day" },
  psiPerformance: { impact: "high", effort: "project" },
  copyright: { impact: "low", effort: "quick" },

  // site structure (P2/1)
  brokenLinks: { impact: "high", effort: "quick" },
  redirectChains: { impact: "low", effort: "quick" },
  pageTitles: { impact: "high", effort: "quick" },
  duplicateTitles: { impact: "medium", effort: "quick" },
  pageMetaDescriptions: { impact: "medium", effort: "day" },
  duplicateMetaDescriptions: { impact: "low", effort: "day" },
  h1Consistency: { impact: "low", effort: "quick" },
  orphanPages: { impact: "medium", effort: "day" },
  pageWeightOutliers: { impact: "medium", effort: "day" },
};

/** Anything not in the registry: assume it matters somewhat and costs a day. */
export const FALLBACK_PRIORITY: CheckPriority = { impact: "medium", effort: "day" };

function isImpact(v: unknown): v is Impact {
  return typeof v === "string" && (IMPACTS as readonly string[]).includes(v);
}
function isEffort(v: unknown): v is Effort {
  return typeof v === "string" && (EFFORTS as readonly string[]).includes(v);
}

/**
 * Merge the Owner's overrides from Workspace.auditConfig over the seeds.
 *
 * Per key and per property, so tuning one check's effort does not silently
 * reset its impact.
 */
export function priorityMapFrom(config: unknown): Record<string, CheckPriority> {
  const out: Record<string, CheckPriority> = { ...DEFAULT_CHECK_PRIORITY };
  const raw =
    config && typeof config === "object" && "checkPriority" in config
      ? (config as { checkPriority?: unknown }).checkPriority
      : null;
  if (raw && typeof raw === "object") {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const v = value as { impact?: unknown; effort?: unknown };
      const base = out[key] ?? FALLBACK_PRIORITY;
      out[key] = {
        impact: isImpact(v.impact) ? v.impact : base.impact,
        effort: isEffort(v.effort) ? v.effort : base.effort,
      };
    }
  }
  return out;
}

export interface PrioritizedFinding {
  key: string;
  label: string;
  detail?: string;
  impact: Impact;
  effort: Effort;
  category: AuditCategory | null;
}

/** The four buckets, in the order they should be read. */
export const QUADRANTS = [
  {
    id: "quick-wins",
    en: "Quick wins",
    hu: "Gyors győzelmek",
    note: { en: "High impact, small effort — do these first.", hu: "Nagy hatás, kis munka — ezekkel érdemes kezdeni." },
  },
  {
    id: "projects",
    en: "Worth planning",
    hu: "Fejlesztési projekt",
    note: { en: "High impact, real work — worth scheduling.", hu: "Nagy hatás, valódi munka — érdemes betervezni." },
  },
  {
    id: "fill-ins",
    en: "Fill-ins",
    hu: "Ha van rá idő",
    note: { en: "Smaller gains, cheap to do.", hu: "Kisebb nyereség, olcsón megoldható." },
  },
  {
    id: "later",
    en: "Later",
    hu: "Ráér",
    note: { en: "Neither urgent nor cheap.", hu: "Se nem sürgős, se nem olcsó." },
  },
] as const;

export type QuadrantId = (typeof QUADRANTS)[number]["id"];

export interface PriorityMatrix {
  quadrants: Array<{ id: QuadrantId; findings: PrioritizedFinding[] }>;
  /** Every failing check, ranked — the order the PDF's "Javasolt sorrend" uses. */
  ordered: PrioritizedFinding[];
}

const IMPACT_RANK: Record<Impact, number> = { high: 0, medium: 1, low: 2 };
const EFFORT_RANK: Record<Effort, number> = { quick: 0, day: 1, project: 2 };

export function quadrantFor(p: CheckPriority): QuadrantId {
  const big = p.impact === "high";
  const cheap = p.effort === "quick";
  if (big && cheap) return "quick-wins";
  if (big) return "projects";
  if (cheap) return "fill-ins";
  return "later";
}

/**
 * Failing checks only.
 *
 * A passing check has nothing to prioritise, and listing it here would turn a
 * plan back into an inventory.
 */
export function buildPriorityMatrix(
  checks: AuditCheck[],
  priorities: Record<string, CheckPriority> = DEFAULT_CHECK_PRIORITY,
): PriorityMatrix {
  const findings: PrioritizedFinding[] = checks
    .filter((c) => !c.pass)
    .map((c) => {
      const p = priorities[c.key] ?? FALLBACK_PRIORITY;
      return {
        key: c.key,
        label: c.label,
        ...(c.detail ? { detail: c.detail } : {}),
        impact: p.impact,
        effort: p.effort,
        category: CHECK_META[c.key]?.category ?? null,
      };
    });

  // Impact first, then cheapest — the order you would actually work in.
  const ordered = [...findings].sort(
    (a, b) =>
      IMPACT_RANK[a.impact] - IMPACT_RANK[b.impact] ||
      EFFORT_RANK[a.effort] - EFFORT_RANK[b.effort] ||
      a.label.localeCompare(b.label),
  );

  return {
    quadrants: QUADRANTS.map((q) => ({
      id: q.id,
      findings: ordered.filter((f) => quadrantFor(f) === q.id),
    })),
    ordered,
  };
}
