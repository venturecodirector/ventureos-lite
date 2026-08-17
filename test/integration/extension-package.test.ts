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
      "selectors.js",
      "cleanup.js",
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

    // Its own server needs no runtime permission prompt.
    expect(manifest.host_permissions).toEqual([`${origin}/*`]);

    // The bridge runs ONLY on the app's origin — never on LinkedIn. That
    // boundary is the whole reason it is safe to let a page talk to it.
    expect(manifest.content_scripts).toEqual([
      { matches: [`${origin}/*`], js: ["bridge.js"], run_at: "document_idle" },
    ]);

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
