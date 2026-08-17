import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  extensionReadiness,
  requestLinkedInPermission,
} from "../../src/lib/extension-bridge";
import { stripComments } from "../helpers/strip-comments";

/**
 * The four permission states, and the dead end they replace.
 *
 * The reported symptom was "The extension needs permission to read LinkedIn
 * pages", with a message telling the user to open the popup — where no such
 * control existed. The root cause was simpler than it looked: LinkedIn access is
 * declared in `optional_host_permissions`, so it is not granted at install, and
 * NOTHING in the extension ever called `chrome.permissions.request()` for it.
 * A permission with no request path can only ever be missing.
 *
 * These tests cover the four states the app must tell apart, because collapsing
 * them into one failure is what made the problem unfixable from the user's side.
 */

/** A postMessage bridge stand-in: whatever the extension would have replied. */
function withBridge(reply: Record<string, unknown> | null) {
  const listeners: Array<(e: MessageEvent) => void> = [];
  const win = {
    location: { origin: "https://app.test", href: "https://app.test/leads" },
    addEventListener: (_t: string, fn: (e: MessageEvent) => void) => listeners.push(fn),
    removeEventListener: (_t: string, fn: (e: MessageEvent) => void) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    postMessage: (msg: { id: string }) => {
      // A missing extension never answers — silence is the signal.
      if (reply === null) return;
      setTimeout(() => {
        for (const fn of [...listeners]) {
          fn({
            source: win,
            origin: "https://app.test",
            data: { __venture: "response", id: msg.id, res: reply },
          } as unknown as MessageEvent);
        }
      }, 0);
    },
  };
  vi.stubGlobal("window", win);
  return win;
}

// A plain static import is enough: the bridge reads `window` at CALL time, so
// the stub installed by withBridge() is the one it uses.
const readiness = () => extensionReadiness();

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the four states", () => {
  it("reports not_installed when nothing answers", async () => {
    withBridge(null);
    await expect(readiness()).resolves.toEqual({ state: "not_installed" });
  });

  it("reports not_configured when it is installed but has no address or token", async () => {
    withBridge({ ok: true, installed: true, version: "3.5.0", configured: false, linkedInPermission: false });
    await expect(readiness()).resolves.toEqual({ state: "not_configured", version: "3.5.0" });
  });

  it("reports needs_linkedin_permission — the state that used to be a dead end", async () => {
    withBridge({ ok: true, installed: true, version: "3.5.0", configured: true, linkedInPermission: false });
    await expect(readiness()).resolves.toEqual({
      state: "needs_linkedin_permission",
      version: "3.5.0",
    });
  });

  it("reports ready only when configured AND permitted", async () => {
    withBridge({ ok: true, installed: true, version: "3.5.0", configured: true, linkedInPermission: true });
    await expect(readiness()).resolves.toEqual({ state: "ready", version: "3.5.0" });
  });

  it("never reports ready on a partial answer", async () => {
    // Fail closed: a reply missing a field must not read as permission granted.
    for (const reply of [
      { ok: true },
      { ok: true, configured: true },
      { ok: false, configured: true, linkedInPermission: true },
    ]) {
      withBridge(reply);
      const r = await readiness();
      expect(r.state).not.toBe("ready");
      vi.unstubAllGlobals();
    }
  });
});

describe("requesting the permission", () => {
  it("reports success and whether it was already granted", async () => {
    withBridge({ ok: true, alreadyGranted: true });
    await expect(requestLinkedInPermission()).resolves.toEqual({
      ok: true,
      alreadyGranted: true,
    });
  });

  it("reports not-installed rather than hanging when nothing answers", async () => {
    withBridge(null);
    const r = await requestLinkedInPermission();
    expect(r.ok).toBe(false);
  });
});

/**
 * The mechanics, asserted against the shipped source. These cannot be unit-tested
 * behaviourally without a browser, so what is checked is that the pieces which
 * make the flow possible are present and wired the right way round.
 */
