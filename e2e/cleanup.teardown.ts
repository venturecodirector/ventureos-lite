import { test as teardown } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

/**
 * Delete what the suite created, after the suite has run.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * Every spec runs against the same seeded workspace, and most of them create
 * leads, companies and deals through the real UI. Almost none deleted them
 * again, so the dev database grew by about a hundred leads and ten deals PER
 * RUN — 496 leads and 107 deals by the time anyone looked.
 *
 * That is not merely untidy: it makes the suite degrade until it fails for
 * reasons that have nothing to do with the code. The two failures that led here
 * were exactly that shape —
 *
 *   · the deals board caps each column at 25 cards, oldest first (deliberately,
 *     so late columns are not emptied by a board-wide limit). With 107 deals in
 *     the first stage, a newly created one is off the bottom and the spec's
 *     `toBeVisible()` fails. The product is fine; it even offers "load N more".
 *   · the leads table paginates, so a fresh lead can fall off the first page.
 *
 * A failing test that means "the previous run left too much behind" trains you
 * to ignore red, which is worse than having no test.
 *
 * Prefix-matched rather than id-tracked on purpose: it also clears what earlier
 * runs left behind, which an id list from THIS run cannot.
 */
const LEAD_PREFIXES = [
  "E2E ",
  "Edit Lead ",
  "Filter Lead ",
  "Clear Lead ",
  "Undo One",
  "Undo Two",
  "Bulk One",
  "Bulk Two",
  "Rule lead ",
  "Kovacs Anna ",
  "Inline ",
  "Merge ",
  "Domain Lead ",
];
const COMPANY_PREFIXES = [
  "E2E ",
  "Edit Co ",
  "Filter Co ",
  "Clear Co ",
  "Rule Co ",
  "Bulk Co ",
  "Undo Co ",
  "Inline Co",
  "Merge Co",
  "Domain Co ",
];

teardown("remove the rows the suite created", async () => {
  const prisma = new PrismaClient();
  try {
    const leads = await prisma.lead.findMany({
      where: { OR: LEAD_PREFIXES.map((p) => ({ contactName: { startsWith: p } })) },
      select: { id: true, companyId: true },
    });
    const leadIds = leads.map((l) => l.id);

    if (leadIds.length) {
      // Children first: several of these have no cascade, and a lead that fails
      // to delete leaves the next run in the same state as this one.
      const deals = await prisma.deal.findMany({
        where: { leadId: { in: leadIds } },
        select: { id: true },
      });
      const dealIds = deals.map((d) => d.id);
      if (dealIds.length) {
        // Documents, outcomes and invoices point at a deal with SetNull, so the
        // deal can go without touching them.
        await prisma.deal.deleteMany({ where: { id: { in: dealIds } } });
      }
      await prisma.document.deleteMany({ where: { leadId: { in: leadIds } } });
      await prisma.activity.deleteMany({ where: { leadId: { in: leadIds } } });
      await prisma.message.deleteMany({ where: { leadId: { in: leadIds } } });
      await prisma.meeting.deleteMany({ where: { leadId: { in: leadIds } } });
      await prisma.call.deleteMany({ where: { leadId: { in: leadIds } } });
      await prisma.lead.deleteMany({ where: { id: { in: leadIds } } });
    }

    // Companies the specs made, once no lead points at them any more.
    const companies = await prisma.company.findMany({
      where: {
        OR: COMPANY_PREFIXES.map((p) => ({ name: { startsWith: p } })),
        leads: { none: {} },
      },
      select: { id: true },
    });
    if (companies.length) {
      const ids = companies.map((c) => c.id);
      await prisma.deal.deleteMany({ where: { companyId: { in: ids } } });
      await prisma.registryData.deleteMany({ where: { companyId: { in: ids } } });
      await prisma.company.deleteMany({ where: { id: { in: ids } } });
    }

    // eslint-disable-next-line no-console
    console.log(
      `[cleanup] removed ${leadIds.length} leads and ${companies.length} companies left by the suite`,
    );
  } finally {
    await prisma.$disconnect();
  }
});
