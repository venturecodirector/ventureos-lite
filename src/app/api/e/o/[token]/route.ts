import { NextResponse } from "next/server";
import { messageForToken, recordTrackEvent } from "@/modules/email/track-record";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The open pixel (playbook-v3 P9/1).
 *
 * ALWAYS answers with the image, whatever happened — an unknown token, a dead
 * database, a message that was erased. The recipient is reading their mail and
 * a broken-image icon in the middle of a quote is our problem leaking into
 * their inbox.
 */
const PIXEL = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);

function pixel(): NextResponse {
  return new NextResponse(PIXEL, {
    status: 200,
    headers: {
      "Content-Type": "image/gif",
      "Content-Length": String(PIXEL.length),
      // Never cached: a cached pixel is an open that only ever counts once,
      // and proxies would happily serve it for a week.
      "Cache-Control": "no-store, no-cache, must-revalidate, private",
      Pragma: "no-cache",
    },
  });
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  try {
    const { token } = await params;
    const msg = await messageForToken(token.replace(/\.(png|gif)$/i, ""));
    if (msg) await recordTrackEvent(msg, "open");
  } catch {
    /* the image goes out regardless */
  }
  return pixel();
}
