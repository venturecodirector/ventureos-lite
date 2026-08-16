import { AppShell } from "@/components/app-shell";
import { QuoteBuilder } from "@/components/quote-builder";
import { DocumentChains } from "@/components/document-chains";
import { listQuoteClients, listChains } from "@/modules/documents/actions";
import { hasGrant, isOwner } from "@/lib/authz";
import { getActiveContext } from "@/lib/session";
import { prismaUnsafe } from "@/lib/db";
import { brandFrom } from "@/modules/workspaces/brand";

export const dynamic = "force-dynamic";

export default async function DocumentsPage() {
  const { workspaceId } = await getActiveContext();
  const [clients, chains, canCreate, owner, ws] = await Promise.all([
    listQuoteClients(),
    listChains(),
    hasGrant("documents.quote.create"),
    isOwner(),
    // The preview has to show the same letterhead the PDF will (item 6).
    prismaUnsafe.workspace.findUnique({ where: { id: workspaceId }, select: { brand: true } }),
  ]);
  const brand = brandFrom(ws?.brand);
  return (
    <AppShell activePath="/documents">
      <QuoteBuilder clients={clients} canCreate={canCreate} isOwner={owner} brand={brand} />
      <DocumentChains chains={chains} isOwner={owner} />
    </AppShell>
  );
}
