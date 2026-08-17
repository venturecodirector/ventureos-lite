import { z } from "zod";
import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { takeRateLimit } from "@/lib/rate-limit";
import { RATE_LIMITS, tooManyRequests } from "@/lib/rate-limit-policy";
import { callClaude } from "@/lib/ai/call-claude";
import {
  PERSON_BRIEF_SYSTEM,
  personBriefSchema,
  buildPersonBriefMessage,
} from "@/lib/ai/prompts/person-brief";
import { resolveCaptureToken } from "@/modules/capture/tokens";
import { storeAvatar } from "@/modules/capture/avatar";
import { normalizeDomain } from "@/modules/leads/dedupe";
import { captureBodySchema } from "@/modules/capture/body";
import { parseLocation } from "@/modules/capture/location";
import { resolveContact } from "@/modules/capture/resolve-contact";
import { composeCapturedNotes, mergeCapturedNotes } from "@/modules/capture/notes";

/**
 * Browser-extension capture (P1/1e).
 *
 * Authenticated by a personal capture token, not a session cookie: the
 * extension runs on linkedin.com and a cross-site cookie would never be sent.
 *
 * The extension only ever posts what the user is looking at, on their explicit
 * click. There is no crawling, no automation and no background collection —
 * CLAUDE.md and this playbook both forbid LinkedIn scraping, and the boundary
 * is that a human is on the page and pressed the button.
 */
export const dynamic = "force-dynamic";


