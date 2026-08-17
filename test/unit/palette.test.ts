import { describe, it, expect } from "vitest";
import {
  GOTO_MAP,
  MAX_RECENTS,
  PALETTE_ACTIONS,
  matchActions,
  pushRecent,
  readRecents,
  type RecentItem,
} from "../../src/modules/search/palette";

/**
 * The command palette's non-search half (playbook-v2 P7/3).
 *
 * The entity results come from the P3/1 search API, which has its own tests.
 * These are about the verbs: that typing narrows, that the `g` map cannot drift
 * from the help overlay, and that the recents list survives a hostile
 * localStorage.
 */
describe("action matching", () => {
  it("finds an action by the start of its label", () => {
    const [first] = matchActions("new le");
    expect(first.id).toBe("new-lead");
  });

  it("finds one by a synonym nobody would guess the label from", () => {
    expect(matchActions("csv").map((a) => a.id)).toContain("import");
    expect(matchActions("kanban").map((a) => a.id)).toContain("go-pipeline");
    expect(matchActions("hotkeys").map((a) => a.id)).toContain("shortcuts");
  });

  it("narrows as a second word is typed, rather than widening", () => {
    const one = matchActions("go");
    const two = matchActions("go pipeline");
    expect(two.length).toBeLessThan(one.length);
    expect(two[0].id).toBe("go-pipeline");
  });

  it("ranks a label match above a mere synonym", () => {
    // "Go to Deals" has the word; several others merely list it as a keyword.
    expect(matchActions("deals")[0].id).toBe("go-deals");
  });

  it("returns nothing for an empty query, so the palette can show recents", () => {
    expect(matchActions("")).toEqual([]);
    expect(matchActions("   ")).toEqual([]);
  });

  it("returns nothing rather than everything for a term that matches nothing", () => {
    expect(matchActions("zzzzz")).toEqual([]);
  });
});

describe("the g-map", () => {
  it("is derived from the action list, so the overlay cannot document a dead key", () => {
    for (const [key, href] of Object.entries(GOTO_MAP)) {
      const action = PALETTE_ACTIONS.find((a) => a.hint === `g ${key}`);
      expect(action, `no action for g ${key}`).toBeTruthy();
      expect(action!.href).toBe(href);
    }
  });

  it("binds each letter once", () => {
    const keys = Object.keys(GOTO_MAP);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("covers the screens the daily loop runs through", () => {
    const hrefs = Object.values(GOTO_MAP);
    for (const href of ["/", "/pipeline", "/inbox", "/calls"]) {
      expect(hrefs, `no g-shortcut for ${href}`).toContain(href);
    }
  });

  it("never binds a letter the bare shortcuts already use", () => {
    // n, t and ? act on their own; a `g` prefix followed by one of them is
    // fine, but the MAP must not claim them as first-level bindings.
    expect(PALETTE_ACTIONS.filter((a) => a.hint === "n")).toHaveLength(1);
    expect(PALETTE_ACTIONS.filter((a) => a.hint === "t")).toHaveLength(1);
  });
});

describe("recents", () => {
  const item = (href: string): RecentItem => ({
    kind: "lead",
    id: href,
    title: `Lead ${href}`,
    subtitle: "",
    href,
    atMs: 1,
  });

  it("puts the newest first and de-duplicates by href", () => {
    const list = pushRecent(pushRecent([item("/a")], item("/b")), item("/a"));
    expect(list.map((r) => r.href)).toEqual(["/a", "/b"]);
  });

  it("stays bounded", () => {
    let list: RecentItem[] = [];
    for (let i = 0; i < 20; i += 1) list = pushRecent(list, item(`/x${i}`));
    expect(list).toHaveLength(MAX_RECENTS);
  });

  it("survives a hostile or absent localStorage value", () => {
    expect(readRecents(null)).toEqual([]);
    expect(readRecents("not json")).toEqual([]);
    expect(readRecents('{"nope":1}')).toEqual([]);
    expect(readRecents('[{"id":1}]')).toEqual([]);
    expect(readRecents(JSON.stringify([item("/a")]))).toHaveLength(1);
  });
});
