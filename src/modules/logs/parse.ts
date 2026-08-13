/**
 * Access-log parsing (P2/8).
 *
 * Server logs are the only place that records what search engines actually did
 * on a site, as opposed to what a crawler of ours guesses they would do. They
 * are also full of IP addresses, which is why nothing here keeps a line: the
 * parser yields entries, the analyser aggregates them, and the raw upload is
 * deleted (see the retention job).
 *
 * Pure and line-at-a-time so the worker can stream a gzipped multi-gigabyte
 * file without holding it, and so every supported format is testable against a
 * fixture.
 */
export interface LogEntry {
  ip: string;
  /** UTC timestamp of the request. */
  at: Date;
  method: string;
  path: string;
  status: number;
  bytes: number;
  referer: string | null;
  userAgent: string | null;
  /** Seconds, when the format carries $request_time. */
  responseTime: number | null;
}

/**
 * Combined, common, and the two variants we actually meet in the wild:
 * nginx with $request_time appended, and Apache's %D (microseconds).
 *
 * One regex with optional tails rather than four, because the head of every
 * one of these formats is identical and a format-sniffing pass over a 2 GB
 * file would cost a second read.
 */
const LINE = new RegExp(
  [
    // 1: client IP (v4 or v6)
    /^(\S+)\s+\S+\s+(\S+)\s+/, // 2: remote user (unused, but positional)
    // 3: timestamp
    /\[([^\]]+)\]\s+/,
    // 4,5,6: "METHOD path protocol" — the request line, which may be garbage
    /"(\S+)\s+(\S*?)(?:\s+(\S+))?"\s+/,
    // 7: status, 8: bytes
    /(\d{3})\s+(\S+)/,
    // 9: referer, 10: user agent (combined only)
    /(?:\s+"([^"]*)"\s+"([^"]*)")?/,
    // 11: trailing response time — nginx seconds (0.123) or Apache micros
    /(?:\s+"?([\d.]+)"?)?/,
    /\s*$/,
  ]
    .map((r) => r.source)
    .join(""),
);

const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

/**
 * "10/Oct/2026:13:55:36 +0200" → Date.
 *
 * Parsed by hand: Date.parse does not accept this format consistently across
 * runtimes, and a log whose timestamps silently become Invalid Date would
 * produce an analysis with a perfectly plausible empty timeline.
 */
export function parseLogDate(raw: string): Date | null {
  const m = /^(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})\s*([+-]\d{4})?$/.exec(raw.trim());
  if (!m) return null;
  const month = MONTHS[m[2]!];
  if (month === undefined) return null;

  const utc = Date.UTC(
    Number(m[3]),
    month,
    Number(m[1]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
  );
  const tz = m[7];
  if (!tz) return new Date(utc);
  const sign = tz[0] === "-" ? 1 : -1;
  const offsetMinutes = Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3, 5));
  return new Date(utc + sign * offsetMinutes * 60_000);
}

/** Path without the query string, which is where session ids hide. */
export function normalizePath(raw: string): string {
  const path = raw.split("?")[0] || "/";
  if (path.length <= 1) return path;
  return path.replace(/\/+$/, "") || "/";
}

/**
 * One line to an entry, or null when it is not a request line we understand.
 *
 * Returning null rather than throwing: real logs contain truncated lines,
 * health-check noise and the occasional binary smear, and one bad line must
 * not end the analysis of a million good ones.
 */
export function parseLogLine(line: string): LogEntry | null {
  const m = LINE.exec(line.trim());
  if (!m) return null;

  const at = parseLogDate(m[3] ?? "");
  if (!at) return null;

  const status = Number(m[7]);
  if (!Number.isFinite(status)) return null;

  const rawTime = m[11] ? Number(m[11]) : null;
  // Apache's %D is microseconds; nginx's $request_time is seconds. Anything
  // over 1000 "seconds" for one request is really microseconds.
  const responseTime =
    rawTime === null || !Number.isFinite(rawTime)
      ? null
      : rawTime > 1000
        ? rawTime / 1_000_000
        : rawTime;

  return {
    ip: m[1] ?? "",
    at,
    method: (m[4] ?? "").toUpperCase(),
    path: normalizePath(m[5] ?? "/"),
    status,
    bytes: Number(m[8]) || 0,
    referer: m[9] && m[9] !== "-" ? m[9] : null,
    userAgent: m[10] && m[10] !== "-" ? m[10] : null,
    responseTime,
  };
}
