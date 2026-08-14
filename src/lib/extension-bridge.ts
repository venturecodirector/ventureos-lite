/**
 * Talking to the capture extension from the app (P1/1e).
 *
 * The extension injects `bridge.js` into this origin only, which relays
 * `window.postMessage` to its service worker. That indirection exists because a
 * page cannot message an extension without its id, and a side-loaded build has a
 * different id on every machine.
 *
 * Browser-only: every function here returns a safe "not present" result when
 * there is no extension, so a caller never has to guard.
 */
export interface ExtensionPresence {
  present: boolean;
  version: string | null;
}

interface BridgeResponse {
  ok?: boolean;
  error?: string;
  status?: number;
  data?: { created?: boolean; leadId?: string };
  /** Which extraction layers supplied data, e.g. ["name", "headline"]. */
  read?: string[];
  version?: string;
}

const REQUEST = "request";
const RESPONSE = "response";

/** A request/response round trip over postMessage, with a timeout. */
function ask(payload: Record<string, unknown>, timeoutMs = 30_000): Promise<BridgeResponse | null> {
  if (typeof window === "undefined") return Promise.resolve(null);

  return new Promise((resolve) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let settled = false;

    const done = (value: BridgeResponse | null) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
      resolve(value);
    };

    const onMessage = (event: MessageEvent) => {
      // Same-window, same-origin only: this must not be answerable by a frame.
      if (event.source !== window || event.origin !== window.location.origin) return;
      const msg = event.data as { __venture?: string; id?: string; res?: BridgeResponse };
      if (msg?.__venture !== RESPONSE || msg.id !== id) return;
      done(msg.res ?? null);
    };

    // A missing extension never answers, so silence is the "not installed"
    // signal — hence the timeout rather than an error.
    const timer = setTimeout(() => done(null), timeoutMs);
    window.addEventListener("message", onMessage);
    window.postMessage({ __venture: REQUEST, id, payload }, window.location.origin);
  });
}

/**
 * Is the extension installed?
 *
 * Short timeout: this gates whether a button is shown at all, and a user should
 * not wait seconds to find out an optional tool is absent.
 */
export async function extensionPresence(): Promise<ExtensionPresence> {
  const res = await ask({ type: "ping" }, 1200);
  return { present: !!res?.ok, version: res?.version ?? null };
}

/**
 * Hand the extension this deployment's address and a capture token.
 *
 * Replaces copying a token by hand, which is what made people re-enter it after
 * every reinstall.
 */
export async function configureExtension(
  baseUrl: string,
  token: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await ask({ type: "configure", baseUrl, token }, 5_000);
  if (!res) return { ok: false, error: "not_installed" };
  return { ok: !!res.ok, error: res.error };
}

export type CaptureOutcome =
  | { ok: true; created: boolean; read: string[] }
  | { ok: false; error: string; message: string };

const MESSAGES: Record<string, string> = {
  not_installed: "The capture extension is not installed in this browser.",
  not_configured: "Connect the extension first — Settings → Extension.",
  no_permission: "The extension needs permission for this server. Open its popup and press Save.",
  no_linkedin_permission:
    "The extension needs permission to read LinkedIn pages. Open its popup and allow it.",
  not_a_profile: "That is not a LinkedIn profile URL.",
  unreadable: "The profile could not be read — you may need to be signed in to LinkedIn.",
  timeout: "The extension did not answer in time.",
  network: "The extension could not reach this server.",
};

/**
 * Ask the extension to open a profile and read it.
 *
 * Long timeout by design: it opens a tab, waits for LinkedIn to render, reads
 * it and posts the result. Thirty seconds is the realistic worst case, and
 * failing early would report a working capture as broken.
 */
export async function captureProfileViaExtension(url: string): Promise<CaptureOutcome> {
  const res = await ask({ type: "captureProfile", url }, 45_000);
  if (!res) return { ok: false, error: "not_installed", message: MESSAGES.not_installed! };

  if (res.ok) {
    return { ok: true, created: !!res.data?.created, read: res.read ?? [] };
  }

  const key = res.error ?? (res.status === 401 ? "not_configured" : "unreadable");
  return {
    ok: false,
    error: key,
    message:
      MESSAGES[key] ??
      (res.status ? `The server refused the capture (${res.status}).` : "The capture failed."),
  };
}
