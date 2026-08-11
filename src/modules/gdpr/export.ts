import type { WorkspaceClient } from "../../lib/db";
import { makeZip, toCsv, type ZipEntry } from "../../lib/zip";

/**
 * Full workspace data export as a CSV bundle (spec §10). One CSV per entity,
 * zipped. Runs through the guarded client, so only the caller's workspace data
 * is included. Gated by the exports.run grant at the action layer.
 */
export async function buildExportZip(db: WorkspaceClient): Promise<Buffer> {
  const [companies, leads, activities, calls, outcomes, documents] = await Promise.all([
    db.company.findMany(),
    db.lead.findMany(),
    db.activity.findMany(),
    db.call.findMany(),
    db.dealOutcome.findMany(),
    db.document.findMany(),
  ]);

  const entries: ZipEntry[] = [
    {
      name: "companies.csv",
      content: toCsv(companies as unknown as Record<string, unknown>[], [
        "id", "name", "domain", "industry", "sizeBand", "taxId", "city", "createdAt",
      ]),
    },
    {
      name: "leads.csv",
      content: toCsv(leads as unknown as Record<string, unknown>[], [
        "id", "companyId", "contactName", "email", "phone", "linkedinUrl", "source",
        "referrerId", "stage", "icpScore", "anonymizedAt", "createdAt",
      ]),
    },
    {
      name: "activities.csv",
      content: toCsv(activities as unknown as Record<string, unknown>[], [
        "id", "leadId", "type", "byUserId", "at",
      ]),
    },
    {
      name: "calls.csv",
      content: toCsv(calls as unknown as Record<string, unknown>[], [
        "id", "leadId", "outcome", "duration", "callbackAt", "at",
      ]),
    },
    {
      name: "deal_outcomes.csv",
      content: toCsv(outcomes as unknown as Record<string, unknown>[], [
        "id", "leadId", "result", "reason", "value", "competitor", "at",
      ]),
    },
    {
      name: "documents.csv",
      content: toCsv(documents as unknown as Record<string, unknown>[], [
        "id", "leadId", "type", "status", "pdfUrl", "createdAt",
      ]),
    },
  ];

  return makeZip(entries);
}
