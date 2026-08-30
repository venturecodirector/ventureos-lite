"use server";

import { z } from "zod";
import { headers } from "next/headers";
import { prismaUnsafe } from "@/lib/db";
import { takeRateLimit } from "@/lib/rate-limit";
import { enqueueAudit } from "@/modules/audit/enqueue";
import { auditRowToView } from "@/modules/audit/view";
import { buildPriorityMatrix } from "@/modules/audit/priority";
import { CATEGORY_LABEL } from "@/modules/audit/categories";
import { DEFAULT_LOCALE, type Locale } from "@/lib/locale";
import type { AuditCheck } from "@/modules/audit/types";
import { botVerdict, MIN_FILL_MS } from "@/modules/meetings/botcheck";
import { checkUrl, judgeSubmission, ipPrefix, type RefusalReason } from "./guard";
import { resolvesToPublicAddress } from "@/lib/safe-fetch";
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

  /**
   * WHERE THE HOSTNAME ACTUALLY POINTS.
   *
   * `checkUrl` judges the host as text, which catches `localhost` and `10.0.0.1`
   * and nothing else. A domain whose A record answers 127.0.0.1 — or the cloud
   * metadata address — reads as an ordinary website, and this form is open to
   * anyone with the URL. Resolving it here means the refusal is immediate and
   * honest instead of a queued audit that fails strangely later.
   *
   * The browser has its own guard for everything after this point (redirects,
   * subresources, script-driven navigation); this one exists so the person
   * gets told, and so the worker is never woken for it at all.
   */
  if (!(await resolvesToPublicAddress(new URL(url.normalizedUrl).hostname))) {
    await prismaUnsafe.publicAudit.create({
      data: {
        workspaceId,
        url: url.normalizedUrl,
        domain: url.domain,
        status: "blocked",
        blockedReason: "not_public_host",
        ipPrefix: prefix,
        userAgent,
      },
    });
    return {
      ok: false,
      reason: "not_public_host",
      friendly: false,
      message: MESSAGES.not_public_host,
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
  id: string;
  status: string;
  /**
   * Which step the worker is on, so the landing page's progress bar tracks
   * the run instead of guessing from `status` — which only ever says
   * "running" and left the last step permanently unreachable.
   */
  stage: string | null;
  queuePosition: number;
  /** Populated once the run finishes. */
  score: number | null;
  verdict: string | null;
  url: string;
  /**
   * The teaser (P12/1b): the three findings that matter most, in the visitor's
   * language. Deliberately three — enough that the minute was worth spending,
   * few enough that the full report still has something to give.
   */
  headlineFindings: string[];
  screenshots: { desktop?: string; mobile?: string };
}

/** Polled by the landing page while the audit runs. No session required. */
export async function getPublicAuditStatus(
  publicAuditId: string,
  locale: Locale = DEFAULT_LOCALE,
): Promise<PublicAuditStatus | null> {
  const pa = await prismaUnsafe.publicAudit.findUnique({
    where: { id: publicAuditId },
    select: { id: true, url: true, status: true, auditId: true, workspaceId: true },
  });
  if (!pa) return null;

  const pending = {
    id: pa.id,
    stage: null,
    queuePosition: 0,
    score: null,
    verdict: null,
    url: pa.url,
    headlineFindings: [],
    screenshots: {},
  };
  if (!pa.auditId) return { ...pending, status: pa.status };

  const audit = await prismaUnsafe.auditResult.findUnique({ where: { id: pa.auditId } });
  if (!audit) return { ...pending, status: pa.status };

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
  const done = audit.status === "done";
  return {
    id: pa.id,
    status: audit.status,
    stage: audit.stage ?? null,
    queuePosition: ahead,
    score: done ? view.score : null,
    verdict: done ? view.verdict : null,
    url: pa.url,
    headlineFindings: done ? headlineFindings(view.checks, locale) : [],
    screenshots: done ? view.screenshots : {},
  };
}

/**
 * The three findings a visitor should read first.
 *
 * Ranked by the audit engine's own impact-then-effort ordering (P2/4), not by
 * a separate rule written for this page — so the free teaser opens with the
 * same three items as the paid report, and the two cannot drift apart.
 *
 * Labels are the check labels, which are English in the registry. The
 * Hungarian page shows the category name it belongs to alongside, which is
 * translated, so the line still reads in the visitor's language.
 */
function headlineFindings(checks: AuditCheck[], locale: Locale): string[] {
  return buildPriorityMatrix(checks)
    .ordered.slice(0, 3)
    .map((f) => {
      const category = f.category ? CATEGORY_LABEL[f.category][locale] : null;
      const detail = f.detail ? ` (${f.detail})` : "";
      return category ? `${category}: ${f.label}${detail}` : `${f.label}${detail}`;
    });
}
