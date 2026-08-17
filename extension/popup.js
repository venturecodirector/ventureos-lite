/** A page this extension is willing to read: a profile, or a Sales Nav lead. */
const PROFILE_URL =
  /^https:\/\/([a-z-]+\.)?linkedin\.com\/(in\/|sales\/(lead|people)\/)/i;

const $ = (id) => document.getElementById(id);
const msg = (text, cls) => {
  $("msg").textContent = text;
  $("msg").className = `msg ${cls ?? ""}`;
};

function originOf(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

(async () => {
  const { baseUrl, token } = await chrome.storage.local.get(["baseUrl", "token"]);
  // config.js is written at download time with the address of the Venture OS
  // that packaged this build, so the address never has to be typed.
  const injected = globalThis.VENTURE_DEFAULT_BASE_URL ?? "";
  $("baseUrl").value = baseUrl ?? injected;
  $("token").value = token ?? "";

  if (baseUrl && token) {
    // Already configured: say so plainly instead of showing empty-looking
    // fields that invite re-entering what is already saved.
    msg(`Connected to ${baseUrl}. Open a LinkedIn profile and press Capture.`, "ok");
  } else if (!token) {
    $("settings").open = true;
    msg(
      injected
        ? "Paste a capture token from Settings → Extension to start."
        : "Add your Venture OS address and a capture token to start.",
      "muted",
    );
  }
})();


/**
 * Show the LinkedIn-access control only when it is actually missing.
 *
 * The permission is optional, so a paste-only user is never prompted at install
 * — but that means something has to ask, and for a long time nothing did. The
 * popup asked only for the Venture OS origin, so "needs permission to read
 * LinkedIn pages" was a permanent state with no control anywhere that could
 * change it. This is that control.
 */
async function refreshLinkedInPermission() {
  const origins = ["https://www.linkedin.com/*", "https://linkedin.com/*"];
  let granted = false;
  try {
    granted = await chrome.permissions.contains({ origins });
  } catch {
    granted = false;
  }
  $("allow-linkedin").hidden = granted;
  return granted;
}

$("allow-linkedin").addEventListener("click", async () => {
  $("allow-linkedin").disabled = true;
  msg("Waiting for Chrome…");
  try {
    // A click in the popup IS a gesture inside the extension, so the request can
    // be made directly here — unlike from the web app, which needs the separate
    // permission page.
    const granted = await chrome.permissions.request({
      origins: ["https://www.linkedin.com/*", "https://linkedin.com/*"],
    });
    if (!granted) {
      msg("Not granted. Capture cannot read a profile without it.", "err");
      return;
    }
    await chrome.runtime.sendMessage({ type: "registerProfileScript" });
    msg("LinkedIn access granted.", "ok");
    await refreshLinkedInPermission();
  } catch (e) {
    msg(`Chrome refused the request (${String(e?.message ?? e).slice(0, 50)}).`, "err");
  } finally {
    $("allow-linkedin").disabled = false;
  }
});

refreshLinkedInPermission();


/**
 * The auto-prompt toggle.
 *
 * Per user and default ON, because the duplicate-protection warning is the whole
 * point and someone who never sees it cannot benefit from it. Silenceable in one
 * click, because a panel on every profile page is an imposition if you do not
 * want it — and a tool that cannot be turned off gets uninstalled instead.
 */
async function initAutoPrompt() {
  const { autoPrompt = true } = await chrome.storage.local.get(["autoPrompt"]);
  $("auto-prompt").checked = autoPrompt !== false;
}

$("auto-prompt").addEventListener("change", async () => {
  await chrome.storage.local.set({ autoPrompt: $("auto-prompt").checked });
  msg($("auto-prompt").checked ? "Panel enabled on profile pages." : "Panel silenced.", "ok");
});

initAutoPrompt();

$("save").addEventListener("click", async () => {
  const raw = $("baseUrl").value.trim();
  const token = $("token").value.trim();
  const origin = originOf(raw);

  if (!origin || !origin.startsWith("https://")) {
    msg("Enter the full https:// address of your Venture OS.", "err");
    return;
  }
  if (!token.startsWith("vos_cap_")) {
    msg("That does not look like a capture token (it starts with vos_cap_).", "err");
    return;
  }

  // Ask for access to this one origin, at the moment the user names it. The
  // manifest requests no site access up front, so installing the extension
  // grants nothing until you point it somewhere.
  const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
  if (!granted) {
    msg("Without access to that address the extension cannot send captures.", "err");
    return;
  }

  await chrome.storage.local.set({ baseUrl: origin, token });
  msg("Saved. Open a LinkedIn profile and press Capture.", "ok");
});

$("test").addEventListener("click", async () => {
  $("test").disabled = true;
  msg("Checking…");
  try {
    // A deliberately invalid payload: it proves the address, the token and the
    // permission all work without creating a lead. 400 = we got through.
    const res = await chrome.runtime.sendMessage({ type: "capture", payload: { url: "test" } });
    if (res?.error === "not_configured") msg("Save your address and token first.", "err");
    else if (res?.error === "no_permission") msg("Permission for that address was not granted.", "err");
    else if (res?.error === "timeout") msg("No answer from the server.", "err");
    else if (res?.error === "network") msg("Could not reach that address.", "err");
    else if (res?.status === 401) msg("Server reachable, but the token was rejected.", "err");
    else if (res?.status === 400) msg("Connected — address and token are good.", "ok");
    else msg(`Unexpected reply (${res?.status ?? "?"}).`, "err");
  } finally {
    $("test").disabled = false;
  }
});

/**
 * Diagnostics v3 lives in diagnostics.js, loaded by popup.html before this file.
 *
 * It moved out because popup.js registers DOM listeners at the top level and so
 * cannot be loaded outside a popup — which left the one function that produces
 * every capture's evidence trail with no test at all. That is how a report with
 * `machine: null, cleanup: null, contact: null, photo: null` shipped and stayed.
 */
const buildDiagnostics = (payload, extras) =>
  globalThis.VentureDiagnostics.buildDiagnostics(payload, extras);

/**
 * Copy a description of the page's shape, for when a capture reads too little.
 *
 * Runs BOTH halves: the real reader, so its own verdict is in the report, and
 * the probes behind it, so the verdict can be explained. A field missing from
 * `_from` and a probe showing no <h1> are the same fact seen from two sides,
 * and having only the first is what turned the last round of this into
 * guesswork.
 */
$("diagnose").addEventListener("click", async () => {
  $("diagnose").disabled = true;
  msg("Reading the page's shape…");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!PROFILE_URL.test(tab?.url ?? "")) {
      msg("Open a LinkedIn profile or a Sales Navigator lead first.", "err");
      return;
    }

    const [{ result: probes }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["diagnose.js"],
    });
    /**
     * The MACHINE runs here too, and this is the fix for the dump that started
     * this round: every previous report had `machine: null, cleanup: null,
     * contact: null, photo: null`, because the Diagnose button only ever ran the
     * reader. A diagnostic whose four most informative fields are structurally
     * absent sends the reader looking in the wrong place — it looks like the steps
     * failed when they were never invoked.
     */
    const prep = await prepareAndRead(tab.id);
    const [{ result: payload }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["selectors.js", "names.js", "content.js"],
    });

    // The reader's verdict plus the probes behind it — never the values. Which
    // fields came back empty is the whole question; what they would have said is
    // somebody's personal data and no help in answering it.
    const report = {
      ...buildDiagnostics(payload, {
        machine: prep.machine,
        cleanup: prep.cleanup,
        sections: prep.sections,
        bioExpansion: prep.bio,
        contact: { found: !!prep.contact, note: prep.note ?? null },
        // No capture is being saved, so nothing fetches the bytes; the reader's
        // verdict on the URL is still reported.
        photo: { ok: false, reason: "not_fetched_during_diagnose", trail: [] },
      }),
      probes,
    };
    const missing = Object.entries(report.fields)
      .filter(([, f]) => !f.present)
      .map(([name]) => name);

    await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
    msg(
      `Copied. ${missing.length} field(s) could not be read: ${missing.join(", ") || "none"}.`,
      missing.length ? "err" : "ok",
    );
  } catch (e) {
    msg(`Could not read this page (${String(e?.message ?? e).slice(0, 60)}).`, "err");
  } finally {
    $("diagnose").disabled = false;
  }
});

