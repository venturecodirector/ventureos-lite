import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import {
  callClaude,
  type CallClaudeDeps,
  type ClaudeResponse,
} from "../../src/lib/ai/call-claude";
import { computeCostUsd, WEB_SEARCH_USD_PER_REQUEST } from "../../src/lib/ai/cost";
import { modelForUseCase } from "../../src/lib/ai/models";
import { normalizeDomain, isDirectoryDomain } from "../../src/modules/leads/domain";
import { isBlockedHostname, isPrivateIpAddress } from "../../src/lib/safe-fetch";
import { siteLookupSchema } from "../../src/lib/ai/prompts/site-lookup";

/**
 * The Domain Lookup button (lead form).
 *
 * The two things worth pinning down are the ones that cost or leak: that a web
 * search is BILLED and counted against the daily cap, and that a hostname taken
 * from a form field can never point the server at its own network.
 */

describe("normalizeDomain", () => {
  it("reads a hostname out of whatever was pasted", () => {
    for (const input of [
      "example.hu",
      "www.example.hu",
      "https://example.hu",
      "https://www.example.hu/kapcsolat?x=1#y",
      "  http://WWW.Example.HU/  ".trim(),
      "example.hu.",
    ]) {
      expect(normalizeDomain(input)).toBe("example.hu");
    }
  });

  it("punycodes, so an accented domain and its ascii form are one company", () => {
    expect(normalizeDomain("példa.hu")).toBe("xn--plda-bpa.hu");
    expect(normalizeDomain("xn--plda-bpa.hu")).toBe("xn--plda-bpa.hu");
  });

  it("refuses what is not a hostname", () => {
    for (const input of [
      "",
      "   ",
      "not a domain",
      "localhost",
      "hu",
      "-bad.hu",
      "bad-.hu",
      "example.123",
      "192.168.0.1",
      null,
      undefined,
      12,
    ]) {
      expect(normalizeDomain(input)).toBeNull();
    }
  });
});

describe("isDirectoryDomain", () => {
  it("catches the listings a company-name search actually returns", () => {
    for (const host of [
      "linkedin.com",
      "hu.linkedin.com",
      "www.facebook.com",
      "e-cegjegyzek.hu",
      "opten.hu",
      "nevjegy.hu",
      "profession.hu",
      "crunchbase.com",
      "hu.wikipedia.org",
    ]) {
      expect(isDirectoryDomain(host)).toBe(true);
    }
  });

  it("leaves an ordinary company site alone", () => {
    for (const host of ["ventureco.agency", "example.hu", "linkedin-marketing.hu"]) {
      expect(isDirectoryDomain(host)).toBe(false);
    }
  });
});

describe("isBlockedHostname — the server's own network is not a lead's website", () => {
  it("refuses loopback, private ranges, cloud metadata and internal names", () => {
    for (const host of [
      "localhost",
      "db", // the Docker service name
      "redis",
      "127.0.0.1",
      "0.0.0.0",
      "10.1.2.3",
      "172.16.5.5",
      "172.31.255.254",
      "192.168.1.1",
      "169.254.169.254", // cloud metadata
      "100.64.0.1", // CGNAT
      "app.internal",
      "printer.local",
      "foo.localhost",
      "[::1]",
      "::1",
      "999.1.1.1",
      "",
    ]) {
      expect(isBlockedHostname(host), host).toBe(true);
    }
  });

  it("allows a public host, including the public 172.x that is not private", () => {
    for (const host of ["example.hu", "ventureco.agency", "8.8.8.8", "172.32.0.1"]) {
      expect(isBlockedHostname(host), host).toBe(false);
    }
  });
});

describe("isPrivateIpAddress", () => {
  /**
   * The first version of the DNS check demanded that EVERY resolved address be
   * IPv4, which quietly refused every dual-stack site — most real company
   * websites — because an AAAA record counted as a disqualification instead of
   * as an address to judge. Only running it against example.com found that.
   */
  it("lets a public IPv6 address through", () => {
    for (const ip of ["2606:2800:220:1:248:1893:25c8:1946", "2001:4860:4860::8888"]) {
      expect(isPrivateIpAddress(ip), ip).toBe(false);
    }
  });

  it("still refuses the v6 addresses that point inward", () => {
    for (const ip of [
      "::1",
      "::",
      "fd00::1", // unique-local
      "fc00::1",
      "fe80::1", // link-local
      "::ffff:127.0.0.1", // IPv4-mapped loopback
      "64:ff9b::7f00:1", // NAT64
      "FD00::1", // case is not a bypass
    ]) {
      expect(isPrivateIpAddress(ip), ip).toBe(true);
    }
  });

  it("judges v4 the same way whichever entry point is used", () => {
    expect(isPrivateIpAddress("10.0.0.1")).toBe(true);
    expect(isPrivateIpAddress("8.8.8.8")).toBe(false);
  });
});

