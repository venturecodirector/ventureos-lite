import { AppShell } from "@/components/app-shell";
import { PublicPages } from "@/components/public-pages";
import { getPublicPages } from "@/modules/public-pages/actions";
import { isOwner } from "@/lib/authz";

export const dynamic = "force-dynamic";

export default async function PublicPagesScreen() {
  const [data, owner] = await Promise.all([getPublicPages(), isOwner()]);
  return (
    <AppShell activePath="/public-pages">
      <PublicPages data={data} isOwner={owner} />
    </AppShell>
  );
}
