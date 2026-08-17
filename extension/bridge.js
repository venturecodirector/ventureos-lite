/**
 * The page ↔ extension bridge (P1/1e).
 *
 * Injected ONLY into the Venture OS origin that packaged this build — the match
 * pattern is written into the manifest at download time, so this never runs on
 * LinkedIn or anywhere else.
 *
 * It exists because a web page cannot message an extension without knowing its
 * id, and a side-loaded build gets a different id on every machine. A content
 * script on the app's own origin can talk to its extension with no id at all,
 * which is why this is a few lines rather than a configuration step.
 *
 * It relays and nothing more: no capture logic, no token, no storage access.
 * The token lives in the service worker and is never sent to a page — including
 * this one.
 */
(() => {
  const ALLOWED = new Set(["ping", "configure", "captureProfile"]);
  // Deliberately NOT "avatar" or "capture": the app has no reason to push bytes
  // through the extension, and every name added here widens what a page can
  // reach if that page is ever compromised.

  window.addEventListener("message", (event) => {
    // Same-window messages only: this must not be drivable by an iframe.
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.__venture !== "request" || !msg.id) return;
    // An allowlist, so the page cannot reach anything the extension gains later.
    if (!ALLOWED.has(msg.payload?.type)) return;

    chrome.runtime.sendMessage(msg.payload, (res) => {
      window.postMessage(
        { __venture: "response", id: msg.id, res: res ?? { ok: false, error: "no_response" } },
        window.location.origin,
      );
    });
  });

  // Announce presence, so the app can show the extension actions only when
  // there is an extension to act.
  window.postMessage(
    { __venture: "present", version: chrome.runtime.getManifest().version },
    window.location.origin,
  );
})();