// ---------------------------------------------------------------------------

function res(over: Partial<ClaudeResponse> = {}): ClaudeResponse {
  return {
    content: [{ type: "text", text: '{"domain":"example.hu","confidence":"high","evidenceUrl":null,"reason":"r"}' }],
    usage: { input_tokens: 1000, output_tokens: 100 },
    stop_reason: "end_turn",
    model: "claude-haiku-4-5",
    ...over,
  };
}

function makeDeps(over: Partial<CallClaudeDeps> = {}): CallClaudeDeps {
  return {
    createMessage: vi.fn(async () => res()),
    apiKeyFor: vi.fn(async () => null),
    spentTodayUsd: vi.fn(async () => 0),
    capUsd: vi.fn(async () => 2),
    logUsage: vi.fn(async () => {}),
    ...over,
  };
}

const params = {
  useCase: "site_lookup" as const,
  workspaceId: "w",
  system: "S",
  messages: [{ role: "user" as const, content: "find it" }],
  schema: siteLookupSchema,
};

describe("callClaude web search", () => {
  it("keeps site_lookup on haiku — a URL lookup is not one of the four Sonnet cases", () => {
    expect(modelForUseCase("site_lookup")).toBe("claude-haiku-4-5");
  });

  it("sends the search tool with its cap only when asked", async () => {
    const withSearch = makeDeps();
    await callClaude({ ...params, webSearch: { maxUses: 4 } }, withSearch);
    const sent = (withSearch.createMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sent.tools).toEqual([
      {
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 4,
      },
    ]);

    const without = makeDeps();
    await callClaude(params, without);
    const plain = (without.createMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(plain.tools).toBeUndefined();
  });

  it("bills each search and logs the count, so the daily cap sees it", async () => {
    const deps = makeDeps({
      createMessage: vi.fn(async () =>
        res({ serverToolUse: { web_search_requests: 3 } }),
      ),
    });
    const out = await callClaude(
      { ...params, webSearch: { maxUses: 4 } },
      deps,
    );

    const tokensOnly = computeCostUsd("claude-haiku-4-5", {
      input_tokens: 1000,
      output_tokens: 100,
    });
    expect(out.costUsd).toBeCloseTo(tokensOnly + 3 * WEB_SEARCH_USD_PER_REQUEST, 10);
    // The searches dominate: token cost alone would understate this call ~10x.
    expect(out.costUsd).toBeGreaterThan(tokensOnly * 10);

    const logged = (deps.logUsage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(logged.webSearches).toBe(3);
    expect(logged.costUsd).toBeCloseTo(out.costUsd, 10);
  });

  it("counts the searches the REPAIR retry runs too", async () => {
    let call = 0;
    const deps = makeDeps({
      createMessage: vi.fn(async () => {
        call += 1;
        return call === 1
          ? res({
              content: [{ type: "text", text: "not json" }],
              serverToolUse: { web_search_requests: 2 },
            })
          : res({ serverToolUse: { web_search_requests: 1 } });
      }),
    });
    await callClaude({ ...params, webSearch: { maxUses: 4 } }, deps);
    const logged = (deps.logUsage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(logged.webSearches).toBe(3);
  });

  it("still refuses to call out once the cap is reached", async () => {
    const deps = makeDeps({ spentTodayUsd: vi.fn(async () => 2), capUsd: vi.fn(async () => 2) });
    await expect(
      callClaude({ ...params, webSearch: { maxUses: 4 } }, deps),
    ).rejects.toThrow();
    expect(deps.createMessage).not.toHaveBeenCalled();
  });
});

describe("the answer schema", () => {
  it("accepts a null domain — 'I could not tell' is a valid answer", () => {
    expect(
      siteLookupSchema.parse({
        domain: null,
        confidence: "low",
        evidenceUrl: null,
        reason: "Two companies share the name.",
      }).domain,
    ).toBeNull();
  });

  it("rejects a made-up confidence", () => {
    const bad = siteLookupSchema.safeParse({
      domain: "x.hu",
      confidence: "certain",
      evidenceUrl: null,
      reason: "",
    });
    expect(bad.success).toBe(false);
  });
});

describe("cost", () => {
  it("charges nothing extra when no search ran", () => {
    const u = { input_tokens: 1000, output_tokens: 100 };
    expect(computeCostUsd("claude-haiku-4-5", u, { web_search_requests: 0 })).toBe(
      computeCostUsd("claude-haiku-4-5", u),
    );
  });
});
