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
  $("baseUrl").value = baseUrl ?? "";
  $("token").value = token ?? "";
  if (!baseUrl || !token) {
    $("settings").open = true;
    msg("Add your Venture OS address and a capture token to start.", "muted");
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

    const res = await chrome.runtime.sendMessage({ type: "capture", payload });
    if (res?.ok) {
      msg(res.data?.created ? "Captured as a new lead." : "Existing lead updated.", "ok");
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
