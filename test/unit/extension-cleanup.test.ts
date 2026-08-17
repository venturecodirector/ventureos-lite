import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";

/**
 * The hang, and the guarantee that the page is put back.
 *
 * LinkedIn's overlays are native popovers in `manual` state. A manual popover
 * does not close on Escape and does not close on an outside click — the two
 * dismissals any overlay routine reaches for, both no-ops here. So the capture
 * opened something and waited for a close that could never arrive. The wait was
 * the bug.
 *
 * These tests assert the property that matters: after a capture — successful,
 * failed, timed out, or thrown — nothing WE opened is still open, no inert we set
 * remains, and the URL, scroll and focus are back.
 */
const CLEANUP = readFileSync(join(process.cwd(), "extension/cleanup.js"), "utf8");

interface Session {
  openedPopovers: Set<Element>;
  inertedByUs: Set<Element>;
  originalUrl: string;
  cleanedUp: boolean;
  log: string[];
}
interface Cleanup {
  createSession(win: Window): Session;
  trackOpened(s: Session, el: Element | null): Element | null;
  openPopover(s: Session, el: Element | null): boolean;
  closePopover(el: Element | null): string | null;
  isOpen(el: Element): boolean;
  cleanup(s: Session, opts?: { urlTimeoutMs?: number }): Promise<{ ok: boolean; steps: string[] }>;
  verify(s: Session): {
    popoversWeOpened: number;
    stillOpen: number;
    inertRemaining: number;
    urlRestored: boolean;
    scrollRestored: boolean;
    focusRestored: boolean;
    cleanedUp: boolean;
  } | null;
  waitFor(p: () => boolean, ms: number, win: Window): Promise<boolean>;
}

/**
 * A page with two manual popovers and an inert element, which is the shape the
 * real fixtures have (2 × popover="manual", 2 × inert).
 */
function page() {
  const dom = new JSDOM(
    `<!doctype html><html><body>
       <main><button id="trigger">Contact info</button><input id="focusable"></main>
       <div id="ours" role="dialog" data-testid="popover-floating" popover="manual">ours</div>
       <div id="theirs" role="dialog" popover="manual">LinkedIn's own</div>
       <div id="inerted">content</div>
     </body></html>`,
    { url: "https://www.linkedin.com/in/someone/", pretendToBeVisual: true },
  );
  const w = dom.window as unknown as Window & { VentureCleanup: Cleanup };
  // jsdom has no layout, so scrollTo is unimplemented and logs to stderr. Stub it
  // to a real position change so the restore is actually exercised rather than
  // passing because nothing ever moved.
  let sx = 0;
  let sy = 0;
  Object.defineProperty(w, "scrollX", { get: () => sx, configurable: true });
  Object.defineProperty(w, "scrollY", { get: () => sy, configurable: true });
  Object.defineProperty(w, "scrollTo", {
    value: (x: number, y: number) => {
      sx = x;
      sy = y;
    },
    configurable: true,
  });
  // jsdom has no popover API, which is realistic enough: the fallbacks are what
  // run on any engine that lacks it, and they must work.
  new Function("window", "globalThis", CLEANUP)(w, w);
  return { w, C: w.VentureCleanup, doc: w.document };
}

describe("closing a manual popover", () => {
  it("uses hidePopover when the engine has it", () => {
    const { doc, C } = page();
    const el = doc.getElementById("ours")!;
    let called = false;
    (el as unknown as { hidePopover: () => void }).hidePopover = () => {
      called = true;
    };
    expect(C.closePopover(el)).toBe("hidePopover");
    expect(called).toBe(true);
  });

  it("falls back to removing the popover attribute when hidePopover is absent", () => {
    // The path that runs where the native API is missing. Without a fallback the
    // element stays open for ever, which is the original bug in a new costume.
    const { doc, C } = page();
    const el = doc.getElementById("ours")!;
    expect(C.closePopover(el)).toBe("removeAttribute");
    expect(el.hasAttribute("popover")).toBe(false);
  });

  it("falls back to removing the element when even that fails", () => {
    const { doc, C } = page();
    const el = doc.getElementById("ours")!;
    el.removeAttribute("popover");
    expect(C.closePopover(el)).toBe("remove");
    expect(doc.getElementById("ours")).toBeNull();
  });

  it("never throws, whatever it is handed", () => {
    const { C } = page();
    expect(() => C.closePopover(null)).not.toThrow();
    expect(() => C.closePopover({} as unknown as Element)).not.toThrow();
  });

  it("is safe to call twice", () => {
    const { doc, C } = page();
    const el = doc.getElementById("ours")!;
    C.closePopover(el);
    expect(() => C.closePopover(el)).not.toThrow();
  });
});

describe("only what we opened", () => {
  it("leaves LinkedIn's own popovers strictly alone", async () => {
    // Closing a popover the user opened for their own reasons would be us
    // breaking their page rather than tidying up after ourselves.
    const { doc, C, w } = page();
    const ours = doc.getElementById("ours")!;
    const theirs = doc.getElementById("theirs")!;
    const s = C.createSession(w);
    C.trackOpened(s, ours);

    await C.cleanup(s);

    expect(ours.hasAttribute("popover")).toBe(false);
    expect(theirs.hasAttribute("popover")).toBe(true);
    expect(theirs.isConnected).toBe(true);
  });

  it("removes only inert attributes it set itself", async () => {
    const { doc, C, w } = page();
    const mine = doc.getElementById("inerted")!;
    const notMine = doc.getElementById("theirs")!;
    notMine.setAttribute("inert", "");
    const s = C.createSession(w);
    mine.setAttribute("inert", "");
    s.inertedByUs.add(mine);

    await C.cleanup(s);

    expect(mine.hasAttribute("inert")).toBe(false);
    expect(notMine.hasAttribute("inert")).toBe(true);
  });
});

