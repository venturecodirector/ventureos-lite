import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appUrl } from "@/lib/env";
import { buildExtensionPackage } from "../../src/modules/extension/package";

/**
 * The download has to be a zip a browser will actually load, so this unpacks
 * the real artifact with the system unzip rather than trusting our own writer.
 */
describe("extension package", () => {
  it("produces a zip that unzip can read, containing a loadable extension", async () => {
    const pkg = await buildExtensionPackage();
    const dir = mkdtempSync(join(tmpdir(), "ext-"));
    const zipPath = join(dir, pkg.filename);
    writeFileSync(zipPath, pkg.zip);

    // -t tests the archive; a corrupt central directory fails here.
    const tested = execFileSync("unzip", ["-t", zipPath], { encoding: "utf8" });
    expect(tested).toContain("No errors detected");

    const listing = execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);

    // Everything Chrome needs to load it unpacked.
    for (const required of [
      "manifest.json",
      "background.js",
      "content.js",
      "popup.html",
      "popup.js",
      "diagnose.js",
      "snapshot.js",
      "photo.js",
      "contact.js",
      // The pure label parser, split out of contact.js so the state machine can
      // reuse it without also inheriting the clicking.
      "contact-parse.js",
      "selectors.js",
      "cleanup.js",
      // Name agreement (accent folding, Hungarian order, LinkedIn's ID suffixes),
      // the capture state machine, and the one line that starts it.
      "names.js",
      "machine.js",
      "run.js",
      // Diagnostics, out of popup.js so it can be tested outside a popup.
      "diagnostics.js",
      // The passive observer: one half per world, plus the snapshot scrubber.
      "observer-main.js",
      "observer-bridge.js",
      "api-scrub.js",
      "permission.html",
      "permission.js",
      "panel.js",
      "icons/icon-16.png",
      "icons/icon-128.png",
    ]) {
      expect(listing, `missing ${required}`).toContain(required);
    }

    // Developer notes and the icon source stay out of the shipped package.
    expect(listing).not.toContain("README.md");
    expect(listing).not.toContain("icons/mark.svg");
  });

  it("round-trips the manifest intact, with matching version", async () => {
    const pkg = await buildExtensionPackage();
    const dir = mkdtempSync(join(tmpdir(), "ext-"));
    const zipPath = join(dir, "e.zip");
    writeFileSync(zipPath, pkg.zip);

    const manifest = JSON.parse(
      execFileSync("unzip", ["-p", zipPath, "manifest.json"], { encoding: "utf8" }),
    );
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.version).toBe(pkg.version);
    // The permission model this build deliberately settled on. clipboardWrite
    // serves the diagnostics button and downloads serves the DOM-snapshot
    // button; neither raises a Chrome install warning. The absent ones are the
    // point — no "tabs", no host access up front.
    expect(manifest.permissions).toEqual([
      "activeTab",
      "scripting",
      "storage",
      "clipboardWrite",
      "downloads",
    ]);
    expect(manifest.permissions).not.toContain("tabs");
    expect(manifest.optional_host_permissions).toEqual(["https://*/*"]);
  });

  it("is packaged knowing its own server, so nobody types an address", async () => {
    // The extension is built BY the deployment that receives its captures, so
    // the address is injected here rather than hardcoded in the checked-in
    // manifest — which keeps CLAUDE.md's "hosts come from the environment".
    const pkg = await buildExtensionPackage();
    const dir = mkdtempSync(join(tmpdir(), "ext-"));
    const zipPath = join(dir, "e.zip");
    writeFileSync(zipPath, pkg.zip);

    const origin = new URL(appUrl()).origin;
    const manifest = JSON.parse(
      execFileSync("unzip", ["-p", zipPath, "manifest.json"], { encoding: "utf8" }),
    );

    /**
     * PRESENT, not SOLE — and that distinction was the bug.
     *
     * These two assertions used to be exact-equality, which is what a packager
     * that ASSIGNS rather than appends produces. They passed happily while the
     * packaging silently deleted the observer's own content scripts and host
     * permission from every downloaded copy.
     *
     * What this test is actually about is that the deployment injects its own
     * address, so nobody types one. That claim is unchanged; the claim that
     * nothing ELSE may be declared was never intended and is gone.
     */
    expect(manifest.host_permissions).toContain(`${origin}/*`);

    // The bridge runs ONLY on the app's origin — never on LinkedIn. That
    // boundary is the whole reason it is safe to let a page talk to it.
    expect(manifest.content_scripts).toContainEqual({
      matches: [`${origin}/*`],
      js: ["bridge.js"],
      run_at: "document_idle",
    });

    const config = execFileSync("unzip", ["-p", zipPath, "config.js"], { encoding: "utf8" });
    expect(config).toContain(origin);

    // Injected once, not appended alongside the checked-in placeholder: two
    // entries with one name is a corrupt zip.
    const listing = execFileSync("unzip", ["-l", zipPath], { encoding: "utf8" });
    expect(listing.match(/config\.js/g) ?? []).toHaveLength(1);
    expect(listing).toContain("bridge.js");
  });

  it("keeps binary icons byte-identical through the zip", async () => {
    const pkg = await buildExtensionPackage();
    const dir = mkdtempSync(join(tmpdir(), "ext-"));
    const zipPath = join(dir, "e.zip");
    writeFileSync(zipPath, pkg.zip);

    const png = execFileSync("unzip", ["-p", zipPath, "icons/icon-128.png"], {
      encoding: "buffer",
    });
    // PNG magic — proves the writer did not mangle binary content as UTF-8.
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png.byteLength).toBeGreaterThan(1000);
  });

  it("gates the same page kinds in the popup and the service worker", async () => {
    // The two gates are separate copies — an MV3 service worker without
    // "type": "module" cannot import a shared one — so the thing worth testing
    // is that they have not drifted apart. A popup that offers to read a page
    // the worker then refuses is the confusing half of that failure.
    const patternIn = (name: string) => {
      const src = readFileSync(join(process.cwd(), "extension", name), "utf8");
      // The regex literal as SHIPPED, lifted out and run — not a copy of it
      // written here, which would pass happily while the file said something
      // else.
      const m = /(\/\^https:[^\n]*?\/)i/.exec(src);
      expect(m, `no profile-URL pattern found in ${name}`).not.toBeNull();
      return new RegExp(m![1]!.slice(1, -1), "i");
    };

    for (const name of ["popup.js", "background.js"]) {
      const gate = patternIn(name);
      for (const allowed of [
        "https://www.linkedin.com/in/nagy-anna",
        "https://linkedin.com/in/nagy-anna/",
        "https://www.linkedin.com/sales/lead/ACwAAB1234,NAME_SEARCH,a1b2",
        "https://www.linkedin.com/sales/people/ACwAAB1234",
      ]) {
        expect(gate.test(allowed), `${name} should accept ${allowed}`).toBe(true);
      }
      for (const refused of [
        "https://www.linkedin.com/feed/",
        "https://www.linkedin.com/company/danubia",
        "https://www.linkedin.com/sales/search/people",
        "http://www.linkedin.com/in/nagy-anna",
        "https://linkedin.com.evil.test/in/nagy-anna",
      ]) {
        expect(gate.test(refused), `${name} should refuse ${refused}`).toBe(false);
      }
    }
  });

  it("ships the licence and privacy policy", async () => {
    const pkg = await buildExtensionPackage();
    const dir = mkdtempSync(join(tmpdir(), "ext-"));
    const zipPath = join(dir, "e.zip");
    writeFileSync(zipPath, pkg.zip);
    const listing = execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8" });
    expect(listing).toContain("PRIVACY.md");
    expect(listing).toContain("LICENSE");
  });
});

