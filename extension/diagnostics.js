/**
 * Diagnostics v3 — the report a capture leaves behind.
 *
 * Its own file so it can be tested. It used to live in popup.js, which registers
 * DOM listeners at the top level and therefore cannot be loaded outside a popup —
 * so the one function whose output is the entire evidence trail for every capture
 * bug had no test. That is how `machine: null, cleanup: null, contact: null,
 * photo: null` shipped and stayed: four structurally-absent fields, which read as
 * four steps that failed when in truth they were never invoked.
 *
 * `chrome.runtime.getManifest()` is read through a guard so the module can be
 * exercised outside an extension context.
 */
(() => {
/**
 * The capture's account of itself, version 3.
 *
 * Per field: whether it has a value, WHICH SELECTOR TIER answered, which
 * provenance source it came from, every strategy attempted with how each ended,
 * and the reason if it was declined.
 *
 * Tier and source are different questions and both matter. `source` says where a
 * value came from conceptually — the card, the page title, the overlay. `tier`
 * says which CLASS of selector found it: the framework's own componentkey, page
 * structure, or a text label. A field quietly sliding from componentkey down to
 * text-label is the early warning that LinkedIn has changed something, and it is
 * invisible unless recorded.
 *
 * Built once and used twice: the "Copy diagnostics" button shows it, and a capture
 * sends it so the LEAD can explain itself weeks later. Both previous rounds of this
 * bug began by asking the operator to reproduce something, because the only record
 * had been a popup message that closed.
 */
function buildDiagnostics(payload, extras) {
  const p = payload ?? {};
  const provenance = p.provenance ?? {};
  const attempts = p._attempts ?? {};
  const skipped = p.skipped ?? {};
  const FIELDS = [
    "name", "headline", "companyName", "location", "jobTitle",
    "bio", "photoUrl", "email", "phone", "websiteUrl",
  ];

  const TIERS = [
    "componentkey", "structure", "text-label",
    "title", "topcard", "overlay", "derived",
  ];
  const tierOf = (field) => {
    for (const entry of attempts[field] ?? []) {
      const [name, outcome] = String(entry).split(":");
      if (outcome === "accepted" && TIERS.includes(name)) return name;
    }
    return null;
  };

  /**
   * The three fields the READER never supplies.
   *
   * Email, phone and website are not on the profile page at all — the probes
   * measured zero mailto: links, zero tel: links and no outbound hosts — so they
   * come from the contact overlay via the machine. That left them with no
   * `attempted` entries and no reason code, so the report said nothing whatsoever
   * about why they were empty: the single most common question about a capture,
   * structurally unanswerable. They inherit the contact step's outcome instead.
   */
  const FROM_OVERLAY = new Set(["email", "phone", "websiteUrl"]);
  const contactReason = (() => {
    if (extras?.contact?.note) return String(extras.contact.note);
    const step = (extras?.machine?.steps ?? []).find((s) => s.name === "READ_CONTACT");
    if (step && !step.ok && step.reason) return String(step.reason);
    const open = (extras?.machine?.steps ?? []).find((s) => s.name === "OPEN_CONTACT");
    if (open && !open.ok && open.reason) return String(open.reason);
    if (extras?.machine) return "overlay_not_read";
    return null;
  })();

  const fields = {};
  for (const f of FIELDS) {
    const present = p[f] !== undefined && p[f] !== null && p[f] !== "";
    fields[f] = {
      present,
      tier: tierOf(f),
      source: provenance[f]?.source ?? null,
      confidence: provenance[f]?.confidence ?? null,
      attempted: attempts[f] ?? [],
      skippedBecause:
        skipped[f] ?? (!present && FROM_OVERLAY.has(f) ? contactReason : null) ?? null,
    };
  }

  return {
    diagnoseVersion: 3,
    extension: (() => {
      try {
        return chrome.runtime.getManifest().version;
      } catch {
        return null;
      }
    })(),
    fields,
    boundary: p.boundary ?? null,
    postsRead: (p.posts ?? []).length,
    /**
     * Which steps ran, how long each took, and where it stopped. Without this a
     * partial capture is indistinguishable from a broken one.
     */
    machine: extras?.machine ?? null,
    /**
     * Whether the page was actually put back — popovers closed, URL restored,
     * focus restored. Reported rather than assumed: "we called hidePopover" and
     * "the popover is closed" are different claims, and the manual-popover hang
     * was the second one being false.
     */
    cleanup: extras?.cleanup ?? null,
    contact: extras?.contact ?? null,
    photo: extras?.photo ?? null,
    /** Which sections were mounted after scrolling, and whether About expanded. */
    sections: extras?.sections ?? null,
    bioExpansion: extras?.bioExpansion ?? null,
  };
}

  globalThis.VentureDiagnostics = { buildDiagnostics };
})();
