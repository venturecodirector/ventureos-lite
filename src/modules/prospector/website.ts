/**
 * Website-presence flag (spec §4.3). The "No website" and "Facebook only" rows
 * are the money rows — businesses with weak/absent web presence.
 */
export type WebsitePresence = "none" | "facebook" | "has";

function host(uri: string): string | null {
  const s = uri.trim().toLowerCase();
  if (!s) return null;
  const stripped = s.replace(/^[a-z]+:\/\//, "").split("/")[0];
  return stripped.length ? stripped : null;
}

export function classifyWebsite(websiteUri?: string | null): WebsitePresence {
  if (!websiteUri) return "none";
  const h = host(websiteUri);
  if (!h) return "none";
  if (/(^|\.)(facebook\.com|fb\.com|fb\.me)$/.test(h)) return "facebook";
  return "has";
}
