/**
 * Service worker.
 *
 * It holds no state and does nothing on its own — no alarms, no listeners on
 * navigation, nothing periodic. It exists so the network call lives outside
 * the content script, keeping the capture token out of a page that LinkedIn
 * also controls.
 */
const TIMEOUT_MS = 15000;

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
    case "ping":
      return Promise.resolve({ ok: true, version: chrome.runtime.getManifest().version });
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
  if (!/^https:\/\/([a-z-]+\.)?linkedin\.com\/in\//i.test(profileUrl)) {
    return { ok: false, error: "not_a_profile" };
  }

  // Injecting into a tab WE opened cannot ride on activeTab — that is granted
  // only when a human clicks the extension. So this path needs LinkedIn host
  // permission, which the popup asks for explicitly and which manual capture
  // does not require. Refused clearly rather than failing obscurely.
  const allowed = await chrome.permissions.contains({
    origins: ["https://www.linkedin.com/*"],
  });
  if (!allowed) return { ok: false, error: "no_linkedin_permission" };

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
      files: ["content.js"],
    });
    if (!payload?.url) return { ok: false, error: "unreadable" };

    const { _from, ...body } = payload;
    const res = await postCapture(body);
    // Which layers supplied data, so the app can say "read from og:title" and a
    // future LinkedIn change is visible instead of silent.
    return { ...res, read: Object.keys(_from ?? {}) };
  } catch (e) {
    // A login wall, or a tab that went away mid-read.
    return { ok: false, error: "unreadable", detail: String(e?.message ?? e).slice(0, 120) };
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
}