describe("the grant flow's mechanics", () => {
  const read = (f: string) => readFileSync(join(process.cwd(), "extension", f), "utf8");
  /** Comments are documentation, not calls. Explaining the rule is not breaking it. */
  const code = (f: string) => stripComments(read(f));
  const background = read("background.js");
  const permissionPage = read("permission.js");
  const popup = read("popup.js");
  const manifest = JSON.parse(read("manifest.json"));

  it("asks for linkedin.com somewhere, which is the bug that started this", () => {
    // Before this change, no file in the extension requested LinkedIn access.
    const requesters = ["permission.js", "popup.js"].filter(
      (f) => /permissions\.request\(/.test(code(f)) && /linkedin\.com/.test(code(f)),
    );
    expect(requesters.length).toBeGreaterThan(0);
  });

  it("requests it from inside the extension, never from the web page", () => {
    // chrome.permissions.request() is only honoured from a gesture in an
    // extension context, so the app can only ever OPEN the page that asks.
    expect(code("permission.js")).toMatch(/permissions\.request\(/);
    expect(code("popup.js")).toMatch(/permissions\.request\(/);
    // The service worker opens the page; it does not attempt the request itself.
    expect(code("background.js")).toMatch(/permission\.html/);
    expect(code("background.js")).not.toMatch(/permissions\.request\(/);
  });

  /**
   * A DELIBERATE REVERSAL, recorded rather than deleted.
   *
   * This used to assert the opposite: LinkedIn access was OPTIONAL so that
   * installing the extension prompted for nothing, and a paste-only user was never
   * asked for anything. That was the right trade while the extension only read the
   * DOM on demand.
   *
   * The passive observer cannot work that way. It has to patch the page's `fetch`
   * BEFORE the page issues its first request, which means a content script
   * declared in the manifest at `document_start` — and a declared content script
   * requires a declared host permission. A dynamically registered script cannot
   * reliably win that race, and losing it means observing nothing.
   *
   * So the install now asks for linkedin.com. The cost is one permission prompt at
   * install; what it buys is the whole re-architecture. The permission remains
   * narrow — one host, no cookies, no webRequest — and the grant flow is kept
   * because it still answers "is this working" for a user whose install predates
   * the change.
   */
  it("declares LinkedIn access, which document_start observation requires", () => {
    expect(JSON.stringify(manifest.host_permissions ?? [])).toContain("linkedin");
    const scripts = manifest.content_scripts ?? [];
    expect(scripts.length).toBeGreaterThan(0);
    for (const cs of scripts) {
      expect(cs.matches).toEqual(["*://*.linkedin.com/*"]);
      // The whole reason the permission had to be declared.
      expect(cs.run_at).toBe("document_start");
    }
  });

  it("registers the profile content script dynamically, after the grant", () => {
    // The counterpart of keeping it optional: the script cannot be declared, so
    // it is registered once permission exists.
    expect(background).toMatch(/registerContentScripts/);
    expect(background).toMatch(/venture-profile-panel/);
    expect(permissionPage).toMatch(/registerProfileScript/);
  });

  it("exposes status through the bridge but not the ability to grant", () => {
    const bridge = read("bridge.js");
    expect(bridge).toContain('"status"');
    expect(bridge).toContain('"requestLinkedInPermission"');
    // The page may ask for the tab to be opened; it can never grant.
    expect(bridge).not.toContain('"registerProfileScript"');
  });

  it("reports the permission gap as actionable, not as a closed door", () => {
    const bridgeTs = readFileSync(
      join(process.cwd(), "src/lib/extension-bridge.ts"),
      "utf8",
    );
    // The old copy sent the user to a popup control that did not exist.
    expect(bridgeTs).not.toMatch(/Open its popup and allow it/);
    expect(bridgeTs).toMatch(/has not been allowed to read LinkedIn pages yet/);
  });
});
