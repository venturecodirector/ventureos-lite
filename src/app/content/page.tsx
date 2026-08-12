import { AppShell } from "@/components/app-shell";
import { ContentHub } from "@/components/content-hub";
import { getContentBoard } from "@/modules/content/actions";

export const dynamic = "force-dynamic";

export default async function ContentPage() {
  // Reads only — drafting is a manual button (CLAUDE.md hard rule #3).
  const board = await getContentBoard();
  return (
    <AppShell activePath="/content">
      <ContentHub board={board} />
    </AppShell>
  );
}
