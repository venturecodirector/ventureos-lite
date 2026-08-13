import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prismaUnsafe } from "../../src/lib/db";
import {
  listCalendarAccounts,
  getWriteAccount,
  getBusyAccounts,
} from "../../src/modules/meetings/credentials";

/**
 * Multiple connected Google accounts per host.
 *
 * The rule, and the whole point of the feature: a personal calendar blocks
 * slots but is NEVER written to. Meetings always land on the account marked
 * WRITE. Getting this backwards would put client meetings in someone's
 * private calendar, so it is worth pinning rather than trusting the UI label.
 */
const EMAIL = "multi-cal-host@ventureco.test";
let userId = "";

async function connect(accountEmail: string, purpose: "WRITE" | "BUSY_ONLY") {
  return prismaUnsafe.googleCredential.create({
    data: {
      userId,
      accountEmail,
      purpose,
      accessToken: `token-${accountEmail}`,
      refreshToken: `refresh-${accountEmail}`,
      expiryDate: new Date(Date.now() + 3_600_000),
      scope:
        "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly",
    },
  });
}

beforeEach(async () => {
  const user = await prismaUnsafe.user.upsert({
    where: { email: EMAIL },
    update: {},
    create: { email: EMAIL, name: "Multi Cal Host", passwordHash: "x" },
  });
  userId = user.id;
  await prismaUnsafe.googleCredential.deleteMany({ where: { userId } });
});

afterAll(async () => {
  await prismaUnsafe.googleCredential.deleteMany({ where: { userId } });
  await prismaUnsafe.user.deleteMany({ where: { email: EMAIL } });
});

describe("multiple calendars per host", () => {
  it("keeps both accounts and writes only to the WRITE one", async () => {
    await connect("business@ventureco.group", "WRITE");
    await connect("personal@gmail.test", "BUSY_ONLY");

    const all = await listCalendarAccounts(userId);
    expect(all).toHaveLength(2);

    const write = await getWriteAccount(userId);
    expect(write?.accountEmail).toBe("business@ventureco.group");
  });

  it("counts EVERY account for busy-checking, personal included", async () => {
    await connect("business@ventureco.group", "WRITE");
    await connect("personal@gmail.test", "BUSY_ONLY");

    const busy = await getBusyAccounts(userId);
    expect(busy.map((a) => a.accountEmail).sort()).toEqual([
      "business@ventureco.group",
      "personal@gmail.test",
    ]);
  });

  it("never picks a BUSY_ONLY account to write to while a WRITE one exists", async () => {
    // Created first, so a naive "oldest wins" would wrongly choose it.
    await connect("personal@gmail.test", "BUSY_ONLY");
    await connect("business@ventureco.group", "WRITE");

    const write = await getWriteAccount(userId);
    expect(write?.accountEmail).toBe("business@ventureco.group");
    expect(write?.purpose).toBe("WRITE");
  });

  it("still writes somewhere if no account is marked WRITE", async () => {
    // Rather than silently dropping the event on the next booking.
    await connect("personal@gmail.test", "BUSY_ONLY");
    const write = await getWriteAccount(userId);
    expect(write?.accountEmail).toBe("personal@gmail.test");
  });

  it("returns nothing when the host has connected no calendar", async () => {
    expect(await getWriteAccount(userId)).toBeNull();
    expect(await getBusyAccounts(userId)).toHaveLength(0);
  });

  it("allows the same account only once per host", async () => {
    await connect("business@ventureco.group", "WRITE");
    await expect(connect("business@ventureco.group", "BUSY_ONLY")).rejects.toThrow();
  });
});
