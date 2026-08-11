import { AppShell } from "@/components/app-shell";
import { QuoteBuilder } from "@/components/quote-builder";
import { DocumentChains } from "@/components/document-chains";
import { listQuoteClients, listChains } from "@/modules/documents/actions";
import { hasGrant, isOwner } from "@/lib/authz";

export const dynamic = "force-dynamic";

export default async function DocumentsPage() {
  const [clients, chains, canCreate, owner] = await Promise.all([
    listQuoteClients(),
    listChains(),
    hasGrant("documents.quote.create"),
    isOwner(),
  ]);
  return (
    <AppShell activePath="/documents">
      <QuoteBuilder clients={clients} canCreate={canCreate} isOwner={owner} />
      <DocumentChains chains={chains} isOwner={owner} />
    </AppShell>
  );
}
