import { createReadStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import { join } from "node:path";
import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { parseLogLine } from "./parse";
import { LogAccumulator, botFromUserAgent } from "./analyze";
import { BotVerifier } from "./bots";

const FILES_DIR = process.env.FILES_DIR ?? "/data/files";

/** How long a raw upload may exist. Personal data: the clock is the point. */
export const RAW_RETENTION_DAYS = 7;

export interface LogJobData {
  uploadId: string;
  workspaceId: string;
}

/**
 * Parse an uploaded access log and keep only the aggregate (P2/8).
 *
 * STREAMED, line at a time, through gunzip when needed: a client's month of
 * traffic is gigabytes, and the point of the accumulator is that none of it
 * has to be held. The raw file is deleted as soon as the aggregate is stored —
 * the 7-day sweep exists for the case where this path never completes, not as
 * the normal route.
 */
export async function processLogUpload(data: LogJobData): Promise<void> {
  const db = getWorkspaceClient(data.workspaceId);
  const upload = await db.logUpload.findUnique({ where: { id: data.uploadId } });
  if (!upload?.rawPath) return;

  const absolute = join(FILES_DIR, upload.rawPath);
  await db.logUpload.update({ where: { id: upload.id }, data: { status: "running" } });

  try {
    const acc = new LogAccumulator();
    const verifier = new BotVerifier();

    const raw = createReadStream(absolute);
    const stream = upload.filename.endsWith(".gz") ? raw.pipe(createGunzip()) : raw;
    const lines = createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of lines) {
      if (!line.trim()) continue;
      const entry = parseLogLine(line);
      if (!entry) {
        acc.skip();
        continue;
      }
      // Verify the claim before counting it: "Googlebot" in a user agent is a
      // string anyone can type, and a client acting on a fake crawl figure
      // would be acting on our mistake.
      const claimed = botFromUserAgent(entry.userAgent);
      const verifiedBot = claimed && claimed !== "other" ? await verifier.verify(entry.ip, claimed) : false;
      acc.add(entry, { verifiedBot });
    }

    await db.logUpload.update({
      where: { id: upload.id },
      data: { status: "done", analysis: acc.finish() as unknown as object },
    });
  } catch (e) {
    await db.logUpload.update({
      where: { id: upload.id },
      data: { status: "error", error: (e as Error).message.slice(0, 500) },
    });
  } finally {
    // Whatever happened above, the personal data goes. A failed parse is not a
    // reason to keep a file full of IP addresses lying around for a week.
    await unlink(absolute).catch(() => {});
    await db.logUpload.update({
      where: { id: upload.id },
      data: { rawPath: null, purgedAt: new Date() },
    });
  }
}

/**
 * Daily sweep: delete any raw upload past its retention date (P2/8).
 *
 * The processor already deletes the file it handled. This is the backstop for
 * an upload whose job never ran — a worker restart, a queue loss — because
 * "we meant to delete it" is not a GDPR position.
 */
export async function processLogRetention(now: Date = new Date()): Promise<number> {
  const stale = await prismaUnsafe.logUpload.findMany({
    where: { rawPath: { not: null }, purgeAfter: { lte: now } },
    select: { id: true, workspaceId: true, rawPath: true },
    take: 500,
  });

  let purged = 0;
  for (const row of stale) {
    if (row.rawPath) await unlink(join(FILES_DIR, row.rawPath)).catch(() => {});
    await prismaUnsafe.logUpload.update({
      where: { id: row.id },
      data: { rawPath: null, purgedAt: now },
    });
    purged += 1;
  }
  return purged;
}
