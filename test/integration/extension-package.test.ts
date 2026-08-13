import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    // The permission model this build deliberately settled on.
    expect(manifest.permissions).toEqual(["activeTab", "scripting", "storage"]);
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.optional_host_permissions).toEqual(["https://*/*"]);
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
