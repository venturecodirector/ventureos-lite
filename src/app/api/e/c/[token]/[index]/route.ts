import { NextResponse } from "next/server";
import { messageForToken, recordTrackEvent } from "@/modules/email/track-record";
import { appLink } from "@/lib/public-links";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The click redirect (playbook-v3 P9/1).
 *
 * ── IT TAKES AN INDEX, NOT A URL ───────────────────────────────────────────
 *
 * A redirect endpoint that accepts a URL is an open redirect: a phishing link
 * wearing our own domain, which is worth more to an attacker than most bugs.
 * The links were stored at send time, so the only thing a caller can supply is
 * a position in that list. An index that is out of range goes to our own site,
 * never to something a caller named.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string; index: string }> },
): Promise<NextResponse> {
  const home = appLink("/");
  try {
    const { token, index } = await params;
    const msg = await messageForToken(token);
    if (!msg) return NextResponse.redirect(home, 302);

    const i = Number.parseInt(index, 10);
    const url = Number.isInteger(i) && i >= 0 && i < msg.links.length ? msg.links[i] : null;
    if (!url) return NextResponse.redirect(home, 302);

    // Recorded before the redirect so a click is not lost to a slow write, and
    // awaited because the response ends the request.
    await recordTrackEvent(msg, "click", url).catch(() => {});
    return NextResponse.redirect(url, 302);
  } catch {
    return NextResponse.redirect(home, 302);
  }
}
