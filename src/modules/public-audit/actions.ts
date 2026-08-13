"use server";

import { z } from "zod";
import { headers } from "next/headers";
import { prismaUnsafe } from "@/lib/db";
import { takeRateLimit } from "@/lib/rate-limit";
import { enqueueAudit } from "@/modules/audit/enqueue";
import { auditRowToView } from "@/modules/audit/view";
import { botVerdict, MIN_FILL_MS } from "@/modules/meetings/botcheck";
import { checkUrl, judgeSubmission, ipPrefix, type RefusalReason } from "./guard";
import { getPublicIntakeWorkspaceId, ownDomains, clientDomains, PublicIntakeUnavailable } from "./intake";

/**
 * Public, unauthenticated entry point for the self-serve audit (P12/1a).
 *
 * This is the only place in the product where an anonymous visitor can queue
 * worker jobs, so the playbook's rule — a public form must not be able to DoS
 * our own worker — is enforced here in one place, before anything is written.
 */

/** Free audits per IP per day. */
const DAILY_PER_IP = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Public audits allowed to be queued or running at once, across all visitors. */
const MAX_IN_FLIGHT = 3;
/** Cache window: re-auditing the same site within this returns the same run. */
const REUSE_MS = 30 * 60 * 1000;

const submitSchema = z.object({
  url: z.string().min(1).max(500),
  /** Honeypot — must stay empty; bots fill every field they find. */
  website: z.string().max(200).optional(),
  /** Milliseconds the form was on screen; instant submits are not people. */
  elapsedMs: z.coerce.number().int().min(0).max(3_600_000).default(0),
});

export interface PublicAuditQueued {
  ok: true;
  publicAuditId: string;
  /** 0 = running now; higher means waiting behind others. */
  queuePosition: number;
}

export interface PublicAuditRefused {
  ok: false;
  reason: RefusalReason | "unavailable";
  /** Warm rather than an error — an existing client or ourselves. */
  friendly: boolean;
  message: string;
}

const MESSAGES: Record<RefusalReason | "unavailable", string> = {
  invalid_url: "Ezt a címet nem sikerült értelmezni. Próbáld így: pelda.hu",
  not_public_host: "Csak nyilvánosan elérhető weboldalt tudunk átvilágítani.",
  own_domain: "Ez a mi oldalunk — de köszönjük a kíváncsiságot.",
  client_domain: "Ügyfelünk vagy — szólj, és nézzük meg együtt, élőben.",
  bot: "Valami nem stimmelt az űrlappal. Töltsd ki újra.",
  rate_limited: "Mára elfogyott a napi 3 ingyenes átvilágítás erről a hálózatról. Holnap újra.",
  at_capacity: "Most sokan használják — próbáld újra pár perc múlva.",
  unavailable: "Az átvilágítás átmenetileg nem elérhető. Írj nekünk.",
};

