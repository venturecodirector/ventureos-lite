import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import { makeZip, type ZipEntry } from "@/lib/zip";
import { appUrl } from "@/lib/env";

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
    const name = rel.split(sep).join("/");
    entries.push({
      // Zip paths use forward slashes regardless of platform.
      name,
      content: await readFile(abs),
    });
  }

  const manifestEntry = entries.find((e) => e.name === "manifest.json");
  if (!manifestEntry) throw new Error("extension/manifest.json is missing");
  const manifest = JSON.parse(manifestEntry.content.toString()) as Record<string, unknown> & {
    version?: string;
  };
  const version = manifest.version ?? "0.0.0";

  // ---- born knowing its own server ---------------------------------------
  //
  // The extension is packaged BY the deployment that will receive its captures,
  // so the address does not have to be typed in — and CLAUDE.md's rule that
  // hosts come from the environment is kept, because this reads appUrl() rather
  // than hardcoding anything in the checked-in manifest.
  //
  // Two consequences, both of which remove a step the operator was doing by
  // hand: host_permissions means no runtime permission prompt for its own
  // server, and the bridge content script lets the app hand the extension its
  // token and ask it to read a profile.
  const origin = new URL(appUrl()).origin;
  const pattern = `${origin}/*`;

  /**
   * ADDED TO the checked-in manifest, never substituted for it.
   *
   * These two lines used to ASSIGN, and that silently deleted everything the
   * repository's own manifest declared. The passive observer registers two
   * content scripts on linkedin.com at document_start and a host permission to
   * match; the downloaded extension had neither, because packaging replaced the
   * whole array with the single bridge entry. Nothing failed and nothing warned —
   * the extension installed, the popup worked, and the content script simply was
   * not there, which is a very hard shape of bug to see from the outside.
   *
   * Any future declaration in extension/manifest.json now survives packaging by
   * default, which is the behaviour anyone editing that file would assume.
   */
  const declaredHosts = Array.isArray(manifest.host_permissions)
    ? (manifest.host_permissions as string[])
    : [];
  manifest.host_permissions = [...new Set([...declaredHosts, pattern])];

  // The bridge runs ONLY on the app's own origin — never on LinkedIn. It is what
  // lets the app talk to its extension without knowing an id that differs on
  // every side-loaded install. It joins whatever the manifest already declares.
  const declaredScripts = Array.isArray(manifest.content_scripts)
    ? (manifest.content_scripts as Record<string, unknown>[])
    : [];
  const alreadyHasBridge = declaredScripts.some(
    (cs) => Array.isArray(cs.js) && (cs.js as string[]).includes("bridge.js"),
  );
  manifest.content_scripts = alreadyHasBridge
    ? declaredScripts
    : [...declaredScripts, { matches: [pattern], js: ["bridge.js"], run_at: "document_idle" }];
  manifestEntry.content = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  // The default address travels as a tiny config file rather than being sewn
  // into the popup, so it is obvious what was injected and by whom. A
  // placeholder is checked in, so this REPLACES rather than appends — two
  // entries with one name is a corrupt zip.
  const configContent = Buffer.from(
    `// Written at download time by ${origin}. The address of the Venture OS\n` +
      `// that packaged this extension, so it does not have to be typed in.\n` +
      `globalThis.VENTURE_DEFAULT_BASE_URL = ${JSON.stringify(origin)};\n`,
    "utf8",
  );
  const configEntry = entries.find((e) => e.name === "config.js");
  if (configEntry) configEntry.content = configContent;
  else entries.push({ name: "config.js", content: configContent });
  entries.sort((a, b) => a.name.localeCompare(b.name));

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
