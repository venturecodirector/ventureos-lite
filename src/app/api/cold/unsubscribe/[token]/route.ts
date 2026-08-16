import { prismaUnsafe, getWorkspaceClient } from "@/lib/db";
import { suppressAddress } from "@/modules/campaigns/send";
import { VENTURE_BRAND, brandFontStack, brandFrom } from "@/modules/workspaces/brand";
import { escapeHtml } from "@/modules/mail/layout";

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
  let brand = VENTURE_BRAND;
  if (recipient) {
    const db = getWorkspaceClient(recipient.workspaceId);
    await suppressAddress(db, recipient.workspaceId, recipient.email, "unsubscribe");
    const ws = await prismaUnsafe.workspace.findUnique({
      where: { id: recipient.workspaceId },
      select: { brand: true },
    });
    brand = brandFrom(ws?.brand);
  }

  // The COPY is identical either way, so a guessed token still learns nothing
  // from the words. The styling now differs, which is a deliberate trade: a
  // recipient unsubscribing from a second workspace's campaign has to see who
  // they just unsubscribed from, and that matters more than denying a brute
  // forcer the knowledge that a random cuid happened to exist (audit-v2 item 6).
  return new Response(
    `<!doctype html><meta charset="utf-8"><body style="font-family:${brandFontStack(brand.fontBody)};background:${brand.canvas};color:${brand.ink};display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><p style="font-size:16px">You've been unsubscribed.</p><p style="color:${brand.muted};font-size:13px">You won't receive further emails from us. — ${escapeHtml(brand.name)}</p></div></body>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}
