import { prismaUnsafe, getWorkspaceClient } from "@/lib/db";
import { suppressAddress } from "@/modules/campaigns/send";

/**
 * Public unsubscribe endpoint (spec §4.16). The token is the recipient id from
 * the footer link. One click suppresses the address across ALL campaigns in the
 * workspace instantly. No auth — the recipient owns this action.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const recipient = await prismaUnsafe.campaignRecipient.findUnique({
    where: { id: token },
    select: { workspaceId: true, email: true },
  });
  if (recipient) {
    const db = getWorkspaceClient(recipient.workspaceId);
    await suppressAddress(db, recipient.workspaceId, recipient.email, "unsubscribe");
  }
  // Always show a neutral confirmation (don't reveal whether the token existed).
  return new Response(
    `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;background:#00051D;color:#EFF1F8;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><p style="font-size:16px">You've been unsubscribed.</p><p style="color:#858CAE;font-size:13px">You won't receive further emails from us. — Venture CO Group</p></div></body>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}
