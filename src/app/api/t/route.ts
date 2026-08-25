import { NextResponse } from "next/server";
import { takeRateLimit } from "@/lib/rate-limit";
import { ipPrefix } from "@/modules/public-audit/guard";
import { isPageType, resolvePageTarget } from "@/modules/tracking/resolve";
import { recordVisit } from "@/modules/tracking/record";
import { enqueueVisitEnrichment } from "@/modules/tracking/enqueue";
import type { TrackBeacon } from "@/modules/tracking/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The measurement beacon (playbook-v3 P8/a).
 *
 * ── IT ALWAYS ANSWERS 204 ───────────────────────────────────────────────────
 *
 * A bad slug, a malformed body, a rate limit, a database that is down: the
 * visitor is reading a quote, and nothing that happens here is their problem.
 * A 4xx would also make the endpoint a probe for which slugs exist, so silence
 * is both the kinder and the safer answer.
 *
 * Rate limited per address because it is a public write endpoint: one page's
 * heartbeat is four requests a minute, so the ceiling is far above honest use
 * and far below anything that could fill a table.
 */
const MAX_BODY = 8_000;
const PER_HOUR = 240;

function noContent(): NextResponse {
  return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request): Promise<NextResponse> {
  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY) return noContent();

    let body: TrackBeacon;
    try {
      body = JSON.parse(raw) as TrackBeacon;
    } catch {
      return noContent();
    }
    if (!body || typeof body.t !== "string" || !body.t) return noContent();
    if (typeof body.p !== "string" || typeof body.s !== "string") return noContent();
    if (!isPageType(body.p)) return noContent();
    if (body.t.length > 64 || body.s.length > 200) return noContent();

    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      req.headers.get("x-real-ip") ||
      null;

    const rate = await takeRateLimit(`track:${ipPrefix(ip) ?? "unknown"}`, {
      windowMs: 60 * 60 * 1000,
      max: PER_HOUR,
    });
    if (!rate.allowed) return noContent();

    const target = await resolvePageTarget(body.p, body.s);
    if (!target) return noContent();

    const visitId = await recordVisit({
      pageType: body.p,
      slug: body.s,
      target,
      beacon: body,
      ip,
      ipSalt: process.env.NEXTAUTH_SECRET ?? "venture-os",
    });

    // Identification is the worker's job — the visitor waits for nothing.
    if (visitId) await enqueueVisitEnrichment(visitId, target.workspaceId);

    return noContent();
  } catch {
    // Measurement must never surface as an error on a prospect's screen.
    return noContent();
  }
}
