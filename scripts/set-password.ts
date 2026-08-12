import { createInterface } from "node:readline";
import { PrismaClient } from "@prisma/client";
import { hashPassword, validatePassword } from "../src/lib/auth/password";

/**
 * Set (or reset) a user's password from the server console.
 *
 * This is how the first Owner gets in: `npm run db:seed` creates the account
 * with an unusable password hash, and this script gives it a real one. It is
 * also the recovery path when someone is locked out or loses their 2FA device.
 *
 *   npm run set-password -- director@ventureco.group
 *   npm run set-password -- director@ventureco.group --clear-2fa
 *
 * The password is read from the terminal with echo off, never from argv, so it
 * does not end up in shell history or the process list.
 */
const prisma = new PrismaClient();

function usage(): never {
  console.error(
    "Usage: npm run set-password -- <email> [--clear-2fa] [--force-change]\n" +
      "  --clear-2fa      also remove the TOTP secret (lost-device recovery)\n" +
      "  --force-change   require a new password at next sign-in",
  );
  process.exit(2);
}

/** Read a line with the terminal echo turned off. */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const output = process.stdout;
    if (!input.isTTY) {
      reject(new Error("No TTY — run this in an interactive terminal."));
      return;
    }
    output.write(question);
    const rl = createInterface({ input, output, terminal: true });
    // Swallow keystroke echo while still letting readline collect the line.
    const onData = () => output.write(`\r${question}`);
    input.on("data", onData);
    rl.question("", (answer) => {
      input.off("data", onData);
      rl.close();
      output.write("\n");
      resolve(answer);
    });
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const email = args.find((a) => !a.startsWith("--"))?.trim().toLowerCase();
  if (!email) usage();
  const clear2fa = args.includes("--clear-2fa");
  const forceChange = args.includes("--force-change");

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, name: true, email: true, totpEnabled: true },
  });
  if (!user) {
    console.error(`No user with email ${email}. Run \`npm run db:seed\` first, or add them in Settings.`);
    process.exit(1);
  }

  const password = await promptHidden(`New password for ${user.email}: `);
  const confirm = await promptHidden("Repeat it: ");
  if (password !== confirm) {
    console.error("The two entries do not match. Nothing changed.");
    process.exit(1);
  }
  const problems = validatePassword(password);
  if (problems.length > 0) {
    console.error(`Password ${problems.map((p) => p.message).join("; ")}. Nothing changed.`);
    process.exit(1);
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await hashPassword(password),
      lockedUntil: null,
      mustChangePassword: forceChange,
      ...(clear2fa ? { totpEnabled: false, totpSecret: null, totpLastStep: null } : {}),
    },
  });

  // Any existing session predates this password and must not survive it.
  const { count } = await prisma.session.updateMany({
    where: { userId: user.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  console.log(`\n✓ Password set for ${user.email}`);
  if (clear2fa && user.totpEnabled) console.log("✓ Two-factor authentication removed — re-enroll in Settings");
  if (forceChange) console.log("✓ They must choose a new password at next sign-in");
  if (count > 0) console.log(`✓ Revoked ${count} existing session(s)`);
  console.log("");
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
