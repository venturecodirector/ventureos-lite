import { AppShell } from "@/components/app-shell";
import { Projects } from "@/components/projects";
import { getProjectBoard } from "@/modules/projects/actions";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  const board = await getProjectBoard();
  return (
    <AppShell activePath="/projects">
      <Projects board={board} />
    </AppShell>
  );
}