/**
 * Download a scrubbed copy of this page to commit as a test fixture.
 *
 * The point is to stop iterating against live LinkedIn. A committed fixture is
 * checked in once and replayed in jsdom for ever after; a live profile has to be
 * re-found, re-loaded and re-read for every attempt, and changes underneath you
 * while you work. Scrubbing happens in the page (snapshot.js) so that nothing
 * unscrubbed ever leaves the tab.
 */
$("snapshot").addEventListener("click", async () => {
  $("snapshot").disabled = true;
  msg("Serializing and scrubbing…");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!PROFILE_URL.test(tab?.url ?? "")) {
      msg("Open a LinkedIn profile or a Sales Navigator lead first.", "err");
      return;
    }

    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["snapshot.js"],
    });
    if (!result?.html) {
      msg("Could not serialize this page.", "err");
      return;
    }

    // A data: URL rather than a blob: URL — the popup closes as soon as the
    // download starts, and revoking a blob URL on unload cancels the download.
    const url = `data:text/html;charset=utf-8,${encodeURIComponent(result.html)}`;
    await chrome.downloads.download({
      url,
      filename: `linkedin-fixture-${Date.now()}.html`,
      saveAs: true,
    });
    msg(
      `Saved. ${result.scrubbed.otherPeople} other people and ${result.scrubbed.otherSlugs} profile links scrubbed; ${Math.round(result.bytes / 1024)} kB. Move it into test/fixtures/linkedin/.`,
      "ok",
    );
  } catch (e) {
    msg(`Snapshot failed (${String(e?.message ?? e).slice(0, 60)}).`, "err");
  } finally {
    $("snapshot").disabled = false;
  }
});