describe("cleanup restores the page", () => {
  it("puts scroll and focus back", async () => {
    const { doc, C, w } = page();
    const input = doc.getElementById("focusable") as HTMLInputElement;
    input.focus();
    const s = C.createSession(w);
    // Something else takes focus and the page scrolls, as an overlay would.
    (doc.getElementById("trigger") as HTMLElement).focus();
    w.scrollTo(0, 900);
    expect(w.scrollY).toBe(900);

    await C.cleanup(s);

    const v = C.verify(s)!;
    expect(v.focusRestored).toBe(true);
    expect(v.scrollRestored).toBe(true);
  });

  it("restores an /overlay/ URL with history.back()", async () => {
    // The contact route is a real history entry, so the way back is back() — not
    // clicking an X that does not exist in a manual popover.
    const { C, w } = page();
    const s = C.createSession(w);
    const original = s.originalUrl;
    w.history.pushState({}, "", "/in/someone/overlay/contact-info/");
    expect(w.location.href).not.toBe(original);

    const r = await C.cleanup(s, { urlTimeoutMs: 300 });

    expect(r.steps.join(" ")).toContain("url:history.back");
    expect(w.location.href).toBe(original);
    expect(C.verify(s)!.urlRestored).toBe(true);
  });

  it("reports honestly when the URL could not be restored", async () => {
    // "We called back()" and "the URL is back" are different claims, and the
    // diagnostics must carry the second one.
    const { C, w } = page();
    const s = C.createSession(w);
    w.history.pushState({}, "", "/feed/");
    // Not an /overlay/ route, so pushState is used; then break it.
    Object.defineProperty(w.history, "pushState", {
      value: () => {
        throw new Error("blocked");
      },
      configurable: true,
    });
    const r = await C.cleanup(s, { urlTimeoutMs: 100 });
    expect(r.steps.join(" ")).toMatch(/url:(NOT_restored|threw)/);
    expect(C.verify(s)!.urlRestored).toBe(false);
  });
});

describe("cleanup is idempotent and survives failure", () => {
  it("runs to completion twice with the same result", async () => {
    const { doc, C, w } = page();
    const s = C.createSession(w);
    C.trackOpened(s, doc.getElementById("ours"));

    const first = await C.cleanup(s);
    const second = await C.cleanup(s);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(C.verify(s)!.stillOpen).toBe(0);
  });

  it("leaves nothing open when a capture THROWS mid-flight", async () => {
    // The finally-block guarantee. This is the case the original code got wrong:
    // an exception skipped the close and the popover stayed up for ever.
    const { doc, C, w } = page();
    const s = C.createSession(w);
    let threw = false;
    try {
      C.trackOpened(s, doc.getElementById("ours"));
      throw new Error("step blew up");
    } catch {
      threw = true;
    } finally {
      await C.cleanup(s);
    }
    expect(threw).toBe(true);
    const v = C.verify(s)!;
    expect(v.stillOpen).toBe(0);
    expect(v.cleanedUp).toBe(true);
  });

  it("leaves nothing open when a step TIMES OUT", async () => {
    const { doc, C, w } = page();
    const s = C.createSession(w);
    C.trackOpened(s, doc.getElementById("ours"));

    // A wait that can never succeed — the shape of the original hang.
    const settled = await C.waitFor(() => false, 120, w);
    expect(settled).toBe(false);

    await C.cleanup(s);
    expect(C.verify(s)!.stillOpen).toBe(0);
  });

  it("a stuck popover does not cost the scroll position", async () => {
    // Each step is independently guarded, so one failure cannot cascade.
    const { doc, C, w } = page();
    const s = C.createSession(w);
    const el = doc.getElementById("ours")!;
    // Make every close mechanism fail.
    Object.defineProperty(el, "hidePopover", {
      value: () => {
        throw new Error("no");
      },
    });
    Object.defineProperty(el, "removeAttribute", {
      value: () => {
        throw new Error("no");
      },
    });
    Object.defineProperty(el, "remove", {
      value: () => {
        throw new Error("no");
      },
    });
    C.trackOpened(s, el);

    const r = await C.cleanup(s);
    expect(r.steps).toContain("popover:failed");
    expect(r.steps).toContain("scroll:restored");
    expect(C.verify(s)!.scrollRestored).toBe(true);
  });
});

describe("waitFor never hangs", () => {
  it("resolves false on timeout rather than waiting for ever", async () => {
    const { C, w } = page();
    const started = Date.now();
    const ok = await C.waitFor(() => false, 150, w);
    expect(ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("resolves true as soon as the condition holds", async () => {
    const { C, w } = page();
    let flag = false;
    w.setTimeout(() => {
      flag = true;
    }, 60);
    expect(await C.waitFor(() => flag, 2000, w)).toBe(true);
  });

  it("treats a throwing predicate as not-yet rather than crashing", async () => {
    const { C, w } = page();
    expect(
      await C.waitFor(() => {
        throw new Error("x");
      }, 120, w),
    ).toBe(false);
  });
});
