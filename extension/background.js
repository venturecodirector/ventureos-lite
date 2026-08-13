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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "capture") return false;
  postCapture(msg.payload).then(sendResponse);
  return true; // keep the channel open for the async reply
});
