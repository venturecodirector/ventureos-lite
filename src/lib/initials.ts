/**
 * Initials for the avatar fallback.
 *
 * Lives here rather than beside the avatar downloader because the components
 * that render the fallback are client components, and importing them from a
 * module that opens `node:fs` would drag the filesystem into the browser
 * bundle.
 */
export function initialsOf(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}
