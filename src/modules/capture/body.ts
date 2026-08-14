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

/** A URL we would like but can live without: anything unusable becomes absent. */
function looseUrl(max: number) {
  return z
    .string()
    .nullish()
    .transform((v) => {
      const raw = (v ?? "").trim();
      if (raw.length === 0 || raw.length > max) return undefined;
      try {
        new URL(raw);
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
  bio: looseString(8000),
  photoUrl: looseUrl(2000),
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