function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function POST(req: Request): Promise<Response> {
  const identity = await resolveCaptureToken(req.headers.get("authorization"));
  if (!identity) return json({ error: "unauthorized" }, 401);

  // A stolen token should not be able to hammer the API or the model budget.
  const rate = await takeRateLimit(
    `${RATE_LIMITS.capture.bucket}:${identity.tokenId}`,
    RATE_LIMITS.capture,
  );
  // With Retry-After, so the extension backs off correctly instead of retrying
  // straight into the same wall (P6/2).
  if (!rate.allowed) return tooManyRequests(rate.resetAtMs, "Too many captures. Slow down.");

  const parsed = captureBodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    // Name the offending fields. The previous bare "bad_request" is why a
    // missing headline presented as an unexplained "Capture failed."
    return json(
      {
        error: "bad_request",
        fields: parsed.error.issues.map((i) => i.path.join(".")).filter(Boolean),
      },
      400,
    );
  }
  const input = parsed.data;

  const db = getWorkspaceClient(identity.workspaceId);

  // Dedupe on the profile URL first, then the company domain — a second
  // capture of the same person updates rather than duplicating.
  const existing = await db.lead.findFirst({
    where: { linkedinUrl: input.url },
    select: {
      id: true, contactName: true, bio: true, personBrief: true, title: true, headline: true,
      email: true, phone: true, notes: true,
    },
  });

  // The location line, resolved. `input.location` is a whole line — "Budapest,
  // Budapest, Hungary" — and storing it in `city` verbatim is how a lead ended
  // up living in "Keletso Thophego, CFP". The extension does the checks that
  // need the page (is this string also some other person's link text, is it
  // inside the bounded card); the gazetteer lives here, on one authoritative
  // copy, and decides whether the place actually resolves.
  const place = parseLocation(input.location);
  const city = place.ok ? place.city : null;

  // The contact-info overlay, resolved. The extension sends every candidate with
  // the label LinkedIn put on it; picking which of three websites is the
  // company's and turning "06 1 234 5678" into E.164 are rules, and rules that
  // live in two places drift — the copy already installed on somebody's machine
  // being the one that cannot be corrected.
  const contact = resolveContact(input);

  let companyId: string | null = null;
  if (input.companyName) {
    // The domain comes from a LINK the profile published, never from the
    // company's name. `normalizeDomain("Danubia Fogászat Kft.")` used to be
    // handed to a domain match, which is a name being asked to behave like a
    // hostname: it can only ever miss, and it made every capture create a
    // second copy of a company that was already on file.
    const domain = contact.websiteUrl ? normalizeDomain(contact.websiteUrl) : null;
    const company =
      (await db.company.findFirst({
        where: {
          OR: [
            { name: { equals: input.companyName, mode: "insensitive" } },
            ...(domain ? [{ domain }] : []),
          ],
        },
        select: { id: true, domain: true, city: true },
      })) ??
      (await db.company.create({
        data: {
          workspaceId: identity.workspaceId,
          name: input.companyName,
          domain,
          city,
        },
        select: { id: true, domain: true, city: true },
      }));
    companyId = company.id;

    // Fill blanks on a company we found, never overwrite what is already there.
    if ((domain && !company.domain) || (city && !company.city)) {
      await db.company.update({
        where: { id: company.id },
        data: {
          domain: company.domain ?? domain ?? undefined,
          city: company.city ?? city ?? undefined,
        },
      });
    }
  }

  // The capture as prose, so the research call has something to read. Delimited
  // and merged rather than assigned: anything a person typed into notes stays.
  // A capture that read nothing writes nothing — `undefined` leaves the column
  // exactly as it was rather than blanking it.
  const block = composeCapturedNotes(input, contact);
  const notes = block ? mergeCapturedNotes(existing?.notes, block) : undefined;

  const lead = existing
    ? await db.lead.update({
        where: { id: existing.id },
        data: {
          contactName: input.name ?? existing.contactName,
          /**
           * THE HEADLINE IS NOT A JOB TITLE, and this is where it used to become
           * one: `title: … ?? input.jobTitle ?? input.headline`.
           *
           * The Experience section is lazy-rendered, so `jobTitle` is absent on
           * most captures and the headline took its place. It is free prose the
           * person wrote about themselves — "VP Sales @ Metaview | Startup Advisor
           * and Investor" — and filing it as a job title makes every downstream
           * use of `title` wrong: the form's job-title input, the letterhead, the
           * merge field in an outreach draft. On /in/mgoldberger the headline was
           * itself the person's NAME, so the form showed the name in the job-title
           * slot next to an empty Name field.
           *
           * Each field now lands in its own column, and neither substitutes for
           * the other. A human's typed value is still never overwritten.
           */
          title: existing.title ?? input.jobTitle ?? undefined,
          headline: existing.headline ?? input.headline ?? undefined,
          email: existing.email ?? contact.email ?? undefined,
          phone: existing.phone ?? contact.phone ?? undefined,
          bio: input.bio ?? undefined,
          notes,
          companyId: companyId ?? undefined,
        },
        select: { id: true, contactName: true, personBrief: true },
      })
    : await db.lead.create({
        data: {
          workspaceId: identity.workspaceId,
          companyId,
          contactName: input.name ?? null,
          // Own column each; the headline is never a stand-in for the job title.
          title: input.jobTitle ?? null,
          headline: input.headline ?? null,
          email: contact.email ?? null,
          phone: contact.phone ?? null,
          linkedinUrl: input.url,
          bio: input.bio ?? null,
          notes,
          source: "LINKEDIN",
          stage: "RESEARCHED",
          signals: [],
        },
        select: { id: true, contactName: true, personBrief: true },
      });

  // Avatar: downloaded once, never hotlinked (the source URL expires and
  // rendering it would leak every card view to that CDN).
  let avatarPath: string | null = null;
  let avatarProblem: string | null = null;
  if (input.photoUrl) {
    const stored = await storeAvatar(lead.id, input.photoUrl);
    avatarPath = stored.path;
    avatarProblem = stored.reason;
    if (avatarPath) {
      await db.lead.update({ where: { id: lead.id }, data: { avatarPath } });
    }
  }

  // One Haiku call per capture, cached on the lead: a re-capture of the same
  // profile does not pay again (hard rule #3). Budget middleware and
  // ClaudeUsage logging come with callClaude.
  let brief = lead.personBrief;
  const haveText = !!(input.bio || input.posts?.length || input.headline);
  if (!brief && haveText) {
    try {
      const { data } = await callClaude({
        useCase: "person_brief",
        workspaceId: identity.workspaceId,
        system: PERSON_BRIEF_SYSTEM,
        messages: [
          {
            role: "user",
            content: buildPersonBriefMessage({
              name: input.name,
              headline: input.headline,
              bio: input.bio,
              posts: input.posts,
            }),
          },
        ],
        schema: personBriefSchema,
      });
      brief = (data as { brief: string }).brief;
      await db.lead.update({
        where: { id: lead.id },
        data: { personBrief: brief, briefAt: new Date() },
      });
    } catch {
      // A budget cap or a model hiccup must not lose the capture itself.
      brief = null;
    }
  }

  await db.activity.create({
    data: {
      workspaceId: identity.workspaceId,
      leadId: lead.id,
      type: existing ? "capture_updated" : "capture_created",
      byUserId: identity.userId,
      payload: {
        url: input.url,
        hasPhoto: !!avatarPath,
        hasBio: !!input.bio,
        // The reader's own account of itself, kept with the capture so the lead
        // can explain later why a field is empty. Costs one JSON column on an
        // activity row and saves a round trip through the operator every time
        // LinkedIn moves something.
        diagnostics: input.diagnostics ?? null,
        contactReasons: contact.reasons,
        locationReason: place.ok ? null : place.reason,
        city,
      },
    },
  });

  return json(
    {
      ok: true,
      leadId: lead.id,
      created: !existing,
      hasBrief: !!brief,
      // Reported so a photo that was read but could not be stored says so,
      // instead of silently degrading to initials.
      avatarProblem,
      // Why each contact field is empty, so the UI never shows a blank box that
      // might mean "not published" or might mean "we failed to read it".
      contactReasons: contact.reasons,
      locationReason: place.ok ? null : place.reason,
    },
    existing ? 200 : 201,
  );
}
