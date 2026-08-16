"use server";

import { mkdir, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prismaUnsafe } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { requireOwner } from "@/lib/authz";
import {
  VENTURE_BRAND,
  brandFrom,
  validateBrandContrast,
  type WorkspaceBrand,
} from "./brand";

/**
 * Settings → Branding (audit-v2 item 6).
 *
 * Owner-gated and audit-logged: branding decides what every client-facing
 * artefact this workspace produces looks like and who it says it is from, which
 * makes it closer to editing a letterhead than to setting a preference.
 */

const FILES_DIR = process.env.FILES_DIR ?? "/data/files";

const hex = z.string().regex(/^#[0-9a-fA-F]{3,8}$/, "Use a hex colour like #7427C6");

const brandSchema = z.object({
  name: z.string().trim().min(1).max(80),
  legalName: z.string().trim().max(120).optional(),
  markBold: z.string().trim().max(40).optional(),
  markLight: z.string().trim().max(40).optional(),
  color: hex,
  gradientFrom: hex,
  gradientTo: hex,
  canvas: hex,
  ink: hex,
  muted: hex,
  fontDisplay: z.string().trim().max(48).optional(),
  fontBody: z.string().trim().max(48).optional(),
  footerIdentity: z.string().trim().max(160).optional(),
  footerAddress: z.string().trim().max(200).optional(),
  footerRegistration: z.string().trim().max(200).optional(),
  footerContact: z.string().trim().max(200).optional(),
  senderName: z.string().trim().max(80).optional(),
  senderEmail: z.string().trim().email().or(z.literal("")).optional(),
  slugPrefix: z.string().trim().max(24).optional(),
  publicHost: z.string().trim().max(253).or(z.literal("")).optional(),
});

export type BrandResult =
  | { ok: true; brand: WorkspaceBrand }
  | { ok: false; error: string; problems?: string[] };

export async function getWorkspaceBrand(): Promise<WorkspaceBrand> {
  const { workspaceId } = await getActiveContext();
  const ws = await prismaUnsafe.workspace.findUnique({
    where: { id: workspaceId },
    select: { brand: true },
  });
  return brandFrom(ws?.brand);
}

/** The seed, so the form can offer "restore the defaults". */
export async function getSeedBrand(): Promise<WorkspaceBrand> {
  return VENTURE_BRAND;
}

async function writeBrand(
  workspaceId: string,
  userId: string,
  next: WorkspaceBrand,
  action: string,
  meta: Record<string, unknown>,
): Promise<void> {
  await prismaUnsafe.workspace.update({
    where: { id: workspaceId },
    data: { brand: { ...next } as unknown as Prisma.InputJsonValue },
  });
  // CLAUDE.md hard rule #8 lists the actions that must be audited. Branding
  // belongs with them: it changes what every document this workspace issues
  // claims to be, and "who changed the letterhead" is a question that gets
  // asked exactly once, after something has gone out wrong.
  await prismaUnsafe.auditLog.create({
    data: { workspaceId, actorUserId: userId, action, entityType: "Workspace", entityId: workspaceId, meta: meta as Prisma.InputJsonValue },
  });
  revalidatePath("/settings");
  revalidatePath("/documents");
}

export async function saveWorkspaceBrand(raw: unknown): Promise<BrandResult> {
  const parsed = brandSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the fields." };
  }
  try {
    await requireOwner();
  } catch {
    return { ok: false, error: "Only an Owner can change the branding." };
  }

  const { workspaceId, userId } = await getActiveContext();
  const current = await getWorkspaceBrand();
  // Re-read through brandFrom so what is stored is exactly what will be read
  // back: sanitised fonts, validated colours, a bare public host.
  const next = brandFrom({
    ...current,
    ...parsed.data,
    // The logo is managed by its own action; a form submit must not clear it.
    logoUrl: current.logoUrl,
    logoPath: current.logoPath,
    senderEmail: parsed.data.senderEmail || null,
    publicHost: parsed.data.publicHost || null,
  });

  // The gate: a workspace cannot save a palette its own output would be
  // unreadable in. Checked here rather than at render for the obvious reason —
  // discovering it from a client's emailed report is too late.
  const contrast = validateBrandContrast(next);
  if (!contrast.ok) {
    return {
      ok: false,
      error: "That palette would produce output nobody can read.",
      problems: contrast.problems,
    };
  }

  await writeBrand(workspaceId, userId, next, "workspace.brand.updated", {
    name: next.name,
    colors: { canvas: next.canvas, ink: next.ink, accent: next.color },
  });
  return { ok: true, brand: next };
}

