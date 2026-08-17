import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";

/**
 * The contact-info overlay in LinkedIn's CURRENT shape — fixture (f).
 *
 * Fixture (c) covers the old `artdeco-modal`. This covers the one the parser will
 * actually meet, and the two properties that broke the capture:
 *
 *   1. `popover="manual"`, against which Escape and outside clicks are documented
 *      no-ops. Only hidePopover() closes it. Waiting for Escape to work was the
 *      hang.
 *   2. A trigger that is an ANCHOR to /overlay/contact-info/, so pressing it
 *      NAVIGATES. Not restoring the URL is what left the next capture reading an
 *      overlay route as though it were a profile.
 */
const EXT = join(process.cwd(), "extension");
const FIXTURE = join(process.cwd(), "test/fixtures/linkedin/f-contact-info-sdui-popover.html");

const FILES = {
  selectors: readFileSync(join(EXT, "selectors.js"), "utf8"),
  names: readFileSync(join(EXT, "names.js"), "utf8"),
  cleanup: readFileSync(join(EXT, "cleanup.js"), "utf8"),
  contactParse: readFileSync(join(EXT, "contact-parse.js"), "utf8"),
  machine: readFileSync(join(EXT, "machine.js"), "utf8"),
  content: readFileSync(join(EXT, "content.js"), "utf8"),
};

const OWNER = "anonimizalt-odon-scrubbed";

function page(url = `https://www.linkedin.com/in/${OWNER}/`) {
  const dom = new JSDOM(readFileSync(FIXTURE, "utf8"), { url });
  let scrollY = 0;
  Object.defineProperty(dom.window, "scrollY", { get: () => scrollY, configurable: true });
  dom.window.scrollTo = ((_x: number, y: number) => {
    scrollY = typeof y === "number" ? y : 0;
  }) as typeof dom.window.scrollTo;
  const g: Record<string, unknown> = {};
  for (const src of [
    FILES.selectors,
    FILES.names,
    FILES.cleanup,
    FILES.contactParse,
    FILES.machine,
  ]) {
    new Function("globalThis", "window", "document", src)(g, dom.window, dom.window.document);
  }
  return { dom, g };
}

interface Entries {
  email: string[];
  phone: { raw: string; qualifier: string | null }[];
  website: { url: string; qualifier: string | null }[];
  other: Record<string, string>;
}
type Parse = {
  findModal(): Element | null;
  findTrigger(): Element | null;
  parseModal(el: Element | null): Entries;
};

describe("parsing the SDUI popover", () => {
  it("finds the dialog by its heading, through the hashed class names", () => {
    const { g } = page();
    const modal = (g.VentureContact as Parse).findModal();
    expect(modal).not.toBeNull();
    expect(modal!.getAttribute("data-testid")).toBe("popover-floating");
    expect(modal!.getAttribute("popover")).toBe("manual");
  });

  it("reads email, phone and both websites out of it", () => {
    const { g } = page();
    const C = g.VentureContact as Parse;
    const e = C.parseModal(C.findModal());
    expect(e.email).toEqual(["Odon.Anonimizalt@Seyu.IO"]);
    expect(e.phone[0]!.raw).toBe("06 1 234 5678");
    expect(e.website.map((w) => w.url)).toEqual(["https://seyu.io", "https://odon.example"]);
  });

  /**
   * The fixture puts the birthday BEFORE the phone on purpose. Position-based
   * parsing would file "március 14." as a phone number.
   */
  it("maps by label, so a Hungarian birthday never becomes a phone number", () => {
    const { g } = page();
    const C = g.VentureContact as Parse;
    const e = C.parseModal(C.findModal());
    expect(e.other.birthday).toContain("március");
    for (const p of e.phone) expect(p.raw).not.toContain("március");
    expect(e.phone).toHaveLength(1);
  });

  it("finds the trigger, which is an anchor to the overlay ROUTE", () => {
    const { g } = page();
    const trigger = (g.VentureContact as Parse).findTrigger()!;
    expect(trigger).not.toBeNull();
    expect(trigger.getAttribute("href")).toContain("/overlay/contact-info/");
    // An anchor, not a button — which is why pressing it navigates.
    expect(trigger.tagName).toBe("A");
  });
});

describe("the manual popover", () => {
  it("does NOT close on Escape — the assumption behind the hang", () => {
    const { dom, g } = page();
    const C = g.VentureContact as Parse;
    const modal = C.findModal()!;
    dom.window.document.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    // Still there. Nothing about a manual popover responds to this.
    expect(C.findModal()).not.toBeNull();
    expect(modal.isConnected).toBe(true);
  });

  it("closes through the cleanup module, which knows the right mechanism", () => {
    const { g } = page();
    const C = g.VentureContact as Parse;
    const CU = g.VentureCleanup as {
      closePopover(el: Element): string | null;
      isOpen(el: Element): boolean;
    };
    const modal = C.findModal()!;
    const how = CU.closePopover(modal);
    // jsdom has no hidePopover, so the documented fallback runs and is reported.
    expect(how).toBeTruthy();
    expect(CU.isOpen(modal)).toBe(false);
  });
});