export async function submitPublicAudit(
  raw: unknown,
): Promise<PublicAuditQueued | PublicAuditRefused> {
  const parsed = submitSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid_url", friendly: false, message: MESSAGES.invalid_url };
  }

  const url = checkUrl(parsed.data.url);
  if (!url.ok || !url.domain || !url.normalizedUrl) {
    const reason = url.reason ?? "invalid_url";
    return { ok: false, reason, friendly: false, message: MESSAGES[reason] };
  }

  let workspaceId: string;
  try {
    workspaceId = await getPublicIntakeWorkspaceId();
  } catch (e) {
    if (e instanceof PublicIntakeUnavailable) {
      // eslint-disable-next-line no-console
      console.error("[public-audit] intake unavailable:", e.message);
      return { ok: false, reason: "unavailable", friendly: false, message: MESSAGES.unavailable };
    }
    throw e;
  }

  const h = await headers();
  const ip = h.get("x-forwarded-for") ?? h.get("x-real-ip");
  const prefix = ipPrefix(ip);
  const userAgent = h.get("user-agent")?.slice(0, 300) ?? null;

  const bot = botVerdict({
    honeypot: parsed.data.website ?? "",
    elapsedMs: parsed.data.elapsedMs,
    minElapsedMs: MIN_FILL_MS,
  });

  // Rate limit is consumed only for submissions that are otherwise plausible,
  // so a bot cannot burn a real visitor's allowance from the same network.
  const [clients, inFlight] = await Promise.all([
    clientDomains(workspaceId),
    prismaUnsafe.publicAudit.count({
      where: { workspaceId, status: { in: ["queued", "running"] } },
    }),
  ]);

  const rate = bot.ok
    ? await takeRateLimit(`public-audit:${prefix ?? "unknown"}`, {
        windowMs: DAY_MS,
        max: DAILY_PER_IP,
      })
    : { allowed: true, count: 0, remaining: DAILY_PER_IP, resetAtMs: 0 };

  const verdict = judgeSubmission({
    domain: url.domain,
    ownDomains: ownDomains(),
    clientDomains: clients,
    looksHuman: bot.ok,
    withinRateLimit: rate.allowed,
    inFlight,
    maxInFlight: MAX_IN_FLIGHT,
  });

  if (!verdict.accept) {
    // Recorded even when refused: the funnel and any abuse pattern are only
    // visible if refusals are counted too.
    await prismaUnsafe.publicAudit.create({
      data: {
        workspaceId,
        url: url.normalizedUrl,
        domain: url.domain,
        status: "blocked",
        blockedReason: verdict.reason,
        ipPrefix: prefix,
        userAgent,
      },
    });
    return {
      ok: false,
      reason: verdict.reason,
      friendly: verdict.friendly,
      message: MESSAGES[verdict.reason],
    };
  }

  // Reuse a recent run of the same site rather than paying for it twice.
  const recent = await prismaUnsafe.auditResult.findFirst({
    where: {
      workspaceId,
      url: url.normalizedUrl,
      status: { in: ["queued", "running", "done"] },
      createdAt: { gte: new Date(Date.now() - REUSE_MS) },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });

  let auditId = recent?.id ?? null;
  if (!auditId) {
    const created = await prismaUnsafe.auditResult.create({
      data: {
        workspaceId,
        url: url.normalizedUrl,
        status: "queued",
        score: 0,
        verdict: "SKIP",
        flags: [],
        screenshots: {},
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });
    auditId = created.id;
    await enqueueAudit({
      auditId,
      workspaceId,
      url: url.normalizedUrl,
      // No pitch: that is a Claude call, and this is an anonymous visitor
      // (hard rule #3 — no unbudgeted AI on a public path).
      withPitch: false,
    });
  }

  const publicAudit = await prismaUnsafe.publicAudit.create({
    data: {
      workspaceId,
      url: url.normalizedUrl,
      domain: url.domain,
      auditId,
      status: recent ? "running" : "queued",
      ipPrefix: prefix,
      userAgent,
    },
  });

  return { ok: true, publicAuditId: publicAudit.id, queuePosition: Math.max(0, inFlight) };
}

export interface PublicAuditStatus {
  status: string;
  queuePosition: number;
  /** Populated once the run finishes; the teaser split lands in P12/1b. */
  score: number | null;
  verdict: string | null;
  url: string;
}

/** Polled by the landing page while the audit runs. No session required. */
export async function getPublicAuditStatus(publicAuditId: string): Promise<PublicAuditStatus | null> {
  const pa = await prismaUnsafe.publicAudit.findUnique({
    where: { id: publicAuditId },
    select: { id: true, url: true, status: true, auditId: true, workspaceId: true },
  });
  if (!pa) return null;

  if (!pa.auditId) {
    return { status: pa.status, queuePosition: 0, score: null, verdict: null, url: pa.url };
  }

  const audit = await prismaUnsafe.auditResult.findUnique({ where: { id: pa.auditId } });
  if (!audit) return { status: pa.status, queuePosition: 0, score: null, verdict: null, url: pa.url };

  // Keep the public row in step with the underlying audit.
  if (audit.status !== pa.status) {
    await prismaUnsafe.publicAudit.update({
      where: { id: pa.id },
      data: { status: audit.status },
    });
  }

  const ahead =
    audit.status === "queued"
      ? await prismaUnsafe.publicAudit.count({
          where: {
            workspaceId: pa.workspaceId,
            status: "queued",
            createdAt: { lt: (await prismaUnsafe.publicAudit.findUnique({
              where: { id: pa.id },
              select: { createdAt: true },
            }))!.createdAt },
          },
        })
      : 0;

  const view = auditRowToView(audit);
  return {
    status: audit.status,
    queuePosition: ahead,
    score: audit.status === "done" ? view.score : null,
    verdict: audit.status === "done" ? view.verdict : null,
    url: pa.url,
  };
}
