/**
 * Log aggregation (P2/8).
 *
 * Everything a client gets from their logs, reduced to counts. This is also
 * the GDPR boundary: entries carry IP addresses, aggregates do not, and only
 * the aggregate is persisted.
 *
 * Written as an accumulator so the worker can feed it a stream — a client's
 * month of logs does not fit in memory, and the analysis must not require it
 * to.
 */
import type { LogEntry } from "./parse";

export type BotName = "googlebot" | "bingbot" | "other";

/** Which bot a user agent claims to be. Claims are verified separately. */
export function botFromUserAgent(ua: string | null): BotName | null {
  if (!ua) return null;
  const s = ua.toLowerCase();
  if (s.includes("googlebot") || s.includes("google-inspectiontool")) return "googlebot";
  if (s.includes("bingbot") || s.includes("adidxbot")) return "bingbot";
  if (/bot|crawler|spider|slurp/.test(s)) return "other";
  return null;
}

export interface PathCount {
  path: string;
  hits: number;
}

export interface StatusDay {
  /** YYYY-MM-DD. */
  day: string;
  counts: Record<string, number>;
}

export interface SlowEndpoint {
  path: string;
  hits: number;
  /** Seconds. */
  avgSeconds: number;
  maxSeconds: number;
}

export interface LogAnalysis {
  lines: number;
  parsed: number;
  from: string | null;
  to: string | null;

  /** Bot hits by claimed identity, and how many of those we could verify. */
  botHits: Record<BotName, number>;
  verifiedBotHits: Record<BotName, number>;
  /** Where the crawl budget goes: bot hits per path, biggest first. */
  crawlBudget: PathCount[];

  statusTotals: Record<string, number>;
  /** Daily status-class counts, for the "when did the 5xx happen" question. */
  statusByDay: StatusDay[];
  notFoundHotspots: PathCount[];
  serverErrorHotspots: PathCount[];
  redirectHotspots: PathCount[];

  /** Paths bots visit that humans never do, and the reverse. */
  botOnlyPaths: PathCount[];
  humanOnlyPaths: PathCount[];

  /** Only present when the log format carried a response time. */
  slowEndpoints: SlowEndpoint[];
  hasTimings: boolean;
}

const TOP_N = 15;

function statusClass(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}

function topOf(map: Map<string, number>, n = TOP_N): PathCount[] {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([path, hits]) => ({ path, hits }));
}

/**
 * Streaming accumulator.
 *
 * `add` is called once per line; `finish` produces the report. Nothing keeps
 * an IP: the verified-bot decision is made per entry by the caller and only
 * its outcome is counted.
 */
export class LogAccumulator {
  private lines = 0;
  private parsed = 0;
  private first: Date | null = null;
  private last: Date | null = null;

  private botHits: Record<BotName, number> = { googlebot: 0, bingbot: 0, other: 0 };
  private verifiedBotHits: Record<BotName, number> = { googlebot: 0, bingbot: 0, other: 0 };
  private crawl = new Map<string, number>();
  private statusTotals = new Map<string, number>();
  private byDay = new Map<string, Map<string, number>>();
  private notFound = new Map<string, number>();
  private serverError = new Map<string, number>();
  private redirects = new Map<string, number>();
  private botPaths = new Map<string, number>();
  private humanPaths = new Map<string, number>();
  private timings = new Map<string, { hits: number; total: number; max: number }>();

  /** Count a line we could not parse, so the report can be honest about it. */
  skip(): void {
    this.lines += 1;
  }

  add(entry: LogEntry, opts: { verifiedBot?: boolean } = {}): void {
    this.lines += 1;
    this.parsed += 1;
    if (!this.first || entry.at < this.first) this.first = entry.at;
    if (!this.last || entry.at > this.last) this.last = entry.at;

    const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

    const cls = statusClass(entry.status);
    bump(this.statusTotals, cls);
    const day = entry.at.toISOString().slice(0, 10);
    if (!this.byDay.has(day)) this.byDay.set(day, new Map());
    bump(this.byDay.get(day)!, cls);

    if (entry.status === 404) bump(this.notFound, entry.path);
    else if (entry.status >= 500) bump(this.serverError, entry.path);
    else if (entry.status >= 300 && entry.status < 400) bump(this.redirects, entry.path);

    const bot = botFromUserAgent(entry.userAgent);
    if (bot) {
      this.botHits[bot] += 1;
      if (opts.verifiedBot) this.verifiedBotHits[bot] += 1;
      bump(this.crawl, entry.path);
      bump(this.botPaths, entry.path);
    } else {
      bump(this.humanPaths, entry.path);
    }

    if (entry.responseTime !== null) {
      const t = this.timings.get(entry.path) ?? { hits: 0, total: 0, max: 0 };
      t.hits += 1;
      t.total += entry.responseTime;
      t.max = Math.max(t.max, entry.responseTime);
      this.timings.set(entry.path, t);
    }
  }

  finish(): LogAnalysis {
    // A path bots hit that humans never do is usually an orphan: reachable and
    // indexed, but not linked anywhere a person would follow. The reverse —
    // pages people visit that no bot has fetched — is the more urgent one.
    const botOnly = new Map<string, number>();
    for (const [path, hits] of this.botPaths) {
      if (!this.humanPaths.has(path)) botOnly.set(path, hits);
    }
    const humanOnly = new Map<string, number>();
    for (const [path, hits] of this.humanPaths) {
      if (!this.botPaths.has(path)) humanOnly.set(path, hits);
    }

    const slowEndpoints = [...this.timings.entries()]
      .filter(([, t]) => t.hits >= 3) // one slow request is weather, not climate
      .map(([path, t]) => ({
        path,
        hits: t.hits,
        avgSeconds: t.total / t.hits,
        maxSeconds: t.max,
      }))
      .sort((a, b) => b.avgSeconds - a.avgSeconds)
      .slice(0, TOP_N);

    return {
      lines: this.lines,
      parsed: this.parsed,
      from: this.first?.toISOString() ?? null,
      to: this.last?.toISOString() ?? null,
      botHits: { ...this.botHits },
      verifiedBotHits: { ...this.verifiedBotHits },
      crawlBudget: topOf(this.crawl),
      statusTotals: Object.fromEntries(this.statusTotals),
      statusByDay: [...this.byDay.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([day, counts]) => ({ day, counts: Object.fromEntries(counts) })),
      notFoundHotspots: topOf(this.notFound),
      serverErrorHotspots: topOf(this.serverError),
      redirectHotspots: topOf(this.redirects),
      botOnlyPaths: topOf(botOnly),
      humanOnlyPaths: topOf(humanOnly),
      slowEndpoints,
      hasTimings: this.timings.size > 0,
    };
  }
}
