"use server";

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { logsQueue } from "@/lib/queue";
import { RAW_RETENTION_DAYS } from "./jobs";
import type { LogAnalysis } from "./analyze";

const FILES_DIR = process.env.FILES_DIR ?? "/data/files";

/** 200 MB. A gzipped month of a small-business site is far under this. */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

export interface LogUploadView {
  id: string;
  filename: string;
  bytes: number;
  status: string;
  error: string | null;
  createdAt: string;
  /** True once the raw file is gone — which is the state we want it in. */
  purged: boolean;
  purgeAfter: string;
  analysis: LogAnalysis | null;
  companyId: string | null;
}

function toView(row: {
  id: string;
  filename: string;
  bytes: number;
  status: string;
  error: string | null;
  createdAt: Date;
  rawPath: string | null;
  purgeAfter: Date;
  analysis: unknown;
  companyId: string | null;
}): LogUploadView {
  return {
    id: row.id,
    filename: row.filename,
    bytes: row.bytes,
    status: row.status,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    purged: row.rawPath === null,
    purgeAfter: row.purgeAfter.toISOString(),
    analysis:
      row.analysis && typeof row.analysis === "object"
        ? (row.analysis as LogAnalysis)
        : null,
    companyId: row.companyId,
  };
}

/**
 * Accept an access log for analysis (P2/8).
 *
 * The file lands on the volume only long enough for the worker to stream it.
 * Its deletion deadline is stamped at upload time rather than computed later,
 * so a retention question has an answer on the row itself.
 */
export async function uploadAccessLog(form: FormData): Promise<{ uploadId: string }> {
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const file = form.get("file");
  if (!(file instanceof File)) throw new Error("No file received.");
  if (file.size === 0) throw new Error("That file is empty.");
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `That file is ${Math.round(file.size / 1024 / 1024)} MB — the limit is ${
        MAX_UPLOAD_BYTES / 1024 / 1024
      } MB.`,
    );
  }
  const companyIdRaw = form.get("companyId");
  const companyId = typeof companyIdRaw === "string" && companyIdRaw ? companyIdRaw : null;

  // A client-supplied name never becomes a path.
  const safeName = file.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(-120) || "access.log";
  const rel = join("logs", `${randomUUID()}-${safeName}`);
  await mkdir(join(FILES_DIR, "logs"), { recursive: true });
  await writeFile(join(FILES_DIR, rel), Buffer.from(await file.arrayBuffer()));

  const row = await db.logUpload.create({
    data: {
      workspaceId,
      companyId,
      filename: safeName,
      bytes: file.size,
      status: "queued",
      rawPath: rel,
      purgeAfter: new Date(Date.now() + RAW_RETENTION_DAYS * 86_400_000),
      uploadedBy: userId,
    },
  });

  await logsQueue().add(
    "log-upload",
    { uploadId: row.id, workspaceId },
    { jobId: `log-${row.id}`, removeOnComplete: true, removeOnFail: 50 },
  );
  return { uploadId: row.id };
}

export async function listLogUploads(companyId?: string): Promise<LogUploadView[]> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const rows = await db.logUpload.findMany({
    where: companyId ? { companyId } : {},
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return rows.map(toView);
}

export async function getLogUpload(uploadId: string): Promise<LogUploadView | null> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const row = await db.logUpload.findUnique({ where: { id: uploadId } });
  return row ? toView(row) : null;
}

export async function deleteLogUpload(uploadId: string): Promise<{ ok: true }> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  await db.logUpload.deleteMany({ where: { id: uploadId } });
  return { ok: true };
}
