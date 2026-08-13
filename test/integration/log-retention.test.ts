import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

/**
 * P2/8 — GDPR retention.
 *
 * Log lines are IP addresses, which are personal data. The promise is that the
 * raw upload is gone within seven days, so this test writes real files, runs
 * the real sweep, and checks the filesystem — a mocked unlink would prove
 * nothing about the promise.
 */
const FILES_DIR = join(tmpdir(), `venture-logs-${randomUUID()}`);
process.env.FILES_DIR = FILES_DIR;

const { prismaUnsafe } = await import("@/lib/db");
const { processLogRetention, RAW_RETENTION_DAYS } = await import("@/modules/logs/jobs");

const created: string[] = [];
let workspaceId = "";

async function exists(rel: string): Promise<boolean> {
  try {
    await access(join(FILES_DIR, rel));
    return true;
  } catch {
    return false;
  }
}

async function seedUpload(rel: string, purgeAfter: Date): Promise<string> {
  await mkdir(join(FILES_DIR, "logs"), { recursive: true });
  await writeFile(join(FILES_DIR, rel), "1.2.3.4 - - [10/Oct/2026:13:55:36 +0200] ...\n");
  const row = await prismaUnsafe.logUpload.create({
    data: {
      workspaceId,
      filename: "access.log",
      bytes: 42,
      status: "done",
      rawPath: rel,
      purgeAfter,
    },
  });
  created.push(row.id);
  return row.id;
}

beforeAll(async () => {
  const ws = await prismaUnsafe.workspace.findFirst({ select: { id: true } });
  workspaceId = ws!.id;
});

afterAll(async () => {
  await prismaUnsafe.logUpload.deleteMany({ where: { id: { in: created } } });
  await prismaUnsafe.$disconnect();
});

describe("raw log retention", () => {
  it("deletes an upload past its window, from disk and from the row", async () => {
    const rel = join("logs", `${randomUUID()}-old.log`);
    const id = await seedUpload(rel, new Date(Date.now() - 86_400_000));
    expect(await exists(rel)).toBe(true);

    const purged = await processLogRetention();
    expect(purged).toBeGreaterThanOrEqual(1);

    expect(await exists(rel)).toBe(false);
    const row = await prismaUnsafe.logUpload.findUnique({ where: { id } });
    expect(row!.rawPath).toBeNull();
    expect(row!.purgedAt).not.toBeNull();
  });

  it("leaves an upload still inside its window alone", async () => {
    const rel = join("logs", `${randomUUID()}-fresh.log`);
    const id = await seedUpload(rel, new Date(Date.now() + 86_400_000));

    await processLogRetention();

    expect(await exists(rel)).toBe(true);
    const row = await prismaUnsafe.logUpload.findUnique({ where: { id } });
    expect(row!.rawPath).toBe(rel);
  });

  it("still clears the row when the file is already gone", async () => {
    const rel = join("logs", `${randomUUID()}-missing.log`);
    const id = await seedUpload(rel, new Date(Date.now() - 86_400_000));
    // Simulate the processor having deleted it without updating the row.
    const { unlink } = await import("node:fs/promises");
    await unlink(join(FILES_DIR, rel));

    await processLogRetention();

    const row = await prismaUnsafe.logUpload.findUnique({ where: { id } });
    expect(row!.rawPath).toBeNull();
  });

  it("keeps the retention window at seven days", () => {
    expect(RAW_RETENTION_DAYS).toBe(7);
  });
});
