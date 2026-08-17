/**
 * Service worker.
 *
 * It holds no state and does nothing on its own — no alarms, no listeners on
 * navigation, nothing periodic. It exists so the network call lives outside
 * the content script, keeping the capture token out of a page that LinkedIn
 * also controls.
 */
const TIMEOUT_MS = 15000;

/**
 * LinkedIn host access.
 *
 * Optional, not declared — so installing the extension grants nothing and a
 * paste-only user is never prompted. The cost of that choice is that something
 * must actually REQUEST it, and for a long time nothing did: the popup asked only
 * for the Venture OS origin, so "needs permission to read LinkedIn pages" was a
 * permanent state with no way out of it from inside the product.
 */
const LINKEDIN_ORIGINS = ["https://www.linkedin.com/*", "https://linkedin.com/*"];

const hasLinkedInPermission = () =>
  chrome.permissions.contains({ origins: LINKEDIN_ORIGINS });

/**
 * What the web app needs to know to offer the right next action.
 *
 * Four states, and they need different buttons: not installed (install it),
 * installed without permission (grant it), permitted but no profile tab (open
 * one), ready. Collapsing them into one "it did not work" is what made this
 * unfixable from the user's side.
 */
async function status() {
  const { baseUrl, token } = await chrome.storage.local.get(["baseUrl", "token"]);
  return {
    ok: true,
    installed: true,
    version: chrome.runtime.getManifest().version,
    configured: !!(baseUrl && token),
    linkedInPermission: await hasLinkedInPermission(),
  };
}

/**
 * Open the grant page.
 *
 * chrome.permissions.request() is only honoured from a gesture inside an
 * extension context, and a click in the web app is a gesture in the PAGE. It
 * cannot carry across, whatever the wiring — so the only working shape is to open
 * an extension page and let the user click there.
 */
async function openPermissionPage() {
  if (await hasLinkedInPermission()) return { ok: true, alreadyGranted: true };
  await chrome.tabs.create({ url: chrome.runtime.getURL("permission.html"), active: true });
  return { ok: true, opened: true };
}

/**
 * Register the profile content script, once we are allowed on linkedin.com.
 *
 * Dynamic rather than manifest-declared, for the same reason the permission is
 * optional: a declared content script forces the install-time host prompt on
 * everybody. Idempotent — re-registering the same id throws, and that is not an
 * error worth surfacing.
 */
async function registerProfileScript() {
  if (!(await hasLinkedInPermission())) return { ok: false, error: "no_linkedin_permission" };
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: ["venture-profile-panel"] });
    if (existing.length > 0) return { ok: true, alreadyRegistered: true };
  } catch {
    /* getRegisteredContentScripts is unavailable on older builds; try anyway */
  }
  try {
    await chrome.scripting.registerContentScripts([
      {
        id: "venture-profile-panel",
        matches: ["https://www.linkedin.com/in/*"],
        js: ["selectors.js", "panel.js"],
        runAt: "document_idle",
      },
    ]);
    return { ok: true, registered: true };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 120) };
  }
}

