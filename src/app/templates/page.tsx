import { AppShell } from "@/components/app-shell";
import { TemplateEditor } from "@/components/template-editor";
import { canEditTemplates, loadTemplate } from "@/modules/templates/actions";

export const dynamic = "force-dynamic";

export default async function TemplatesPage() {
  const canEdit = await canEditTemplates();
  const initial = await loadTemplate("QUOTE", "HU");
  return (
    <AppShell activePath="/templates">
      <TemplateEditor initial={initial} canEdit={canEdit} />
    </AppShell>
  );
}
