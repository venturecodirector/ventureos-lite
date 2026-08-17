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
    const [{ result: payload }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });

    // The reader's verdict, as layers and absences — never the values. Which
    // fields came back empty is the whole question; what they would have said
    // is somebody's personal data and no help in answering it.
    const { _from: readFrom = {}, posts = [], photoUrl, url, ...rest } = payload ?? {};
    const fields = Object.keys(rest);
    const report = {
      extension: chrome.runtime.getManifest().version,
      read: readFrom,
      missing: [
        "name", "headline", "companyName", "location", "jobTitle",
        "email", "phone", "websiteUrl", "bio", "photoUrl",
      ].filter((f) => !readFrom[f]),
      postsRead: posts.length,
      // The photo is reported as a shape because the failure being chased is
      // "the server could not fetch it", and that is a question about the
      // address, not the picture.
      photo: photoUrl
        ? { scheme: photoUrl.split(":")[0], length: photoUrl.length, hasQuery: photoUrl.includes("?") }
        : null,
      fieldsSent: fields.length,
      probes,
    };

    await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
    msg(
      `Copied. ${report.missing.length} field(s) could not be read: ${report.missing.join(", ") || "none"}.`,
      report.missing.length ? "err" : "ok",
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

    // Injected on demand, never persistently: it runs because a human clicked.
    // executeScript resolves to the file's last expression — content.js is an
    // IIFE returning what it read.
    const [{ result: payload }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });

    if (!payload?.url) {
      msg("Could not read this page. LinkedIn may have changed its layout.", "err");
      return;
    }

    // _from is a local diagnostic, never sent to the server.
    const { _from: readFrom, ...body } = payload;
    const fields = Object.keys(readFrom ?? {});

    const res = await chrome.runtime.sendMessage({ type: "capture", payload: body });
    if (res?.ok) {
      const what = res.data?.created ? "Captured as a new lead" : "Existing lead updated";
      // A capture that read nothing but the URL used to look identical to a
      // good one — that is how a lead called "unknown" with no data happened
      // without anybody noticing.
      // Name the LAYER each field came from, not just the field. When a field
      // stops arriving, the layer that used to supply it is the thing that
      // broke, and this is the only place that difference is visible.
      const detail = fields.map((f) => `${f} (${readFrom[f]})`).join(", ");
      const photo = res.data?.avatarProblem ? ` Photo not saved: ${res.data.avatarProblem}.` : "";
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
            : `${what} · read ${detail}.${photo}`,
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