async function postCapture(payload) {
  const { baseUrl, token } = await chrome.storage.local.get(["baseUrl", "token"]);
  if (!baseUrl || !token) return { ok: false, error: "not_configured" };

  const origin = new URL(baseUrl).origin;
  // MV3: a cross-origin fetch from the worker needs host permission for that
  // origin. It is optional and granted per install, because the server address
  // is the operator's, not something we can hardcode.
  const granted = await chrome.permissions.contains({ origins: [`${origin}/*`] });
  if (!granted) return { ok: false, error: "no_permission" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${origin}/api/capture`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    // Never include the token or headers in an error surfaced to the popup.
    return { ok: false, error: e?.name === "AbortError" ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Upload the profile photo's bytes.
 *
 * A separate request from the capture, and separately failable: an image is a
 * different size class from a JSON document, and losing a whole lead because a
 * picture was rejected would be the wrong trade. The bytes arrive here as base64
 * because that is all `executeScript` can return, and go out as multipart.
 */
async function postAvatar({ leadId, bytes, mime }) {
  const { baseUrl, token } = await chrome.storage.local.get(["baseUrl", "token"]);
  if (!baseUrl || !token) return { ok: false, error: "not_configured" };
  const origin = new URL(baseUrl).origin;
  const granted = await chrome.permissions.contains({ origins: [`${origin}/*`] });
  if (!granted) return { ok: false, error: "no_permission" };

  let blob;
  try {
    const binary = atob(String(bytes ?? ""));
    const buf = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) buf[i] = binary.charCodeAt(i);
    blob = new Blob([buf], { type: mime || "image/jpeg" });
  } catch {
    return { ok: false, error: "bad_image_payload" };
  }

  const form = new FormData();
  form.append("leadId", String(leadId ?? ""));
  form.append("photo", blob, "avatar.jpg");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    // No content-type header: fetch sets the multipart boundary itself.
    const res = await fetch(`${origin}/api/capture/avatar`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: form,
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, error: e?.name === "AbortError" ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Every message the extension answers, from one place.
 *
 * Two callers reach this: the popup, and the bridge content script running on
 * the app's own origin. Both are internal, so there is one listener and one
 * allowlist rather than two diverging ones.
 */
function handle(msg) {
  switch (msg?.type) {
    case "capture":
      return postCapture(msg.payload);
    case "avatar":
      return postAvatar(msg);
    case "ping":
      return Promise.resolve({ ok: true, version: chrome.runtime.getManifest().version });
    case "status":
      return status();
    case "requestLinkedInPermission":
      return openPermissionPage();
    case "registerProfileScript":
      return registerProfileScript();
    case "lookupProfile":
      return lookupProfile(String(msg.url ?? ""));
    case "openLead":
      return openLead(String(msg.leadId ?? ""));
    case "configure":
      return configure(msg);
    case "captureProfile":
      return captureProfileInTab(String(msg.url ?? ""));
    default:
      return null;
  }
}

/**
 * Take the address and token from the app, so nobody copies a token by hand.
 *
 * Only ever writes. The token is never readable back out — a page that could
 * ask the extension for its token would be a page that could exfiltrate it.
 */
async function configure(msg) {
  try {
    const origin = new URL(msg.baseUrl).origin;
    if (typeof msg.token !== "string" || !msg.token.startsWith("vos_cap_")) {
      return { ok: false, error: "invalid_token" };
    }
    await chrome.storage.local.set({ baseUrl: origin, token: msg.token });
    return { ok: true, baseUrl: origin };
  } catch {
    return { ok: false, error: "invalid" };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const result = handle(msg);
  if (!result) return false;
  result.then(sendResponse);
  return true; // keep the channel open for the async reply
});

/**
 * Read a LinkedIn profile in a tab, without the user driving the popup.
 *
 * Used by the app's "capture with the extension" action. It still only READS a
 * page — the same content script, the same single pass, no clicking or scrolling
 * — but the tab is opened for the purpose rather than found already open. That
 * is the honest description of what it does, and it is why the tab is left
 * visible: the operator sees the page that was read.
 */
async function captureProfileInTab(profileUrl) {
  // Ordinary profiles and Sales Navigator lead pages. Kept in step with the
  // same pattern in popup.js — two small copies rather than a shared module,
  // because an MV3 service worker without "type": "module" cannot import one.
  if (!/^https:\/\/([a-z-]+\.)?linkedin\.com\/(in\/|sales\/(lead|people)\/)/i.test(profileUrl)) {
    return { ok: false, error: "not_a_profile" };
  }

  // Injecting into a tab WE opened cannot ride on activeTab — that is granted
  // only when a human clicks the extension. So this path needs LinkedIn host
  // permission, which the popup asks for explicitly and which manual capture
  // does not require. Refused clearly rather than failing obscurely.
  if (!(await hasLinkedInPermission())) {
    // Actionable, not a dead end: the app turns this into a button that opens the
    // grant page, because only a click inside the extension can grant it.
    return { ok: false, error: "no_linkedin_permission", canRequest: true };
  }

  // A fresh background tab every time, closed afterwards. Deliberately NOT
  // chrome.tabs.query to find an already-open one: filtering tabs by URL needs
  // the broad "tabs" permission, which would let the extension see every page
  // the user has open — far too much to buy tab reuse.
  const tab = await chrome.tabs.create({ url: profileUrl, active: false });
  try {
    await new Promise((resolve) => {
      const done = (tabId, info) => {
        if (tabId === tab.id && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(done);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(done);
      // Waiting for the document rather than a fixed delay: LinkedIn is slow,
      // and a guessed timeout reads a half-rendered page. The ceiling is a
      // fallback, not the plan.
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(done);
        resolve();
      }, 20000);
    });

    const [{ result: payload }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["selectors.js", "content.js"],
    });
    if (!payload?.url) return { ok: false, error: "unreadable" };

    const { _from, ...body } = payload;
    const res = await postCapture(body);
    // Which layers supplied data, so the app can say "read from og:title" and a
    // future LinkedIn change is visible instead of silent. The map travels too:
    // a field going missing is really the LAYER behind it having broken.
    return { ...res, read: Object.keys(_from ?? {}), readFrom: _from ?? {} };
  } catch (e) {
    // A login wall, or a tab that went away mid-read.
    return { ok: false, error: "unreadable", detail: String(e?.message ?? e).slice(0, 120) };
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

/**
 * "Do we already know this person?" for the on-profile panel.
 *
 * Read-only and fired on page view, so it gets its own short timeout and never
 * retries: a slow answer must not hold up a page the operator is reading, and a
 * failed one must produce no panel rather than a broken one.
 */
async function lookupProfile(profileUrl) {
  const { baseUrl, token } = await chrome.storage.local.get(["baseUrl", "token"]);
  if (!baseUrl || !token) return { ok: false, error: "not_configured" };
  const origin = new URL(baseUrl).origin;
  if (!(await chrome.permissions.contains({ origins: [`${origin}/*`] }))) {
    return { ok: false, error: "no_permission" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(
      `${origin}/api/capture/lookup?url=${encodeURIComponent(profileUrl)}`,
      { headers: { authorization: `Bearer ${token}` }, signal: controller.signal },
    );
    if (!res.ok) return { ok: false, error: `status_${res.status}` };
    return { ok: true, data: await res.json() };
  } catch (e) {
    return { ok: false, error: e?.name === "AbortError" ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}

/** Open a lead in the app. A new tab, because the operator is mid-LinkedIn. */
async function openLead(leadId) {
  const { baseUrl } = await chrome.storage.local.get(["baseUrl"]);
  if (!baseUrl || !leadId) return { ok: false, error: "not_configured" };
  await chrome.tabs.create({
    url: `${new URL(baseUrl).origin}/leads?lead=${encodeURIComponent(leadId)}`,
    active: true,
  });
  return { ok: true };
}
