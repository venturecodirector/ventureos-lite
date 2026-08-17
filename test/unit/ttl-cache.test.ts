import { describe, it, expect, beforeEach } from "vitest";
import {
  cached,
  cacheSize,
  clearCache,
  invalidate,
  DEFAULT_TTL_MS,
} from "../../src/lib/ttl-cache";

/**
 * The aggregate cache (playbook-v2 P6/3).
 *
 * Small enough that the tests are mostly about the two things that would make
 * it dangerous: a key that outlives its TTL, and a key that crosses tenants.
 */
beforeEach(() => clearCache());

describe("cached", () => {
  it("computes once inside the window and again after it", async () => {
    let calls = 0;
    const compute = async () => {
      calls += 1;
      return calls;
    };
    const t0 = 1_000_000;

    expect(await cached("k", compute, DEFAULT_TTL_MS, t0)).toBe(1);
    expect(await cached("k", compute, DEFAULT_TTL_MS, t0 + 30_000)).toBe(1);
    expect(calls).toBe(1);

    expect(await cached("k", compute, DEFAULT_TTL_MS, t0 + DEFAULT_TTL_MS + 1)).toBe(2);
    expect(calls).toBe(2);
  });

  it("keeps workspace-keyed values apart", async () => {
    await cached("analytics:ws-a", async () => "A");
    await cached("analytics:ws-b", async () => "B");
    expect(await cached("analytics:ws-a", async () => "changed")).toBe("A");
    expect(await cached("analytics:ws-b", async () => "changed")).toBe("B");
  });

  it("does not cache a rejection", async () => {
    await expect(
      cached("boom", async () => {
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");
    expect(await cached("boom", async () => "recovered")).toBe("recovered");
  });
});

describe("invalidate", () => {
  it("drops an exact key and everything under its prefix", async () => {
    await cached("lead-facets:ws-a", async () => 1);
    await cached("lead-facets:ws-b", async () => 2);
    await cached("analytics:ws-a", async () => 3);

    expect(invalidate("lead-facets")).toBe(2);
    expect(cacheSize()).toBe(1);
    expect(await cached("analytics:ws-a", async () => 99)).toBe(3);
  });

  it("does not drop a key that merely starts with the same letters", async () => {
    await cached("analytics:ws-a", async () => 1);
    expect(invalidate("analytic")).toBe(0);
    expect(cacheSize()).toBe(1);
  });
});

describe("bounds", () => {
  it("stays bounded when a tenant-keyed cache would otherwise grow for ever", async () => {
    for (let i = 0; i < 700; i += 1) {
      await cached(`ws-${i}`, async () => i);
    }
    expect(cacheSize()).toBeLessThanOrEqual(500);
  });
});