/**
 * Retrieve the avatar's bytes. THREE LEGS, IN ORDER, EACH RECORDED.
 *
 * The reported diagnostics were `photo.ok: true, trail: ["fetch:Failed to fetch",
 * "img:ok"], 400x400` — and no avatar on the lead. Retrieval had worked and
 * something after it had not, but "after it" was four unreported steps: encode,
 * upload, server-side store, attach to the lead. So the fix is as much about
 * reporting as about mechanism.
 *
 *   (a) THE SERVICE WORKER fetches it. Its request carries no page origin, so
 *       there is nothing for CORS to refuse, and it has OffscreenCanvas — so it
 *       decodes, crops and encodes without a canvas that can ever be tainted.
 *       Needs the media.licdn.com host permission, now declared.
 *   (b) THE PAGE, via photo.js: an <img crossOrigin="anonymous"> into a canvas.
 *       Works when the CDN does authorise it, and throws SecurityError when it
 *       does not — which is the tainted-canvas case the brief predicted.
 *   (c) NOT IMPLEMENTED, deliberately. The last-resort suggestion was to hand the
 *       signed URL to the server and let IT fetch. That cannot work and is why
 *       this whole path exists: the signature is bound to the browser session that
 *       was served the page, so our backend gets a 403. Adding it would mean a leg
 *       that always fails, reported as if it might not.
 */
async function retrieveAvatar(tabId, photoUrl, skipped) {
  const legs = [];
  if (!photoUrl) {
    return { ok: false, reason: skipped?.photoUrl ?? "no_photo_on_page", legs };
  }

  // (a) The service worker.
  try {
    const sw = await chrome.runtime.sendMessage({ type: "fetchAvatar", url: photoUrl });
    legs.push({ leg: "service-worker", ok: !!sw?.ok, reason: sw?.reason ?? null, trail: sw?.trail ?? [] });
    if (sw?.ok && sw.bytes) return { ...sw, method: "service-worker", legs };
  } catch (e) {
    legs.push({ leg: "service-worker", ok: false, reason: `message_failed_${String(e?.name ?? "error").toLowerCase()}` });
  }

  // (b) The page.
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (u) => {
        globalThis.__venturePhotoUrl = u;
      },
      args: [photoUrl],
    });
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      files: ["photo.js"],
    });
    legs.push({
      leg: "page-canvas",
      ok: !!result?.ok,
      reason: result?.reason ?? null,
      trail: result?.trail ?? [],
    });
    if (result?.ok) return { ...result, method: "page-canvas", legs };
    return { ok: false, reason: result?.reason ?? "photo_script_returned_nothing", legs };
  } catch (e) {
    const reason = `injection_failed_${String(e?.name ?? "error").toLowerCase()}`;
    legs.push({ leg: "page-canvas", ok: false, reason });
    return { ok: false, reason, legs };
  }
}

