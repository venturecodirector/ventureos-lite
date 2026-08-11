import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.FILES_DIR = join(tmpdir(), "vos-invoice-test");

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getWorkspaceClient, prismaUnsafe } from "../../src/lib/db";
import { composeFromCertificate } from "../../src/modules/invoicing/data";
import { confirmationHash, ConfirmationError } from "../../src/modules/invoicing/logic";
import { runInvoiceSubmit } from "../../src/modules/invoicing/submit";
import type { SzamlaProvider, CreateInvoiceResult } from "../../src/modules/invoicing/provider";

/**
 * Számla Agent submission guarantees (spec §4.23):
 *   - confirm-gate: nothing is submitted unless the exact payload was confirmed;
 *   - failure-to-queue: validation/network/rejected failures land in the Today
 *     Queue with the raw response, and the Invoice is marked FAILED.
 */
const WS = "Invoicing Test";
let wsId = "";
let certId = "";
let leadId = "";
const NOW = new Date("2026-08-12T00:00:00Z");

function mockProvider(behaviour: "success" | "reject" | "network"): SzamlaProvider & { calls: number } {
  return {
    name: "test",
    calls: 0,
    async createInvoice(): Promise<CreateInvoiceResult> {
      this.calls += 1;
      if (behaviour === "network") throw new Error("ECONNREFUSED szamlazz.hu");
      if (behaviour === "reject") {
        return { result: { ok: false, errorCode: "3", error: "Hibás adószám" }, pdf: null, raw: "<xmlszamlavalasz><hibakod>3</hibakod></xmlszamlavalasz>" };
      }
      return { result: { ok: true, invoiceNumber: "E-2026-999" }, pdf: Buffer.from("%PDF-1.4 ok"), raw: "ok" };
    },
    async queryPaid() {
      return { paid: false, raw: "" };
    },
  };
}

async function clean() {
  const stale = await prismaUnsafe.workspace.findMany({ where: { name: WS }, select: { id: true } });
  const ids = stale.map((w) => w.id);
  if (!ids.length) return;
  for (const t of ["invoice", "activity", "document", "lead", "company"] as const) {
    // @ts-expect-error dynamic model access
    await prismaUnsafe[t].deleteMany({ where: { workspaceId: { in: ids } } });
  }
  await prismaUnsafe.workspace.deleteMany({ where: { id: { in: ids } } });
}

beforeEach(async () => {
  await clean();
  wsId = (await prismaUnsafe.workspace.create({ data: { name: WS } })).id;
  const company = await prismaUnsafe.company.create({ data: { workspaceId: wsId, name: "Fortuna Kft.", city: "Budapest", address: "1051 Budapest, Fő u. 1.", taxId: "12345678-1-42" } });
  const lead = await prismaUnsafe.lead.create({ data: { workspaceId: wsId, companyId: company.id, contactName: "Márta", email: "m@fortuna.hu" } });
  leadId = lead.id;
  const quote = await prismaUnsafe.document.create({
    data: { workspaceId: wsId, leadId, type: "QUOTE", status: "ACCEPTED", payload: { items: [{ description: "Weboldal", baseNet: 1_000_000, preset: "none" }], vatRatePct: 27, quoteNumber: "Q-2026-1" } },
  });
  const contract = await prismaUnsafe.document.create({ data: { workspaceId: wsId, leadId, type: "CONTRACT", status: "SIGNED", chainParentId: quote.id } });
  certId = (await prismaUnsafe.document.create({ data: { workspaceId: wsId, leadId, type: "CERTIFICATE", status: "ACKNOWLEDGED", chainParentId: contract.id } })).id;
});

afterAll(async () => {
  await clean();
  await prismaUnsafe.$disconnect();
});

async function goodHash(): Promise<string> {
  const db = getWorkspaceClient(wsId);
  const c = await composeFromCertificate(db, certId, NOW);
  if (!c.ok) throw new Error(c.error);
  return confirmationHash(c.value.payload);
}

describe("confirm-gate — no submit without confirming the exact payload", () => {
  it("throws and never calls the provider when the hash doesn't match", async () => {
    const db = getWorkspaceClient(wsId);
    const provider = mockProvider("success");
    await expect(
      runInvoiceSubmit(db, { workspaceId: wsId, certificateId: certId, confirmedHash: "not-the-hash", agentKey: "K", actorUserId: null, now: NOW, provider }),
    ).rejects.toBeInstanceOf(ConfirmationError);
    expect(provider.calls).toBe(0);
    expect(await prismaUnsafe.invoice.count({ where: { workspaceId: wsId } })).toBe(0);
  });

  it("submits once the exact payload is confirmed", async () => {
    const db = getWorkspaceClient(wsId);
    const provider = mockProvider("success");
    const res = await runInvoiceSubmit(db, { workspaceId: wsId, certificateId: certId, confirmedHash: await goodHash(), agentKey: "K", actorUserId: null, now: NOW, provider });
    expect(res.ok).toBe(true);
    expect(res.invoiceNumber).toBe("E-2026-999");
    expect(provider.calls).toBe(1);
    const inv = await prismaUnsafe.invoice.findFirst({ where: { documentId: certId } });
    expect(inv?.status).toBe("ISSUED");
    expect(inv?.number).toBe("E-2026-999");
  });
});

describe("failure-to-Today-Queue path", () => {
  it("a rejected payload → Invoice FAILED + invoice_failed activity with raw response", async () => {
    const db = getWorkspaceClient(wsId);
    const res = await runInvoiceSubmit(db, { workspaceId: wsId, certificateId: certId, confirmedHash: await goodHash(), agentKey: "K", actorUserId: null, now: NOW, provider: mockProvider("reject") });
    expect(res.ok).toBe(false);
    expect(res.kind).toBe("rejected");

    const inv = await prismaUnsafe.invoice.findFirst({ where: { documentId: certId } });
    expect(inv?.status).toBe("FAILED");

    const act = await prismaUnsafe.activity.findFirst({ where: { workspaceId: wsId, type: "invoice_failed" } });
    expect(act).not.toBeNull();
    expect((act?.payload as Record<string, unknown>).kind).toBe("rejected");
    expect((act?.payload as Record<string, unknown>).raw).toContain("xmlszamlavalasz"); // raw response attached
    expect(act?.leadId).toBe(leadId);
  });

  it("a network error → Invoice FAILED + invoice_failed activity (kind network)", async () => {
    const db = getWorkspaceClient(wsId);
    const res = await runInvoiceSubmit(db, { workspaceId: wsId, certificateId: certId, confirmedHash: await goodHash(), agentKey: "K", actorUserId: null, now: NOW, provider: mockProvider("network") });
    expect(res.ok).toBe(false);
    expect(res.kind).toBe("network");
    const act = await prismaUnsafe.activity.findFirst({ where: { workspaceId: wsId, type: "invoice_failed" } });
    expect((act?.payload as Record<string, unknown>).kind).toBe("network");
  });
});
