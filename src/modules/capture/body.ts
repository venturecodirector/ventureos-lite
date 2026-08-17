import { z } from "zod";

/**
 * What the browser extension is allowed to post (P1/1e).
 *
 * THE CONTRACT: a capture is a best-effort read of someone else's page, so a
 * partial or oversized read must DEGRADE the capture, never reject it. The
 * content script says as much in its own comments — "everything degrades to
 * null rather than throwing, a partial capture is useful" — and the server used
 * to break that promise in two ways:
 *
 *   - `.optional()` accepts `undefined` but NOT `null`, and the content script
 *     sends `null` for every selector that misses. One missing headline failed
 *     the whole body with 400, and the popup showed a flat "Capture failed."
 *   - a long About section or a long photo URL exceeded `.max()` and threw the
 *     entire capture away over one field.
 *
 * Both are fixed here rather than in the extension alone: an old extension
 * version will keep sending nulls for as long as it is installed, and the
 * server is the side that has to be forgiving.
 */

/** Absent, null and empty all mean "not found". Over-long is truncated, not fatal. */
function looseString(max: number) {
  return z
    .string()
    .nullish()
    .transform((v) => {
      const trimmed = (v ?? "").trim();
      // Truncated rather than refused: losing the tail of a bio is a far better
      // outcome than losing the capture.
      return trimmed.length === 0 ? undefined : trimmed.slice(0, max);
    });
}

/**
 * A URL we would like but can live without: anything unusable becomes absent.
 *
 * http(s) ONLY. A `data:` URL parses perfectly well, which is how LinkedIn's
 * 1×1 lazy-load placeholder used to travel all the way to the avatar store
 * before being refused there — the capture reported a photo it had not really
 * read, and the app quietly showed initials instead. Rejecting the scheme here
 * makes the absence honest at the point it becomes true, and keeps an older
 * installed extension from re-introducing it.
 */
function looseUrl(max: number) {
  return z
    .string()
    .nullish()
    .transform((v) => {
      const raw = (v ?? "").trim();
      if (raw.length === 0 || raw.length > max) return undefined;
      try {
        const parsed = new URL(raw);
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
        return raw;
      } catch {
        // A photo we cannot fetch is not a reason to lose the person.
        return undefined;
      }
    });
}

export const captureBodySchema = z.object({
  // The URL is the ONE field that must be real: it identifies the lead and is
  // what dedupe keys on. Without it there is nothing to capture.
  url: z.string().url().max(1000),
  name: looseString(200),
  headline: looseString(400),
  companyName: looseString(200),
  location: looseString(200),
  /** The current role from the experience block — LinkedIn's headline is free
   *  text and often a slogan, so a real job title is a separate field. */
  jobTitle: looseString(200),
  /** Only ever what the person published in their own profile text. */
  email: looseString(320),
  phone: looseString(60),
  /** A personal or company site the profile links to, if it links to one. */
  websiteUrl: looseUrl(500),
  /**
   * The contact-info overlay, as READ — not as decided.
   *
   * The extension sends every candidate with the label LinkedIn put on it, and
   * the server picks and normalises. Choosing which of three websites is the
   * company's, and turning "06 1 234 5678" into E.164, are RULES; rules that
   * exist in two places drift, and an extension already installed on somebody's
   * machine is the copy that cannot be corrected.
   */
  contact: z
    .object({
      emails: z.array(z.string().max(320)).max(5).optional(),
      phones: z
        .array(z.object({ raw: z.string().max(60), qualifier: z.string().max(120).nullish() }))
        .max(5)
        .optional(),
      websites: z
        .array(z.object({ url: z.string().max(500), qualifier: z.string().max(120).nullish() }))
        .max(5)
        .optional(),
    })
    .nullish()
    .transform((v) => v ?? undefined),
  bio: looseString(8000),
  photoUrl: looseUrl(2000),
  /**
   * What the reader tried, and why each field is or is not there.
   *
   * Stored with the capture so a lead can explain itself later. The last two
   * rounds of this bug were expensive because the evidence existed only in a
   * popup message that had already closed — the operator saw "read name" and
   * had no way to hand over what happened underneath.
   *
   * Deliberately loose and size-capped: it is a diagnostic, and a schema strict
   * enough to reject a new probe would mean losing the diagnostic exactly when
   * something new has broken.
   */
  diagnostics: z
    .unknown()
    .nullish()
    .transform((v) => {
      if (v === null || v === undefined) return undefined;
      try {
        const json = JSON.stringify(v);
        // 32 kB is generous for a field-by-field trace and far below anything
        // that would bloat the activity row.
        return json.length > 32_000 ? undefined : (JSON.parse(json) as unknown);
      } catch {
        return undefined;
      }
    }),
  posts: z
    .array(z.string())
    .nullish()
    .transform((v) =>
      (v ?? [])
        .map((p) => p.trim().slice(0, 2000))
        .filter((p) => p.length > 0)
        .slice(0, 5),
    ),
});

export type CaptureBody = z.infer<typeof captureBodySchema>;