describe("the dialog's contents are not the profile's fields", () => {
  /**
   * The overlay is open on this page. Extraction must still read the profile —
   * and must not take a single field, or an identity, from inside the dialog.
   */
  it("extracts the profile with one identity while a dialog is open", () => {
    const { dom, g } = page();
    const fn = new Function(
      "document",
      "window",
      "location",
      "URL",
      "globalThis",
      `return (${FILES.content.trim().replace(/;\s*$/, "")})`,
    );
    const out = fn(
      dom.window.document,
      dom.window,
      dom.window.location,
      dom.window.URL,
      g,
    ) as {
      name?: string;
      headline?: string;
      email?: string;
      boundary: { ok: boolean; identitiesInCard: number | null };
      flags: string[];
    };

    expect(out.boundary.ok).toBe(true);
    expect(out.boundary.identitiesInCard).toBe(1);
    expect(out.name).toBe("Anonimizált Ödön");
    expect(out.headline).toBe("CEO at Seyu");
    // content.js never supplies contact details: they come from the overlay read,
    // via the machine, so that "this file only reads the profile" stays true.
    expect(out.email).toBeUndefined();
  });

  it("refuses entirely when the page is left on the overlay route", () => {
    const { dom, g } = page(`https://www.linkedin.com/in/${OWNER}/overlay/contact-info/`);
    const fn = new Function(
      "document",
      "window",
      "location",
      "URL",
      "globalThis",
      `return (${FILES.content.trim().replace(/;\s*$/, "")})`,
    );
    const out = fn(
      dom.window.document,
      dom.window,
      dom.window.location,
      dom.window.URL,
      g,
    ) as { refused: boolean; route: { reason: string | null }; name?: string };
    expect(out.refused).toBe(true);
    expect(out.route.reason).toBe("on_an_overlay_route");
    expect(out.name).toBeUndefined();
  });
});

describe("the machine, end to end, against an already-open overlay", () => {
  it("reads the details and leaves the dialog it did not open alone", async () => {
    const { dom, g } = page();
    const machine = g.VentureMachine as {
      run(o: Record<string, unknown>): Promise<{
        machine: {
          steps: { name: string; ok: boolean; reason: string | null; detail?: unknown }[];
          cleanupVerified: { stillOpen: number; urlRestored: boolean; cleanedUp: boolean } | null;
        };
        contact: Entries | null;
      }>;
    };
    const result = await machine.run({
      globalMs: 4_000,
      routeMs: 200,
      topcardMs: 200,
      openContactMs: 200,
      readContactMs: 200,
      closeContactMs: 200,
      expandBioMs: 200,
      loadSectionsMs: 400,
      readPostsMs: 200,
      scrollSettleMs: 10,
      scrollMaxSteps: 2,
      window: dom.window,
      document: dom.window.document,
    });

    // It read the overlay that was already up.
    expect(result.contact).not.toBeNull();
    expect(result.contact!.email).toEqual(["Odon.Anonimizalt@Seyu.IO"]);

    const byName = Object.fromEntries(result.machine.steps.map((s) => [s.name, s]));
    expect(byName.READ_CONTACT!.ok).toBe(true);

    /**
     * AND IT DID NOT CLOSE IT. We did not open this dialog — LinkedIn or the
     * operator did — so closing it would be us breaking the page they are using
     * rather than tidying up after ourselves.
     */
    expect(byName.CLOSE_CONTACT!.detail).toMatchObject({ weOpenedIt: false });
    expect((g.VentureContact as Parse).findModal()).not.toBeNull();
    // Nothing of ours was left behind either way.
    expect(result.machine.cleanupVerified!.stillOpen).toBe(0);
    expect(result.machine.cleanupVerified!.cleanedUp).toBe(true);
  });

  it("opens, reads, closes and restores the URL when it IS the one opening", async () => {
    const { dom, g } = page();
    const doc = dom.window.document;
    // Start with the overlay absent, as a real profile does, and let the trigger
    // reveal it — the actual sequence, including the navigation the anchor causes.
    const modal = doc.querySelector('[data-testid="popover-floating"]')!;
    modal.remove();
    const trigger = doc.querySelector('a[href*="/overlay/contact-info/"]')!;
    trigger.addEventListener("click", () => {
      doc.body.appendChild(modal);
      // The anchor navigates: that is what put the page on an overlay route.
      dom.window.history.pushState({}, "", `/in/${OWNER}/overlay/contact-info/`);
    });

    const machine = g.VentureMachine as {
      run(o: Record<string, unknown>): Promise<{
        machine: {
          steps: { name: string; ok: boolean; detail?: unknown }[];
          cleanupVerified: { stillOpen: number; urlRestored: boolean } | null;
        };
        contact: Entries | null;
      }>;
    };
    const result = await machine.run({
      globalMs: 4_000,
      routeMs: 300,
      topcardMs: 200,
      openContactMs: 400,
      readContactMs: 200,
      closeContactMs: 400,
      expandBioMs: 200,
      loadSectionsMs: 400,
      readPostsMs: 200,
      scrollSettleMs: 10,
      scrollMaxSteps: 2,
      window: dom.window,
      document: doc,
    });

    const byName = Object.fromEntries(result.machine.steps.map((s) => [s.name, s]));
    expect(byName.OPEN_CONTACT!.ok).toBe(true);
    expect(byName.OPEN_CONTACT!.detail).toMatchObject({ weOpenedIt: true });
    expect(result.contact!.email).toEqual(["Odon.Anonimizalt@Seyu.IO"]);

    // THE REGRESSION: closed, and the URL back on the profile.
    expect(byName.CLOSE_CONTACT!.ok).toBe(true);
    expect(dom.window.location.pathname).toBe(`/in/${OWNER}/`);
    expect(result.machine.cleanupVerified!.stillOpen).toBe(0);
    expect(result.machine.cleanupVerified!.urlRestored).toBe(true);
  });
});
