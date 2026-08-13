import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import { makeZip, type ZipEntry } from "@/lib/zip";

/**
 * Packages the browser extension for download from inside the app (P1/1e).
 *
 * Built on demand from the extension/ directory rather than from a checked-in
 * artifact. A stale zip that silently lags the source is worse than a moment
 * of CPU: whoever downloads it gets whatever the deployment is actually
 * running.
 */
const EXTENSION_DIR = join(process.cwd(), "extension");

/** Never shipped to a browser: developer notes and licence text. */
const EXCLUDE_FILES = new Set(["README.md", ".DS_Store"]);
/** The icon source stays behind; browsers want the rasterised PNGs. */
const EXCLUDE_PATHS = new Set([join("icons", "mark.svg")]);

export interface ExtensionPackage {
  zip: Buffer;
  filename: string;
  version: string;
  /** Short digest so a re-download that changed nothing is recognisable. */
  fingerprint: string;
  fileCount: number;
}

async function collect(dir: string, acc: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await collect(full, acc);
    else acc.push(full);
  }
  return acc;
}

export async function buildExtensionPackage(): Promise<ExtensionPackage> {
  const files = await collect(EXTENSION_DIR);

  const entries: ZipEntry[] = [];
  for (const abs of files.sort()) {
    const rel = relative(EXTENSION_DIR, abs);
    if (EXCLUDE_FILES.has(rel) || EXCLUDE_PATHS.has(rel)) continue;
    const info = await stat(abs);
    if (!info.isFile()) continue;
    entries.push({
      // Zip paths use forward slashes regardless of platform.
      name: rel.split(sep).join("/"),
      content: await readFile(abs),
    });
  }

  const manifestEntry = entries.find((e) => e.name === "manifest.json");
  if (!manifestEntry) throw new Error("extension/manifest.json is missing");
  const manifest = JSON.parse(manifestEntry.content.toString()) as { version?: string };
  const version = manifest.version ?? "0.0.0";

  const zip = makeZip(entries);
  const fingerprint = createHash("sha256").update(zip).digest("hex").slice(0, 12);

  return {
    zip,
    filename: `venture-os-capture-${version}.zip`,
    version,
    fingerprint,
    fileCount: entries.length,
  };
}
