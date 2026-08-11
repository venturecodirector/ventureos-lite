"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import type { TemplateType, Lang } from "@prisma/client";
import { getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { requireGrant, hasGrant } from "@/lib/authz";
import { extractVariables } from "./render";

export interface TemplateVersionMeta {
  id: string;
  version: number;
  status: string;
  createdAt: string;
}

export interface TemplateEditorData {
  type: TemplateType;
  lang: Lang;
  id: string | null;
  name: string;
  body: string;
  version: number;
  versions: TemplateVersionMeta[];
}

export async function canEditTemplates(): Promise<boolean> {
  return hasGrant("templates.edit");
}

export async function loadTemplate(
  type: TemplateType,
  lang: Lang,
): Promise<TemplateEditorData> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const versions = await db.template.findMany({
    where: { type, lang },
    orderBy: { version: "desc" },
  });
  const active = versions.find((v) => v.status === "ACTIVE") ?? versions[0] ?? null;
  return {
    type,
    lang,
    id: active?.id ?? null,
    name: active?.name ?? `${type} (${lang})`,
    body: active?.body ?? "",
    version: active?.version ?? 0,
    versions: versions.map((v) => ({
      id: v.id,
      version: v.version,
      status: v.status,
      createdAt: v.createdAt.toISOString(),
    })),
  };
}

const saveSchema = z.object({
  type: z.enum(["QUOTE", "CONTRACT", "CERTIFICATE", "EMAIL"]),
  lang: z.enum(["HU", "EN"]),
  name: z.string().min(1),
  body: z.string(),
});

/** Editing creates a new version — old versions stay immutable so pinned
 * documents re-render identically (spec §4.10). */
export async function saveTemplateVersion(
  raw: unknown,
): Promise<{ id: string; version: number }> {
  const input = saveSchema.parse(raw);
  await requireGrant("templates.edit");
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const latest = await db.template.findFirst({
    where: { type: input.type, lang: input.lang },
    orderBy: { version: "desc" },
    select: { version: true },
  });
  const version = (latest?.version ?? 0) + 1;

  const t = await db.template.create({
    data: {
      workspaceId,
      type: input.type,
      lang: input.lang,
      name: input.name,
      body: input.body,
      variables: extractVariables(input.body),
      version,
      status: "DRAFT",
    },
  });
  revalidatePath("/templates");
  return { id: t.id, version };
}

export async function activateVersion(id: string): Promise<{ ok: true }> {
  await requireGrant("templates.edit");
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const t = await db.template.findUnique({
    where: { id },
    select: { type: true, lang: true },
  });
  if (!t) throw new Error("Template not found");

  await db.template.updateMany({
    where: { type: t.type, lang: t.lang, status: "ACTIVE" },
    data: { status: "ARCHIVED" },
  });
  await db.template.update({ where: { id }, data: { status: "ACTIVE" } });
  revalidatePath("/templates");
  return { ok: true };
}
