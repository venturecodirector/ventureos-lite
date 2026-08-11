import { AppShell } from "@/components/app-shell";
import { Prospector } from "@/components/prospector";
import { getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import type { SavedSearch } from "@/modules/prospector/types";

export const dynamic = "force-dynamic";

export default async function ProspectorPage() {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const rows = await db.prospectSearch.findMany({
    orderBy: { ranAt: "desc" },
    take: 20,
    select: { id: true, keywords: true, location: true },
  });

  const seen = new Set<string>();
  const saved: SavedSearch[] = [];
  for (const r of rows) {
    const key = `${r.keywords.toLowerCase()}|${r.location.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    saved.push({ id: r.id, keyword: r.keywords, location: r.location });
  }

  return (
    <AppShell activePath="/prospector">
      <Prospector saved={saved} />
    </AppShell>
  );
}
