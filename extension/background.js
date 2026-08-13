/**
 * Service worker: holds nothing, does nothing on its own. It exists only so
 * the popup can hand off the network call, keeping the token out of the
 * content script (which runs in a page LinkedIn also controls).
 */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "capture") return false;

  (async () => {
    const { baseUrl, token } = await chrome.storage.local.get(["baseUrl", "token"]);
    if (!baseUrl || !token) {
      sendResponse({ ok: false, error: "not_configured" });
      return;
    }
    try {
      const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/capture`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(msg.payload),
      });
      const data = await res.json().catch(() => ({}));
      sendResponse({ ok: res.ok, status: res.status, data });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  })();

  return true; // async response
});
