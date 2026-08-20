import { PrismaClient } from "@prisma/client";

/**
 * Appoint (or remove) a platform super admin.
 *
 *   npx tsx scripts/set-super-admin.ts director@ventureco.group
 *   npx tsx scripts/set-super-admin.ts someone@example.com --off
 *   npx tsx scripts/set-super-admin.ts --list
 *
 * ── WHY THERE IS NO UI FOR THIS ─────────────────────────────────────────────
 *
 * Super admin is not a workspace role. It says who administers the
 * INSTALLATION, and a workspace Owner can already edit memberships — so if the
 * app could grant it, an Owner could grant it to themselves. Requiring a shell
 * on the server means the only people who can appoint one are the people who
 * could already read the database, which is the honest boundary.
 */
async function main() {
  const args = process.argv.slice(2);
  const prisma = new PrismaClient();
  try {
    if (args.includes("--list") || args.length === 0) {
      const admins = await prisma.user.findMany({
        where: { isSuperAdmin: true },
        select: { email: true, name: true },
        orderBy: { createdAt: "asc" },
      });
      if (admins.length === 0) {
        console.log("No super admin is set. The admin settings page is unreachable.");
      } else {
        console.log("Super admins:");
        for (const a of admins) console.log(`  ${a.email}  (${a.name})`);
      }
      if (args.length === 0) {
        console.log("\nUsage: npx tsx scripts/set-super-admin.ts <email> [--off]");
      }
      return;
    }

    const email = args[0]!.trim().toLowerCase();
    const on = !args.includes("--off");
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true, name: true } });
    if (!user) {
      console.error(`No user with the address ${email}.`);
      process.exitCode = 1;
      return;
    }

    if (!on) {
      // Refuse to leave the installation with nobody able to administer it: the
      // only way back from that is this script, and someone who has just locked
      // themselves out is not in a position to run it.
      const others = await prisma.user.count({
        where: { isSuperAdmin: true, id: { not: user.id } },
      });
      if (others === 0) {
        console.error(
          "That is the only super admin. Appoint another one first, or the admin settings become unreachable.",
        );
        process.exitCode = 1;
        return;
      }
    }

    await prisma.user.update({ where: { id: user.id }, data: { isSuperAdmin: on } });
    console.log(`${user.name} <${email}> is ${on ? "now" : "no longer"} a super admin.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
