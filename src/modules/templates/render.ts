/**
 * Template rendering engine (spec §4.10). No AI in the legal-document render
 * path (CLAUDE.md hard rule #4) — variables + templates only, deterministic so
 * a document re-renders byte-identically from its pinned template version.
 */

const VAR_RE = /\{\{\s*([\w.]+)\s*\}\}/g;

// Variables inserted as raw HTML (pre-rendered blocks), not escaped.
const RAW_VARS = new Set(["items_table"]);
const isRaw = (path: string) => RAW_VARS.has(path) || path.endsWith("_html");

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function resolvePath(data: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object") {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, data);
}

export function extractVariables(body: string): string[] {
  const set = new Set<string>();
  for (const m of body.matchAll(VAR_RE)) set.add(m[1]);
  return [...set];
}

export interface RenderResult {
  output: string;
  missing: string[];
}

export function renderTemplate(
  body: string,
  data: Record<string, unknown>,
): RenderResult {
  const missing = new Set<string>();
  const output = body.replace(VAR_RE, (_full, path: string) => {
    const value = resolvePath(data, path);
    if (value === undefined || value === null || value === "") {
      missing.add(path);
      return "";
    }
    return isRaw(path) ? String(value) : escapeHtml(String(value));
  });
  return { output, missing: [...missing] };
}

/** Variables that would render empty for this data — finalization is blocked
 * while any are present (spec §4.10). */
export function findEmptyVariables(
  body: string,
  data: Record<string, unknown>,
): string[] {
  return renderTemplate(body, data).missing;
}
