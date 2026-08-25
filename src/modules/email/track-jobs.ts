import { prismaUnsafe } from "@/lib/db";
import { TRACK_RETENTION_DAYS } from "./tracking";

/** Delete open/click feedback past its retention. See the constant's comment. */
export async function processEmailTrackRetention(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - TRACK_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const res = await prismaUnsafe.emailTrackEvent.deleteMany({ where: { at: { lt: cutoff } } });
  return res.count;
}
