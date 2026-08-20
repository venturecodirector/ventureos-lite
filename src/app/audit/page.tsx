import { AppShell } from "@/components/app-shell";
import { AuditRunner } from "@/components/audit-runner";

export const dynamic = "force-dynamic";

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ url?: string; run?: string }>;
}) {
  const sp = await searchParams;
  return (
    <AppShell activePath="/audit">
      <AuditRunner initialUrl={sp.url ?? ""} autoRun={sp.run === "1"} />
    </AppShell>
  );
}
