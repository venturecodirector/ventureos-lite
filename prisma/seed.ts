import { PrismaClient } from "@prisma/client";
import { OWNER_GRANTS } from "../src/lib/grants";
import { BASE_TEMPLATES } from "../src/modules/templates/seed-data";
import { extractVariables } from "../src/modules/templates/render";
import {
  DEFAULT_MEETING_TYPES,
  DEFAULT_SLOT_CONFIG,
  DEFAULT_HORIZON_DAYS,
} from "../src/modules/meetings/booking-config";

const prisma = new PrismaClient();

// Default ICP config (spec §4.5 — five 1-point criteria, gate threshold 3).
const DEFAULT_ICP_CONFIG = {
  gateThreshold: 3,
  criteria: [
    { key: "segment_fit", label: "Segment fit", weight: 1 },
    { key: "trigger_signal", label: "Trigger signal", weight: 1 },
    { key: "decision_maker", label: "Decision-maker", weight: 1 },
    { key: "active_profile", label: "Active profile", weight: 1 },
    { key: "personal_hook", label: "Personal hook", weight: 1 },
  ],
};

// Default targets (from the prototype dashboard).
const DEFAULT_TARGETS = [
  { metric: "invites_sent", period: "weekly", value: 100 },
  { metric: "acceptance_rate", period: "weekly", value: 35 },
  { metric: "reply_rate", period: "weekly", value: 20 },
  { metric: "meetings_booked", period: "monthly", value: 10 },
];

// Passwords + 2FA are set in the auth phase; placeholder hash until then.
const PLACEHOLDER_HASH = "SET_IN_AUTH_PHASE";

async function main() {
  let workspace = await prisma.workspace.findFirst({
    where: { name: "Venture CO Group" },
  });
  if (!workspace) {
    workspace = await prisma.workspace.create({
      data: {
        name: "Venture CO Group",
        legalName: "Venture CO Group Kft.",
        icpConfig: DEFAULT_ICP_CONFIG,
        claudeBudget: 2,
        retentionDays: 365,
      },
    });
  }
  // Legal letterhead details used by document templates ({{workspace.*}}).
  await prisma.workspace.update({
    where: { id: workspace.id },
    data: {
      brand: { tax_id: "26841512-2-41", address: "1052 Budapest, Váci utca 1." },
    },
  });

  const tamas = await prisma.user.upsert({
    where: { email: "director@ventureco.group" },
    update: {},
    create: {
      email: "director@ventureco.group",
      name: "Tamas",
      passwordHash: PLACEHOLDER_HASH,
    },
  });

  const fanni = await prisma.user.upsert({
    where: { email: "fanni@ventureco.group" },
    update: {},
    create: {
      email: "fanni@ventureco.group",
      name: "Fanni",
      passwordHash: PLACEHOLDER_HASH,
    },
  });

  // Tamas = Owner (all grants). Fanni = BDR (no grants until explicitly given).
  await prisma.membership.upsert({
    where: { userId_workspaceId: { userId: tamas.id, workspaceId: workspace.id } },
    update: { role: "OWNER", grants: OWNER_GRANTS },
    create: {
      userId: tamas.id,
      workspaceId: workspace.id,
      role: "OWNER",
      grants: OWNER_GRANTS,
    },
  });

  await prisma.membership.upsert({
    where: { userId_workspaceId: { userId: fanni.id, workspaceId: workspace.id } },
    update: { role: "BDR", grants: [] },
    create: {
      userId: fanni.id,
      workspaceId: workspace.id,
      role: "BDR",
      grants: [],
    },
  });

  // Public booking page for Tamas — meet.{domain}/tamas (spec §4.21).
  const existingBooking = await prisma.bookingPage.findUnique({ where: { slug: "tamas" } });
  if (!existingBooking) {
    await prisma.bookingPage.create({
      data: {
        workspaceId: workspace.id,
        hostUserId: tamas.id,
        slug: "tamas",
        title: "book a call with tamas",
        meetingTypes: DEFAULT_MEETING_TYPES as unknown as object[],
        config: { ...DEFAULT_SLOT_CONFIG, horizonDays: DEFAULT_HORIZON_DAYS },
      },
    });
  }

  for (const t of DEFAULT_TARGETS) {
    await prisma.target.upsert({
      where: {
        workspaceId_metric_period: {
          workspaceId: workspace.id,
          metric: t.metric,
          period: t.period,
        },
      },
      update: { value: t.value },
      create: { workspaceId: workspace.id, ...t },
    });
  }

  // Base template set (quote/contract/certificate/email, HU + EN).
  let templatesCreated = 0;
  for (const t of BASE_TEMPLATES) {
    const exists = await prisma.template.findFirst({
      where: { workspaceId: workspace.id, type: t.type, lang: t.lang },
      select: { id: true },
    });
    if (exists) continue;
    await prisma.template.create({
      data: {
        workspaceId: workspace.id,
        type: t.type,
        lang: t.lang,
        name: t.name,
        body: t.body,
        variables: extractVariables(t.body),
        version: 1,
        status: "ACTIVE",
      },
    });
    templatesCreated += 1;
  }

  console.log(
    `Seeded workspace "${workspace.name}" with Tamas (Owner), Fanni (BDR), ICP config, ` +
      `${DEFAULT_TARGETS.length} targets and ${templatesCreated} base templates.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