/**
 * Upload bytes already retrieved, and report EVERY leg of it.
 *
 * Its own step, so a rejected picture costs no lead. The return value is
 * structured rather than a sentence, because the sentence used to be the only
 * record and it disappeared with the popup: `photo.ok: true` was stored in the
 * lead's diagnostics while the upload that followed it failed silently.
 */
async function uploadAvatar(leadId, photo) {
  if (!photo?.ok) {
    return { attached: false, stage: "retrieval", reason: photo?.reason ?? "unknown" };
  }
  if (!leadId) return { attached: false, stage: "upload", reason: "capture_returned_no_lead_id" };

  const up = await chrome.runtime.sendMessage({
    type: "avatar",
    leadId,
    bytes: photo.bytes,
    mime: photo.mime,
  });
  const status = up?.status ?? null;
  if (up?.ok && up?.data?.ok !== false) {
    return {
      attached: true,
      stage: "attached",
      status,
      // What the SERVER says it stored, not what we think we sent.
      storedBytes: up?.data?.bytes ?? null,
      storedPath: up?.data?.stored ? "yes" : null,
    };
  }
  return {
    attached: false,
    stage: status ? "server" : "upload",
    status,
    reason: String(up?.data?.reason ?? up?.data?.error ?? up?.error ?? `status_${status ?? "none"}`),
  };
}

/** The human sentence, derived from the structured result above. */
function avatarNote(result) {
  if (result.attached) return ` Photo saved (${result.storedBytes ?? "?"} bytes).`;
  return ` Photo not saved at the ${result.stage} step: ${String(result.reason).replace(/_/g, " ")}.`;
}

/**
 * PAGE PREPARATION: the state machine.
 *
 * Everything that touches the page happens here, in one bounded run with one
 * try/finally: returning to a canonical profile route, opening and reading the
 * contact overlay, closing it and putting the URL back, expanding the About text,
 * and scrolling until the lazy Experience section mounts.
 *
 * This exists because the previous version did those things as loose steps, and
 * when one of them left the page on `/in/<id>/overlay/contact-info/`, nothing
 * noticed — the next capture read an overlay as if it were a profile and every
 * field came back wrong in a different way. The machine reports what it did, what
 * it could not do and whether the page was actually put back, so a thin capture
 * can be explained from the lead itself weeks later.
 *
 * Contact candidates travel to the server UNRESOLVED, with the labels LinkedIn
 * put on them: which of three websites is the company's, and what "06 1 234 5678"
 * is in E.164, are rules that must not exist in a second drifting copy.
 */
async function prepareAndRead(tabId) {
  const empty = {
    contact: undefined,
    note: null,
    machine: null,
    cleanup: null,
    sections: null,
    bio: null,
  };
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      files: ["selectors.js", "names.js", "cleanup.js", "contact-parse.js", "machine.js", "run.js"],
    });
    if (!result?.machine) return { ...empty, note: "machine_returned_nothing" };

    const e = result.contact ?? {};
    const contact = {
      emails: (e.email ?? []).slice(0, 5),
      phones: (e.phone ?? []).slice(0, 5),
      websites: (e.website ?? []).slice(0, 5),
    };
    const found = contact.emails.length + contact.phones.length + contact.websites.length > 0;
    const readStep = (result.machine.steps ?? []).find((st) => st.name === "READ_CONTACT");
    return {
      contact: found ? contact : undefined,
      note: found ? null : (readStep?.reason ?? "overlay_unavailable"),
      machine: result.machine,
      cleanup: {
        steps: result.machine.cleanupSteps ?? [],
        verified: result.machine.cleanupVerified ?? null,
      },
      sections: result.sections ?? null,
      bio: result.bio ?? null,
    };
  } catch (e) {
    // A failed injection must not stop the capture: the reader can still run.
    return { ...empty, note: `machine_injection_failed_${String(e?.name ?? "error").toLowerCase()}` };
  }
}