const MAX_LOGO_BYTES = 512 * 1024;
const ALLOWED = new Map([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/svg+xml", ".svg"],
  ["image/webp", ".webp"],
]);

/**
 * Upload a logo.
 *
 * Stored under FILES_DIR like every other artefact so it is covered by the
 * existing backup, and served through the public brand-logo route rather than
 * the authenticated file route — it has to render on pages a prospect opens
 * with no session.
 */
export async function uploadBrandLogo(form: FormData): Promise<BrandResult> {
  try {
    await requireOwner();
  } catch {
    return { ok: false, error: "Only an Owner can change the branding." };
  }

  const file = form.get("logo");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "Pick an image file." };
  }
  const ext = ALLOWED.get(file.type);
  if (!ext) return { ok: false, error: "Use a PNG, JPEG, SVG or WebP." };
  if (file.size > MAX_LOGO_BYTES) {
    return { ok: false, error: "Keep the logo under 512 KB — it is embedded in every PDF." };
  }

  const { workspaceId, userId } = await getActiveContext();
  const current = await getWorkspaceBrand();

  const rel = `brand/${workspaceId}-${randomUUID()}${ext}`;
  const abs = join(FILES_DIR, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, Buffer.from(await file.arrayBuffer()));

  // The URL carries the file's own id, so it is immutable and cache-bustable
  // in one move: a replaced logo gets a new URL rather than a stale cache.
  const next: WorkspaceBrand = {
    ...current,
    logoPath: rel,
    logoUrl: `/api/brand-logo/${workspaceId}?v=${rel.slice(rel.lastIndexOf("-") + 1)}`,
  };
  await writeBrand(workspaceId, userId, next, "workspace.brand.logo", { path: rel, bytes: file.size });

  // Best effort: the old file is nobody's now.
  if (current.logoPath) {
    await unlink(join(FILES_DIR, current.logoPath)).catch(() => {});
  }
  return { ok: true, brand: next };
}

export async function removeBrandLogo(): Promise<BrandResult> {
  try {
    await requireOwner();
  } catch {
    return { ok: false, error: "Only an Owner can change the branding." };
  }
  const { workspaceId, userId } = await getActiveContext();
  const current = await getWorkspaceBrand();
  const next: WorkspaceBrand = { ...current, logoPath: null, logoUrl: null };
  await writeBrand(workspaceId, userId, next, "workspace.brand.logo", { removed: true });
  if (current.logoPath) {
    await unlink(join(FILES_DIR, current.logoPath)).catch(() => {});
  }
  return { ok: true, brand: next };
}

/** Back to the seed, logo included. */
export async function resetWorkspaceBrand(): Promise<BrandResult> {
  try {
    await requireOwner();
  } catch {
    return { ok: false, error: "Only an Owner can change the branding." };
  }
  const { workspaceId, userId } = await getActiveContext();
  const current = await getWorkspaceBrand();
  await writeBrand(workspaceId, userId, VENTURE_BRAND, "workspace.brand.updated", {
    reset: true,
  });
  if (current.logoPath) {
    await unlink(join(FILES_DIR, current.logoPath)).catch(() => {});
  }
  return { ok: true, brand: VENTURE_BRAND };
}
