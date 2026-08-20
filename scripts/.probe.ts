import { readFileSync } from "node:fs";
const snap = JSON.parse(readFileSync("test/fixtures/linkedin-api/rsc-profile.json", "utf8"));
type Row = { id: string | null; value?: unknown };
for (const rec of snap.records) {
  const body = rec.body as { rows?: Row[] } | null;
  if (!body?.rows) continue;
  const rows = new Map(body.rows.filter((r) => r.id && r.value !== undefined).map((r) => [String(r.id), r.value]));
  const find = (v: unknown, want: string): unknown => {
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const vt = o.viewTrackingSpecs as { viewName?: string } | undefined;
      if (vt?.viewName === want) return o;
      for (const x of Object.values(o)) { const r = find(x, want); if (r) return r; }
    }
    if (Array.isArray(v)) for (const x of v) { const r = find(x, want); if (r) return r; }
    return null;
  };
  for (const want of ["contact-website", "contact-birthday"]) {
    const node = find(body.rows, want);
    if (!node) continue;
    const out: string[] = [];
    const walk = (v: unknown, seen: Set<string>, d = 0) => {
      if (d > 50 || out.length > 40) return;
      if (typeof v === "string") {
        const m = /^\$L?([0-9a-f]{1,4})$/.exec(v);
        if (m && rows.has(m[1]!) && !seen.has(m[1]!)) walk(rows.get(m[1]!), new Set([...seen, m[1]!]), d + 1);
        else out.push(v);
        return;
      }
      if (Array.isArray(v)) { for (const x of v) walk(x, seen, d + 1); return; }
      if (v && typeof v === "object") {
        for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
          if (k === "viewTrackingSpecs" || k === "visibilityTriggers") continue;
          walk(x, seen, d + 1);
        }
      }
    };
    walk(node, new Set());
    const interesting = [...new Set(out)].filter((s) => s.startsWith("<") || /^https?:/.test(s));
    console.log(`  ${want}: ${JSON.stringify(interesting.slice(0, 12))}`);
  }
}
