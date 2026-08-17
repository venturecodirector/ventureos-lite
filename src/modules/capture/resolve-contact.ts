import type { CaptureBody } from "./body";
import {
  normalizeEmail,
  normalizePhone,
  normalizeWebsite,
  phoneQualifier,
  pickCompanyWebsite,
} from "./contact";

/**
 * Turning what the overlay said into what the lead gets.
 *
 * The extension reads candidates and their labels; this decides. Every field
 * that does not survive comes back with a reason, because the capture UI has to
 * be able to say "no phone: wrong length for Hungary" rather than showing an
 * empty box and letting the operator wonder whether it looked.
 */
export interface ResolvedContact {
  email: string | null;
  phone: string | null;
  /** "(Mobile)" / "(Home)", kept because it changes how you use the number. */
  phoneNote: string | null;
  websiteUrl: string | null;
  /** Every usable website, when the profile listed more than one. */
  allWebsites: string[];
  reasons: Record<string, string>;
}

export function resolveContact(input: CaptureBody): ResolvedContact {
  const reasons: Record<string, string> = {};
  const contact = input.contact;

  // ---- email --------------------------------------------------------------
  let email: string | null = null;
  const emailCandidates = contact?.emails ?? [];
  // Fall back to the flat field, which is where an older extension build puts it.
  const emailPool = emailCandidates.length > 0 ? emailCandidates : [input.email ?? ""];
  for (const candidate of emailPool) {
    const r = normalizeEmail(candidate);
    if (r.value) {
      email = r.value;
      break;
    }
    if (r.reason && candidate.trim()) reasons.email = r.reason;
  }
  if (!email && !reasons.email && emailPool.every((c) => !c?.trim())) {
    reasons.email = "no_email_in_overlay";
  }

  // ---- phone --------------------------------------------------------------
  let phone: string | null = null;
  let phoneNote: string | null = null;
  const phonePool =
    contact?.phones && contact.phones.length > 0
      ? contact.phones
      : input.phone
        ? [{ raw: input.phone, qualifier: null }]
        : [];
  for (const candidate of phonePool) {
    const r = normalizePhone(candidate.raw);
    if (r.value) {
      phone = r.value;
      phoneNote = phoneQualifier(candidate.qualifier ?? candidate.raw);
      break;
    }
    if (r.reason) reasons.phone = r.reason;
  }
  if (!phone && phonePool.length === 0) reasons.phone = "no_phone_in_overlay";

  // ---- website ------------------------------------------------------------
  let websiteUrl: string | null = null;
  let allWebsites: string[] = [];
  const siteCandidates =
    contact?.websites && contact.websites.length > 0
      ? contact.websites.map((w) => ({ url: w.url, qualifier: w.qualifier ?? null }))
      : input.websiteUrl
        ? [{ url: input.websiteUrl, qualifier: null }]
        : [];
  if (siteCandidates.length > 0) {
    const picked = pickCompanyWebsite(siteCandidates);
    websiteUrl = picked.value;
    allWebsites = picked.all;
    if (!picked.value && picked.reason) reasons.websiteUrl = picked.reason;
  } else {
    reasons.websiteUrl = "no_website_in_overlay";
  }

  return { email, phone, phoneNote, websiteUrl, allWebsites, reasons };
}

/** Present for the notes block: the contact details, once resolved. */
export function contactNoteLines(c: ResolvedContact): string[] {
  const lines: string[] = [];
  if (c.email) lines.push(`Email: ${c.email}`);
  if (c.phone) lines.push(`Phone: ${c.phone}${c.phoneNote ? ` (${c.phoneNote})` : ""}`);
  if (c.websiteUrl) lines.push(`Website: ${c.websiteUrl}`);
  for (const extra of c.allWebsites.filter((w) => w !== c.websiteUrl)) {
    lines.push(`Other website: ${extra}`);
  }
  return lines;
}

/** Normalising a lone website, for callers that only have that. */
export { normalizeWebsite };
