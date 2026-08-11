import { erasuresQueue } from "../../lib/queue";
import { getWorkspaceClient, prismaUnsafe } from "../../lib/db";
import { parseRetention } from "./retention";
import { eraseLeadData } from "./erase";

/**
 * Lead erasure job (spec §10). Requested from the app (audit-logged), executed
 * by the worker — well within the 72h SLA. Cascades over all derived data and
 * writes a completion audit entry.
 */
export interface ErasureJobData {
  workspaceId: string;
  leadId: string;
  requestedByUserId: string | null;
}

export async function enqueueLeadErasure(data: ErasureJobData): Promise<void> {
  await erasuresQueue().add("erase-lead", data, {
    jobId: `erase-${data.leadId}`,
    removeOnComplete: true,
    removeOnFail: 100,
  });
}

export async function processLeadErasure(data: ErasureJobData): Promise<void> {
  const db = getWorkspaceClient(data.workspaceId);
  const ws = await prismaUnsafe.workspace.findUnique({
    where: { id: data.workspaceId },
    select: { retentionDays: true, featureFlags: true },
  });
  const policy = parseRetention(ws ?? {});

  const result = await eraseLeadData(db, data.leadId, {
    eraseDocuments: policy.eraseDocumentsOnErasure,
  });

  // Audit the completion (the request was logged when it was raised).
  await db.auditLog.create({
    data: {
      workspaceId: data.workspaceId,
      actorUserId: data.requestedByUserId,
      action: "lead.erasure.completed",
      entityType: "Lead",
      entityId: data.leadId,
      meta: { deleted: result.deleted, filesRemoved: result.filesRemoved },
    },
  });
}
