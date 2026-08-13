import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseLogLine, parseLogDate, normalizePath } from "@/modules/logs/parse";
import { LogAccumulator, botFromUserAgent } from "@/modules/logs/analyze";
import { BotVerifier } from "@/modules/logs/bots";

/**
 * P2/8 — log analysis. Fixtures for every format we claim to support, plus the
 * two rules that carry the weight: a bot claim is verified before it is
 * counted, and nothing here retains a line.
 */
const FIXTURES = join(process.cwd(), "test/fixtures/logs");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8").trim().split("\n");

function analyze(lines: string[], verified = false) {
  const acc = new LogAccumulator();
  for (const line of lines) {
    const entry = parseLogLine(line);
    if (!entry) {
      acc.skip();
      continue;
    }
    acc.add(entry, { verifiedBot: verified });
  }
  return acc.finish();
}

describe("parseLogDate", () => {
  it("reads the CLF timestamp and applies the offset", () => {
    expect(parseLogDate("10/Oct/2026:13:55:36 +0200")!.toISOString()).toBe(
      "2026-10-10T11:55:36.000Z",
    );
    expect(parseLogDate("10/Oct/2026:13:55:36 -0700")!.toISOString()).toBe(
      "2026-10-10T20:55:36.000Z",
    );
  });

  it("returns null rather than an Invalid Date", () => {
    expect(parseLogDate("not a date")).toBeNull();
    expect(parseLogDate("10/Xxx/2026:13:55:36 +0200")).toBeNull();
  });
});

describe("normalizePath", () => {
  it("drops the query string, where session ids live", () => {
    expect(normalizePath("/arak?utm_source=x&sid=abc")).toBe("/arak");
  });
  it("treats /a and /a/ as one page", () => {
    expect(normalizePath("/a/")).toBe("/a");
    expect(normalizePath("/")).toBe("/");
  });
});

describe("nginx combined", () => {
  const lines = fixture("nginx-combined.log");
  const a = analyze(lines);

  it("parses every line", () => {
    expect(a.parsed).toBe(lines.length);
    expect(a.lines).toBe(lines.length);
  });

  it("reads the full request, not just the status", () => {
    const e = parseLogLine(lines[0]!)!;
    expect(e.ip).toBe("66.249.66.1");
    expect(e.method).toBe("GET");
    expect(e.path).toBe("/arak");
    expect(e.status).toBe(200);
    expect(e.bytes).toBe(4512);
    expect(e.userAgent).toContain("Googlebot");
    expect(e.responseTime).toBeNull();
  });

  it("splits the crawl budget by path", () => {
    expect(a.crawlBudget.map((c) => c.path).sort()).toEqual(["/arak", "/rejtett-oldal"]);
    expect(a.botHits.googlebot).toBe(2);
    expect(a.botHits.bingbot).toBe(1);
  });

  it("finds the 404 hotspot and the 5xx", () => {
    expect(a.notFoundHotspots[0]).toEqual({ path: "/nincs-ilyen", hits: 2 });
    expect(a.serverErrorHotspots[0]).toEqual({ path: "/kapcsolat", hits: 1 });
    expect(a.redirectHotspots[0]).toEqual({ path: "/arak", hits: 1 });
  });

  it("separates pages only bots see from pages only people see", () => {
    // /rejtett-oldal is crawled but never visited by a human: an orphan.
    expect(a.botOnlyPaths.map((p) => p.path)).toContain("/rejtett-oldal");
    // /kapcsolat gets human traffic and no bot at all.
    expect(a.humanOnlyPaths.map((p) => p.path)).toContain("/kapcsolat");
  });

  it("buckets statuses by day", () => {
    expect(a.statusByDay.map((d) => d.day)).toEqual(["2026-10-10", "2026-10-11"]);
    expect(a.statusByDay[1]!.counts["5xx"]).toBe(1);
    expect(a.statusTotals["4xx"]).toBe(2);
  });

  it("records the period covered", () => {
    expect(a.from).toBe("2026-10-10T11:55:36.000Z");
    // The last line is the 10:00 +0200 bingbot hit, not the 09:13 one.
    expect(a.to).toBe("2026-10-11T08:00:00.000Z");
  });
});

describe("apache common (no referer, no user agent)", () => {
  const a = analyze(fixture("apache-common.log"));

  it("parses lines that stop after the byte count", () => {
    expect(a.parsed).toBe(2);
    expect(a.statusTotals["2xx"]).toBe(1);
    expect(a.notFoundHotspots[0]!.path).toBe("/missing.gif");
  });

  it("counts an agent-less request as human rather than as a bot", () => {
    expect(a.botHits.googlebot).toBe(0);
    expect(a.hasTimings).toBe(false);
  });
});

describe("response times", () => {
  it("ranks the slow endpoints when nginx logs $request_time", () => {
    const a = analyze(fixture("nginx-timing.log"));
    expect(a.hasTimings).toBe(true);
    expect(a.slowEndpoints[0]!.path).toBe("/lassu");
    expect(a.slowEndpoints[0]!.avgSeconds).toBeCloseTo(2.817, 2);
    expect(a.slowEndpoints[0]!.maxSeconds).toBeCloseTo(3.1, 2);
  });

  it("reads Apache's %D as microseconds, not as 2.4 million seconds", () => {
    const e = parseLogLine(fixture("apache-microseconds.log")[0]!)!;
    expect(e.responseTime).toBeCloseTo(2.451, 3);
  });

  it("ignores an endpoint hit once — that is weather, not climate", () => {
    const a = analyze([
      '1.2.3.4 - - [10/Oct/2026:14:01:02 +0200] "GET /once HTTP/1.1" 200 100 "-" "UA" 9.0',
    ]);
    expect(a.slowEndpoints).toEqual([]);
  });
});