/**
 * PACKAGING MUST NOT DELETE WHAT THE MANIFEST DECLARES.
 *
 * The packager templates the manifest for the deployment that serves it — the
 * app's own origin in `host_permissions`, and a bridge content script so the app
 * can talk to its extension. Both were written with `=`, which silently discarded
 * everything the checked-in manifest declared.
 *
 * The passive observer registers two content scripts on linkedin.com at
 * document_start plus a host permission to match. The DOWNLOADED extension had
 * neither. Nothing failed and nothing warned: the extension installed, the popup
 * worked, and the content script simply was not there — which from the outside
 * looks exactly like "Chrome did not inject it", and cost a diagnostic round trip
 * before the packaged manifest was read instead of the source one.
 *
 * These assertions are on the PACKAGED artifact, because that is the file that
 * ends up in a browser. The source manifest was correct the whole time.
 */
describe("the packaged manifest keeps what the repository declared", () => {
  async function packagedManifest(): Promise<Record<string, unknown>> {
    const { buildExtensionPackage } = await import("../../src/modules/extension/package");
    const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
    const { execFileSync } = await import("node:child_process");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const pkg = await buildExtensionPackage();
    const dir = mkdtempSync(join(tmpdir(), "ext-manifest-"));
    try {
      const zipPath = join(dir, pkg.filename);
      writeFileSync(zipPath, pkg.zip);
      execFileSync("unzip", ["-o", "-q", zipPath, "-d", dir]);
      return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("still registers the observer on linkedin.com after packaging", async () => {
    const m = await packagedManifest();
    const scripts = (m.content_scripts ?? []) as { js: string[]; matches: string[]; run_at: string; world?: string }[];
    const main = scripts.find((c) => c.js?.includes("observer-main.js"));
    const bridge = scripts.find((c) => c.js?.includes("observer-bridge.js"));

    expect(main, "observer-main.js was dropped by packaging").toBeTruthy();
    expect(bridge, "observer-bridge.js was dropped by packaging").toBeTruthy();
    // document_start is the whole point: the patch must beat the page's first request.
    expect(main!.run_at).toBe("document_start");
    expect(main!.world).toBe("MAIN");
    expect(bridge!.run_at).toBe("document_start");
    expect(main!.matches).toContain("*://*.linkedin.com/*");
  });

  it("keeps the linkedin host permission the observer needs", async () => {
    const m = await packagedManifest();
    expect(m.host_permissions as string[]).toContain("*://*.linkedin.com/*");
  });

  it("still adds the app's own origin, which is what the templating is for", async () => {
    const m = await packagedManifest();
    const hosts = m.host_permissions as string[];
    // Whatever APP_URL is in this environment, its origin is present…
    expect(hosts.some((h) => h.endsWith("/*") && !h.includes("linkedin"))).toBe(true);
    // …and the bridge content script with it.
    const scripts = (m.content_scripts ?? []) as { js: string[] }[];
    expect(scripts.some((c) => c.js?.includes("bridge.js"))).toBe(true);
  });

  it("adds the bridge exactly once, however many times it is packaged", async () => {
    const m = await packagedManifest();
    const scripts = (m.content_scripts ?? []) as { js: string[] }[];
    const bridges = scripts.filter((c) => c.js?.includes("bridge.js"));
    expect(bridges).toHaveLength(1);
  });

  it("does not duplicate a host permission either", async () => {
    const m = await packagedManifest();
    const hosts = m.host_permissions as string[];
    expect(new Set(hosts).size).toBe(hosts.length);
  });
});
