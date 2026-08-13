/**
 * Workspace branding (P2/6).
 *
 * Every audit output — the internal header, the sales PDF, the public share
 * page, the self-serve teaser and the emailed report — used to carry "venture
 * co.group" written into the markup. That is fine for one company and wrong for
 * a product: the second workspace would have sent a prospect a report signed by
 * someone else's agency.
 *
 * All of it now comes from here. Venture remains the SEED, so an untouched
 * workspace renders exactly as before, and the "venture" wordmark is only ever
 * a default value rather than a constant in a template.
 *
 * Pure over Workspace.brand, so a rendered artefact can be tested against a
 * second brand without a database.
 */
export interface WorkspaceBrand {
  /** Display name, e.g. "Venture CO Group". */
  name: string;
  /** The two halves of the wordmark: bold, then light. */
  markBold: string;
  markLight: string;
  /** Absolute or /api/files-relative logo. When set, it replaces the wordmark. */
  logoUrl: string | null;
  /** Primary accent and the gradient it sits in. */
  color: string;
  gradientFrom: string;
  gradientTo: string;
  /** The legal line at the foot of a public page or PDF. */
  footerIdentity: string;
  /** Who a report appears to come from. */
  senderName: string;
  senderEmail: string | null;
  /** Path prefix for this workspace's public links, e.g. "r". */
  slugPrefix: string;
}

export const VENTURE_BRAND: WorkspaceBrand = {
  name: "Venture CO Group",
  markBold: "venture",
  markLight: "co.group",
  logoUrl: null,
  color: "#7427C6",
  gradientFrom: "#310B59",
  gradientTo: "#7427C6",
  footerIdentity: "Venture CO Group · Budapest",
  senderName: "Venture CO Group",
  senderEmail: null,
  slugPrefix: "r",
};

const HEX = /^#[0-9a-fA-F]{3,8}$/;

function str(v: unknown, fallback: string): string {
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}

function color(v: unknown, fallback: string): string {
  return typeof v === "string" && HEX.test(v.trim()) ? v.trim() : fallback;
}

/**
 * Read a workspace's brand, falling back per FIELD.
 *
 * Per field rather than per object on purpose: a workspace that set only a
 * colour should not lose the rest of a usable identity, and a half-configured
 * brand must still render something coherent.
 */
export function brandFrom(raw: unknown): WorkspaceBrand {
  if (!raw || typeof raw !== "object") return VENTURE_BRAND;
  const b = raw as Record<string, unknown>;
  const name = str(b.name, VENTURE_BRAND.name);

  // A workspace that named itself but never split a wordmark gets its name as
  // the bold half, so the header reads as theirs rather than as ours.
  const named = name !== VENTURE_BRAND.name;
  return {
    name,
    markBold: str(b.markBold, named ? name : VENTURE_BRAND.markBold),
    markLight: str(b.markLight, named ? "" : VENTURE_BRAND.markLight),
    logoUrl: typeof b.logoUrl === "string" && b.logoUrl.trim() ? b.logoUrl.trim() : null,
    color: color(b.color, VENTURE_BRAND.color),
    gradientFrom: color(b.gradientFrom, color(b.color, VENTURE_BRAND.gradientFrom)),
    gradientTo: color(b.gradientTo, color(b.color, VENTURE_BRAND.gradientTo)),
    footerIdentity: str(b.footerIdentity, named ? name : VENTURE_BRAND.footerIdentity),
    senderName: str(b.senderName, name),
    senderEmail:
      typeof b.senderEmail === "string" && b.senderEmail.includes("@")
        ? b.senderEmail.trim()
        : null,
    slugPrefix: str(b.slugPrefix, VENTURE_BRAND.slugPrefix).replace(/[^a-z0-9-]/gi, "") ||
      VENTURE_BRAND.slugPrefix,
  };
}

/** True when nothing has been customised — used to label the Settings form. */
export function isDefaultBrand(brand: WorkspaceBrand): boolean {
  return (
    brand.name === VENTURE_BRAND.name &&
    brand.color === VENTURE_BRAND.color &&
    brand.logoUrl === null
  );
}

/** `linear-gradient(...)` for whichever surface needs one. */
export function brandGradient(brand: WorkspaceBrand, angle = "135deg"): string {
  return `linear-gradient(${angle},${brand.gradientFrom},${brand.gradientTo})`;
}