describe("robustness", () => {
  it("skips a broken line instead of ending the analysis", () => {
    const a = analyze([
      "this is not a log line at all",
      '203.0.113.9 - - [10/Oct/2026:14:01:02 +0200] "GET /ok HTTP/1.1" 200 100 "-" "UA"',
    ]);
    expect(a.lines).toBe(2);
    expect(a.parsed).toBe(1);
  });

  it("survives a request line with no protocol", () => {
    const e = parseLogLine('1.2.3.4 - - [10/Oct/2026:14:01:02 +0200] "GET /x" 200 10 "-" "UA"');
    expect(e?.path).toBe("/x");
  });
});

describe("botFromUserAgent", () => {
  it("names the two that matter and lumps the rest", () => {
    expect(botFromUserAgent("Mozilla/5.0 (compatible; Googlebot/2.1)")).toBe("googlebot");
    expect(botFromUserAgent("Mozilla/5.0 (compatible; bingbot/2.0)")).toBe("bingbot");
    expect(botFromUserAgent("SomeRandomCrawler/1.0")).toBe("other");
    expect(botFromUserAgent("Mozilla/5.0 (Macintosh)")).toBeNull();
    expect(botFromUserAgent(null)).toBeNull();
  });
});

describe("BotVerifier", () => {
  const googleIp = "66.249.66.1";

  it("confirms a real Googlebot with a forward-confirmed reverse lookup", async () => {
    const v = new BotVerifier({
      reverse: async () => ["crawl-66-249-66-1.googlebot.com"],
      resolve4: async () => [googleIp],
      resolve6: async () => [],
    });
    expect(await v.verify(googleIp, "googlebot")).toBe(true);
  });

  it("rejects a liar whose PTR does not belong to Google", async () => {
    const v = new BotVerifier({
      reverse: async () => ["scraper.example.com"],
      resolve4: async () => [googleIp],
      resolve6: async () => [],
    });
    expect(await v.verify("198.51.100.7", "googlebot")).toBe(false);
  });

  it("rejects a forged PTR that does not resolve back to the same address", async () => {
    const v = new BotVerifier({
      reverse: async () => ["fake.googlebot.com"],
      resolve4: async () => ["1.2.3.4"],
      resolve6: async () => [],
    });
    expect(await v.verify("198.51.100.7", "googlebot")).toBe(false);
  });

  it("treats an unresolvable address as unverified", async () => {
    const v = new BotVerifier({
      reverse: async () => {
        throw new Error("ENOTFOUND");
      },
      resolve4: async () => [],
      resolve6: async () => [],
    });
    expect(await v.verify("198.51.100.7", "googlebot")).toBe(false);
  });

  it("looks an address up once, however many times it appears", async () => {
    let calls = 0;
    const v = new BotVerifier({
      reverse: async () => {
        calls += 1;
        return ["crawl.googlebot.com"];
      },
      resolve4: async () => [googleIp],
      resolve6: async () => [],
    });
    await v.verify(googleIp, "googlebot");
    await v.verify(googleIp, "googlebot");
    expect(calls).toBe(1);
  });

  it("caps lookups so one upload cannot become a DNS storm", async () => {
    let calls = 0;
    const v = new BotVerifier(
      {
        reverse: async () => {
          calls += 1;
          return ["crawl.googlebot.com"];
        },
        resolve4: async () => ["9.9.9.9"],
        resolve6: async () => [],
      },
      2,
    );
    for (let i = 0; i < 10; i += 1) await v.verify(`10.0.0.${i}`, "googlebot");
    expect(calls).toBe(2);
  });
});

describe("verified vs claimed", () => {
  it("counts both, so the report can say which is which", () => {
    const lines = fixture("nginx-combined.log");
    const claimed = analyze(lines, false);
    const verified = analyze(lines, true);
    expect(claimed.botHits.googlebot).toBe(2);
    expect(claimed.verifiedBotHits.googlebot).toBe(0);
    expect(verified.verifiedBotHits.googlebot).toBe(2);
  });
});

describe("the PDF appendix", () => {
  it("reports the aggregate and no personal data", async () => {
    const { buildLogAppendixHtml } = await import("@/modules/logs/pdf-template");
    const analysis = analyze(fixture("nginx-combined.log"), true);
    const html = buildLogAppendixHtml(analysis, { companyName: "Pelda Kft" });

    expect(html).toContain("Pelda Kft");
    expect(html).toContain("Crawl budget");
    expect(html).toContain("/nincs-ilyen");
    // The whole promise of this feature: no IP address reaches the output.
    expect(html).not.toContain("66.249.66.1");
    expect(html).not.toContain("203.0.113.9");
    expect(html).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
  });

  it("says so plainly when the format carried no timings", async () => {
    const { buildLogAppendixHtml } = await import("@/modules/logs/pdf-template");
    const html = buildLogAppendixHtml(analyze(fixture("apache-common.log")));
    expect(html).toContain("nem tartalmaz válaszidőt");
  });

  it("takes its branding from the workspace", async () => {
    const { buildLogAppendixHtml } = await import("@/modules/logs/pdf-template");
    const { brandFrom } = await import("@/modules/workspaces/brand");
    const html = buildLogAppendixHtml(analyze(fixture("apache-common.log")), {
      brand: brandFrom({ name: "Studio Kft", color: "#00A3FF" }),
    });
    expect(html).toContain("Studio Kft");
    expect(html.toLowerCase()).not.toContain("venture");
  });
});
