import type { CaptureBody } from "./body";
import { contactNoteLines, type ResolvedContact } from "./resolve-contact";

/**
 * Turning a capture into the lead's notes.
 *
 * This is the fix for "Research with Claude does nothing on a captured lead".
 * `runResearch` refuses to spend a Sonnet call on a lead with no prose to
 * analyse, and it looked for that prose in `notes` — but the capture endpoint
 * wrote every field it read into its own column and never wrote `notes` at all.
 * So every extension-captured lead permanently answered "there is no profile
 * text to analyse yet", no matter how much text the extension had actually
 * read. The two halves simply never met.
 *
 * The composed block is also what the paste box produces by hand, which is the
 * point: after this, a captured lead and a pasted one are the same kind of
 * thing, and `preParse` can pull an address or a city out of either.
 */

export const CAPTURE_BEGIN = "--- captured from LinkedIn ---";
export const CAPTURE_END = "--- end of capture ---";

/**
 * The profile as prose, in the order a person would read it — or nothing at all
 * when the capture read nothing worth writing down.
 *
 * The empty case is not a nicety. `hasAnalyzableText` is what stops a research
 * call being spent on a lead with no input (CLAUDE.md hard rule #3), and it
 * measures the notes field as a whole. A block containing only its own header,
 * footer and a URL clears that bar on the strength of the decoration alone — so
 * writing one for a capture that read nothing would quietly disarm the gate for
 * exactly the leads it exists to catch. A capture with real material in it
 * writes a block; a capture without stays silent and leaves notes as it found
 * them.
 */
export function composeCapturedNotes(input: CaptureBody, contact?: ResolvedContact): string {
  const scalars = [
    input.name,
    input.headline,
    input.jobTitle,
    input.companyName,
    input.location,
    contact?.email,
    contact?.phone,
    contact?.websiteUrl,
  ].filter(Boolean);
  // Prose is enough on its own; otherwise it takes a few facts to be worth a
  // research call. A name and nothing else is not a profile.
  const worthWriting = !!input.bio || input.posts.length > 0 || scalars.length >= 3;
  if (!worthWriting) return "";

  const lines = [
    input.name && `Name: ${input.name}`,
    input.headline && `Headline: ${input.headline}`,
    input.jobTitle && `Role: ${input.jobTitle}`,
    input.companyName && `Company: ${input.companyName}`,
    input.location && `Location: ${input.location}`,
    `Profile: ${input.url}`,
    // Resolved rather than raw: "Email:" here has to be the same address that
    // went into the lead's email column, and composing them from different
    // sources is how the two quietly diverge.
    ...(contact ? contactNoteLines(contact) : []),
  ].filter(Boolean);

  if (input.bio) lines.push("", "About:", input.bio);
  if (input.posts.length > 0) {
    lines.push("", "Recent posts:");
    for (const post of input.posts) lines.push(`- ${post}`);
  }

  return [CAPTURE_BEGIN, ...lines, CAPTURE_END].join("\n");
}

/**
 * Fold a fresh capture into whatever is already in the notes field.
 *
 * Delimited rather than overwritten, because notes belong to the person using
 * the app: a BDR writes "spoke to her at the trade fair, call back in March"
 * there, and a re-capture must not eat it. The block between the markers is
 * ours to replace; everything outside them is theirs to keep.
 */
export function mergeCapturedNotes(existing: string | null | undefined, block: string): string {
  const current = (existing ?? "").trim();
  // A capture that read nothing replaces nothing — a worse read of the same
  // profile must not wipe a better one.
  if (block.trim().length === 0) return current;
  if (current.length === 0) return block;

  const begin = current.indexOf(CAPTURE_BEGIN);
  const end = current.indexOf(CAPTURE_END);
  if (begin !== -1 && end > begin) {
    const before = current.slice(0, begin).trimEnd();
    const after = current.slice(end + CAPTURE_END.length).trimStart();
    return [before, block, after].filter((s) => s.length > 0).join("\n\n");
  }

  // No previous capture: the human's text comes first, because it is the part
  // worth reading.
  return `${current}\n\n${block}`;
}
