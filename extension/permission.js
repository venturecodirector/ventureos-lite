/**
 * The LinkedIn permission grant page.
 *
 * WHY THIS PAGE HAS TO EXIST
 *
 * `chrome.permissions.request()` is only honoured from a user gesture inside an
 * EXTENSION context. A click on a button in the web app is a gesture in the
 * page, and it does not carry across — so the app's "Read it with the extension"
 * button could never grant the permission itself, however it was wired. It could
 * only ever tell the user to go and do it somewhere else, which is precisely the
 * dead end being fixed.
 *
 * So the app opens this page, and the click that grants the permission happens
 * here. One extra step, and it is the only version that actually works.
 *
 * The root cause of "The extension needs permission to read LinkedIn pages" was
 * simpler than it looked: `optional_host_permissions` means LinkedIn access is
 * not granted at install, and NOTHING in the extension ever requested it. The
 * popup asked only for the Venture OS origin. A permission with no request path
 * can only ever be missing.
 */
const LINKEDIN_ORIGINS = ["https://www.linkedin.com/*", "https://linkedin.com/*"];

const $ = (id) => document.getElementById(id);
const say = (text, cls) => {
  $("msg").textContent = text;
  $("msg").className = `msg ${cls ?? ""}`;
};

async function refresh() {
  const granted = await chrome.permissions.contains({ origins: LINKEDIN_ORIGINS });
  if (granted) {
    $("grant").disabled = true;
    $("grant").textContent = "LinkedIn access granted";
    say("You can close this tab and press Capture again.", "ok");
  }
  return granted;
}

$("grant").addEventListener("click", async () => {
  $("grant").disabled = true;
  say("Waiting for Chrome…");
  try {
    const granted = await chrome.permissions.request({ origins: LINKEDIN_ORIGINS });
    if (!granted) {
      $("grant").disabled = false;
      say("Permission was not granted. Capture cannot read a profile without it.", "err");
      return;
    }
    // With the permission in hand, register the profile content script so the
    // auto-prompt panel can appear without another round trip. Registration is
    // dynamic rather than declared in the manifest precisely because the host
    // permission is optional — a manifest-declared script would force the scary
    // install-time prompt on everyone, including people who only ever paste.
    await chrome.runtime.sendMessage({ type: "registerProfileScript" });
    $("grant").textContent = "LinkedIn access granted";
    say("Granted. You can close this tab and press Capture again.", "ok");
  } catch (e) {
    $("grant").disabled = false;
    say(`Chrome refused the request (${String(e?.message ?? e).slice(0, 60)}).`, "err");
  }
});

refresh();
