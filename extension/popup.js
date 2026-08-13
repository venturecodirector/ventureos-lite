const $ = (id) => document.getElementById(id);
const msg = (text, cls) => {
  $("msg").textContent = text;
  $("msg").className = `msg ${cls ?? ""}`;
};

(async () => {
  const { baseUrl, token } = await chrome.storage.local.get(["baseUrl", "token"]);
  $("baseUrl").value = baseUrl ?? "";
  $("token").value = token ?? "";
  if (!baseUrl || !token) {
    $("settings").open = true;
    msg("Add your Venture OS URL and capture token to start.", "muted");
  }
})();

$("save").addEventListener("click", async () => {
  await chrome.storage.local.set({
    baseUrl: $("baseUrl").value.trim(),
    token: $("token").value.trim(),
  });
  msg("Saved.", "ok");
});

$("capture").addEventListener("click", async () => {
  $("capture").disabled = true;
  msg("Reading the page…");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url?.includes("linkedin.com/in/")) {
      msg("Open a LinkedIn profile first.", "err");
      return;
    }

    // Injected on demand, never persistently: it runs because a human clicked.
    // Injected on demand, never persistently. executeScript resolves to the
    // injected file's last expression — content.js is an IIFE returning the
    // fields it read.
    const [{ result: payload }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });

    if (!payload?.url) {
      msg("Could not read this page. LinkedIn may have changed its layout.", "err");
      return;
    }

    const res = await chrome.runtime.sendMessage({ type: "capture", payload });
    if (res?.ok) {
      msg(res.data?.created ? "Captured as a new lead." : "Existing lead updated.", "ok");
    } else if (res?.error === "not_configured") {
      $("settings").open = true;
      msg("Add your Venture OS URL and capture token first.", "err");
    } else if (res?.status === 401) {
      msg("Token rejected. Create a new one in Settings → Extension.", "err");
    } else if (res?.status === 429) {
      msg("Too many captures just now. Try again shortly.", "err");
    } else {
      msg("Capture failed.", "err");
    }
  } finally {
    $("capture").disabled = false;
  }
});
