import { z } from "zod";
import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { takeRateLimit } from "@/lib/rate-limit";
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
  const rate = await takeRateLimit(`capture:${identity.tokenId}`, {
    windowMs: 60 * 60 * 1000,
    max: 120,
  });
  if (!rate.allowed) return json({ error: "rate_limited" }, 429);

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
    select: { id: true, contactName: true, bio: true, personBrief: true, title: true, email: true, phone: true },
  });

  let companyId: string | null = null;
  if (input.companyName) {
    const domain = normalizeDomain(input.companyName);
    const company =
      (await db.company.findFirst({
        where: domain ? { OR: [{ name: input.companyName }, { domain }] } : { name: input.companyName },
        select: { id: true },
      })) ??
      (await db.company.create({
        data: { workspaceId: identity.workspaceId, name: input.companyName, city: input.location ?? null },
        select: { id: true },
      }));
    companyId = company.id;
  }

  const lead = existing
    ? await db.lead.update({
        where: { id: existing.id },
        data: {
          contactName: input.name ?? existing.contactName,
          // A real role beats the headline, which is often a slogan. Never
          // overwrite something a human already typed here.
          title: existing.title ?? input.jobTitle ?? input.headline ?? undefined,
          email: existing.email ?? input.email ?? undefined,
          phone: existing.phone ?? input.phone ?? undefined,
          bio: input.bio ?? undefined,
          companyId: companyId ?? undefined,
        },
        select: { id: true, contactName: true, personBrief: true },
      })
    : await db.lead.create({
        data: {
          workspaceId: identity.workspaceId,
          companyId,
          contactName: input.name ?? null,
          title: input.jobTitle ?? input.headline ?? null,
          email: input.email ?? null,
          phone: input.phone ?? null,
          linkedinUrl: input.url,
          bio: input.bio ?? null,
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
      payload: { url: input.url, hasPhoto: !!avatarPath, hasBio: !!input.bio },
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
    },
    existing ? 200 : 201,
  );
}
