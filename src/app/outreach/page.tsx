import { AppShell } from "@/components/app-shell";
import { OutreachStudio } from "@/components/outreach-studio";
import { getOutreachLead, listOutreachLeads } from "@/modules/outreach/actions";

export const dynamic = "force-dynamic";

export default async function OutreachPage({
  searchParams,
}: {
  searchParams: Promise<{ lead?: string }>;
}) {
  const { lead: leadParam } = await searchParams;
  const leads = await listOutreachLeads();
  const selectedId = leadParam ?? leads[0]?.id ?? null;
  // No AI runs here — the page only reads. Drafting is a manual button
  // (CLAUDE.md hard rule #3: no Claude calls on page load).
  const initialLead = selectedId ? await getOutreachLead(selectedId) : null;

  return (
    <AppShell activePath="/outreach">
      <OutreachStudio leads={leads} initialLead={initialLead} />
    </AppShell>
  );
}
