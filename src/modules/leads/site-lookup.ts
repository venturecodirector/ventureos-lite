"use server";

import { z } from "zod";
import { getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { callClaude } from "@/lib/ai/call-claude";
import { BudgetExceededError } from "@/lib/ai/budget";
import {
  SITE_LOOKUP_SYSTEM,
  siteLookupSchema,
  buildSiteLookupMessage,
  type SiteLookupAnswer,
} from "@/lib/ai/prompts/site-lookup";
import { normalizeDomain, isDirectoryDomain } from "./domain";
import { readSite, type SiteSkipReason } from "./enrichment";

/**
 * The Lookup button next to the Domain field.
 *
 * ── TWO PATHS, AND ONLY ONE OF THEM COSTS ANYTHING ─────────────────────────
 *
 * Domain already filled in → no model call at all. We read the site itself and
 * hand back the contact details on it, which is the deterministic thing to do
 * and the cheaper one.
 *
 * Domain empty → Claude searches the web for the company's own site (Haiku,
 * capped searches, through the budget middleware and logged to ClaudeUsage like
 * every other call). Then the found site is read the same way, so a search hit
 * yields contacts too rather than just a URL.
 *
 * ── WHAT IT DOES NOT DO ────────────────────────────────────────────────────
 *
 * It saves nothing. Exactly like the adószám lookup, it hands values back to
 * the form and Save changes is still a deliberate press — so a wrong guess is
 * one Cancel away from never having happened.
 */

const inputSchema = z.object({
  leadId: z.string().min(1),
  /** Whatever is in the form's Domain field right now — possibly empty. */
  domain: z.string().trim().max(300).default(""),
  companyName: z.string().trim().max(300).default(""),
  city: z.string().trim().max(200).default(""),
  taxId: z.string().trim().max(40).default(""),
});

export type SiteLookupResult =
  | {
      ok: true;
      domain: string;
      /** Whether we read what was typed, or had to go and find it. */
      source: "typed" | "web_search";
      confidence: "high" | "medium" | "low" | null;
      /** Claude's one-line justification, when a search was involved. */
      reason: string | null;
      evidenceUrl: string | null;
      /** Contacts read off the site — never applied over a filled field. */
      emails: string[];
      phones: string[];
      /** Why the site itself gave nothing, when it gave nothing. */
      siteSkipped: SiteSkipReason | null;
      /** That reason as a sentence, composed here so one wording exists. */
      siteNote: string | null;
    }
  | { ok: false; error: string };

/** Why a site could not be read, in words an operator can act on. */
const SKIP_TEXT: Record<SiteSkipReason, string> = {
  no_domain: "that does not look like a domain",
  robots: "the site's robots.txt forbids reading it",
  unreachable: "the site could not be reached",
  empty: "there was no readable text on the page",
  blocked: "that hostname is not a public website",
};

export async function lookupCompanySite(raw: unknown): Promise<SiteLookupResult> {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Incomplete request." };
  const input = parsed.data;

  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  // Tenancy: the guarded client scopes this to the session's workspace, so a
  // lead id from another one simply is not found — and with it, nobody can use
  // this action as a general-purpose URL fetcher without a lead of their own.
  const lead = await db.lead.findUnique({
    where: { id: input.leadId },
    select: { contactName: true },
  });
  if (!lead) return { ok: false, error: "This lead was not found." };

  const rawDomain = input.domain.trim();
  const typed = normalizeDomain(rawDomain);

  /**
   * Something IS in the field, and it is not a domain.
   *
   * Falling through to the web search here would be the worst of both: the
   * operator typed an address, got no word about it being unusable, and paid
   * for a search they never asked for. Say what is wrong instead, and let
   * clearing the field be the deliberate way to ask for a search.
   */
  if (rawDomain && !typed) {
    return {
      ok: false,
      error: `"${rawDomain}" is not a domain. Correct it, or clear the field to search for the company's site instead.`,
    };
  }

  // ── Path 1: we already have a domain. Just read it. ────────────────────────
  if (typed) {
    if (isDirectoryDomain(typed)) {
      return {
        ok: false,
        error: `${typed} is a directory or social profile, not the company's own site.`,
      };
    }
    const read = await readSite(typed);
    return {
      ok: true,
      domain: typed,
      source: "typed",
      confidence: null,
      reason: null,
      evidenceUrl: null,
      emails: read.contacts.emails,
      phones: read.contacts.phones,
      siteSkipped: read.skipped,
      siteNote: read.skipped ? SKIP_TEXT[read.skipped] : null,
    };
  }

  // ── Path 2: no domain. Search for one. ────────────────────────────────────
  if (input.companyName.length < 2) {
    return {
      ok: false,
      error: "Enter a domain, or a company name to search for one.",
    };
  }

  let answer: SiteLookupAnswer;
  try {
    const res = await callClaude({
      useCase: "site_lookup",
      workspaceId,
      system: SITE_LOOKUP_SYSTEM,
      messages: [
        {
          role: "user",
          content: buildSiteLookupMessage({
            companyName: input.companyName,
            city: input.city || null,
            taxId: input.taxId || null,
            contactName: lead.contactName || null,
          }),
        },
      ],
      schema: siteLookupSchema,
      // Four searches is enough for "name + city" then a refinement; the cap is
      // what stops one click from turning into an open-ended research session.
      webSearch: { maxUses: 4 },
    });
    answer = res.data as SiteLookupAnswer;
  } catch (e) {
    if (e instanceof BudgetExceededError) return { ok: false, error: e.message };
    throw e;
  }

  if (!answer.domain) {
    return {
      ok: false,
      error: `No site could be identified with confidence. ${answer.reason}`.trim(),
    };
  }

  const found = normalizeDomain(answer.domain);
  if (!found) {
    return { ok: false, error: "The search came back with something that is not a usable domain." };
  }
  // The prompt says not to, but a prompt is guidance: a search for a company
  // name genuinely does return the directory listing first, so this is checked
  // rather than trusted.
  if (isDirectoryDomain(found)) {
    return {
      ok: false,
      error: `The search only found a directory listing (${found}), not the company's own site.`,
    };
  }

  const read = await readSite(found);
  return {
    ok: true,
    domain: found,
    source: "web_search",
    confidence: answer.confidence,
    reason: answer.reason || null,
    evidenceUrl: answer.evidenceUrl,
    emails: read.contacts.emails,
    phones: read.contacts.phones,
    siteSkipped: read.skipped,
    siteNote: read.skipped ? SKIP_TEXT[read.skipped] : null,
  };
}