$("capture").addEventListener("click", async () => {
  $("capture").disabled = true;
  msg("Reading the page…");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    // Ordinary profiles and Sales Navigator lead pages. Kept in step with the
    // same pattern in background.js — two small copies rather than a shared
    // module, because an MV3 service worker without "type": "module" cannot
    // import one.
    if (!PROFILE_URL.test(tab?.url ?? "")) {
      msg("Open a LinkedIn profile or a Sales Navigator lead first.", "err");
      return;
    }

    /**
     * PREPARE, THEN READ. In that order, and both on demand — nothing is
     * persistent and nothing runs unless a human clicked.
     *
     * The machine goes first because the page is not ready to be read: the
     * Experience section has not mounted, the About text is clamped, and the
     * contact details are behind an overlay. It also puts the page back, which is
     * the half that was missing — a capture that left the tab on
     * `/in/<id>/overlay/contact-info/` made the NEXT capture read an overlay as
     * though it were a profile.
     */
    msg("Preparing the page…");
    const prep = await prepareAndRead(tab.id);

    // Then the reader, on the prepared page. executeScript resolves to the last
    // file's last expression — content.js is an IIFE returning what it read.
    msg("Reading the page…");
    const [{ result: read }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["selectors.js", "names.js", "content.js"],
    });

    /**
     * NEVER ABORT THE SAVE.
     *
     * This used to return early when the reader came back without a URL, which
     * threw away everything the machine had just gathered — including contact
     * details that were successfully read — and left the operator with nothing
     * after watching the extension work. A lead with a URL and a reason code is
     * worth more than no lead, and it is the only artefact that can explain the
     * failure later.
     */
    const payload = read?.url
      ? read
      : {
          url: (tab.url ?? "").split("?")[0],
          provenance: {},
          skipped: { _all: read?.route?.reason ?? "reader_returned_nothing" },
          flags: ["reader_returned_nothing"],
          posts: [],
          boundary: null,
          _from: {},
          _attempts: {},
        };

    // Local diagnostics, never sent to the server. photoUrl is stripped too:
    // it is a signed CDN link the server cannot fetch, so sending it would only
    // buy a guaranteed failure and a confusing message. The BYTES go up
    // separately, below.
    const {
      _from: readFrom,
      _attempts: _a,
      provenance: _p,
      skipped: _s,
      boundary: _b,
      photoUrl,
      ...body
    } = payload;
    const fields = Object.keys(readFrom ?? {});

    // The overlay was read during preparation, so its values are already here and
    // the lead is written once with everything rather than patched afterwards.
    const contact = prep.contact;
    const contactNote = prep.note;
    if (contact) body.contact = contact;

    // Sent with the capture so the LEAD can explain itself later, rather than
    // the explanation living in a popup that is about to close.
    msg("Reading the photo…");
    const photoResult = await retrieveAvatar(tab.id, photoUrl, payload.skipped);

    body.diagnostics = buildDiagnostics(payload, {
      /**
       * The four sections that used to be null on every dump, which is what made
       * the last round of this undiagnosable: `machine: null` cannot distinguish
       * "the steps did not run" from "the steps ran and found nothing".
       */
      machine: prep.machine,
      cleanup: prep.cleanup,
      sections: prep.sections,
      bioExpansion: prep.bio,
      contact: { found: !!contact, note: contactNote ?? null },
      // The bytes themselves never go into the diagnostics — only whether they
      // arrived, how, and why not.
      /**
       * RETRIEVAL ONLY, and labelled as such.
       *
       * `photo.ok: true` used to be written here and meant "we got the bytes",
       * while the upload that followed could fail silently — so a lead with no
       * avatar carried diagnostics claiming the photo was fine. The upload legs
       * are patched in below, after they have actually happened, and `ok` is
       * reserved for the whole chain.
       */
      photo: {
        retrieved: photoResult.ok,
        method: photoResult.method ?? null,
        reason: photoResult.ok ? null : photoResult.reason,
        width: photoResult.width ?? null,
        height: photoResult.height ?? null,
        encodedBytes: photoResult.encodedBytes ?? null,
        sourceBytes: photoResult.sourceBytes ?? null,
        legs: photoResult.legs ?? [],
        trail: photoResult.trail ?? [],
        // Filled in after the upload; `ok` stays false until the lead has it.
        ok: false,
        upload: null,
      },
    });

    const res = await chrome.runtime.sendMessage({ type: "capture", payload: body });
    if (res?.ok) {
      const what = res.data?.created ? "Captured as a new lead" : "Existing lead updated";
      // The bytes were read before the post; this only sends them.
      /**
       * The upload, then the diagnostics ABOUT the upload — in that order, so a
       * lead can never carry a photo section that claims more than happened.
       */
      const upload = await uploadAvatar(res.data?.leadId, photoResult);
      const photoNote = avatarNote(upload);
      if (body.diagnostics?.photo) {
        body.diagnostics.photo.upload = upload;
        body.diagnostics.photo.ok = upload.attached;
      }
      // No second capture write. The SERVER patches the stored diagnostics from
      // the avatar endpoint, which is the only place that knows how the store and
      // the attach actually went — and re-posting a capture to carry a status
      // would re-run the whole lead-write path for the sake of one field.
      // A capture that read nothing but the URL used to look identical to a
      // good one — that is how a lead called "unknown" with no data happened
      // without anybody noticing.
      // Name the LAYER each field came from, not just the field. When a field
      // stops arriving, the layer that used to supply it is the thing that
      // broke, and this is the only place that difference is visible.
      const detail = fields.map((f) => `${f} (${readFrom[f]})`).join(", ");
      // Why a field is empty, from both sides: what the page would not give us,
      // and what the server would not accept.
      const skippedHere = Object.entries(payload.skipped ?? {});
      const skippedThere = Object.entries(res.data?.contactReasons ?? {});
      const why = [...skippedHere, ...skippedThere]
        .filter(([f]) => f !== "photoUrl")
        .map(([f, r]) => `${f}: ${String(r).replace(/_/g, " ")}`)
        .join("; ");
      const contactLine = contactNote ? ` Contact info: ${contactNote.replace(/_/g, " ")}.` : "";
      const photo = photoNote;
      // A thin read is a FAILURE being reported as a success. The name alone is
      // what a broken extraction layer leaves behind — it comes from the page
      // title, which survives anything — so treating "name only" as a good
      // capture is precisely how a layout change went unnoticed for months.
      const thin = fields.length > 0 && fields.every((f) => f === "name" || f === "photoUrl");
      msg(
        fields.length === 0
          ? `${what}, but only the URL could be read — LinkedIn's layout has changed.`
          : thin
            ? `${what}, but only ${detail} came through — the rest of the profile could not be read.`
            : `${what} · read ${detail}.${photo}${contactLine}${why ? ` Skipped — ${why}.` : ""}`,
        fields.length === 0 || thin || photo ? "err" : "ok",
      );
    } else if (res?.error === "not_configured") {
      $("settings").open = true;
      msg("Add your Venture OS address and token first.", "err");
    } else if (res?.error === "no_permission") {
      $("settings").open = true;
      msg("Press Save to grant access to your Venture OS address.", "err");
    } else if (res?.status === 401) {
      msg("Token rejected. Create a new one in Settings → Extension.", "err");
    } else if (res?.status === 429) {
      msg("Too many captures just now. Try again shortly.", "err");
    } else if (res?.error === "timeout") {
      msg("The server did not answer in time.", "err");
    } else if (res?.status === 400) {
      // Previously this fell into the generic branch below, so a rejected
      // payload was indistinguishable from a network failure — and the server
      // was rejecting every profile with a field it could not read.
      const fields = res?.data?.fields?.join(", ");
      msg(
        fields
          ? `The server rejected the capture (${fields}). Update the extension.`
          : "The server rejected this capture. Update the extension.",
        "err",
      );
    } else {
      msg(`Capture failed (${res?.status ?? res?.error ?? "unknown"}).`, "err");
    }
  } finally {
    $("capture").disabled = false;
  }
});
