/**
 * The on-profile panel. Registered on https://www.linkedin.com/in/* once LinkedIn
 * host permission has been granted.
 *
 * ── WHAT IT IS FOR ──────────────────────────────────────────────────────────
 *
 * One question, answered before the operator does anything: do we already know
 * this person? The highest-value case is not "capture this" — it is DUPLICATE
 * PROTECTION. A BDR about to write to someone a colleague messaged last week
 * needs to know before they type, not after they hit send. That is why the
 * already-contacted case is the only thing here that gets a colour.
 *
 * ── WHAT IT IS NOT ALLOWED TO DO ────────────────────────────────────────────
 *
 * READ-ONLY toward LinkedIn, absolutely. It appends exactly one root element to
 * <body> and touches nothing else in LinkedIn's tree — no reordering, no class
 * changes, no event interception, no clicking. Everything inside that root is our
 * own DOM. Shadow DOM keeps our styles off their page and their styles off ours.
 *
 * IT DOES NOT CAPTURE. Pressing Capture messages the service worker, which runs
 * the same explicit, user-initiated flow the popup does. Nothing about this panel
 * automates LinkedIn's UI, and it must never grow that: an automatic panel that
 * could act automatically would be a crawler with a friendly face.
 *
 * FAILS SILENT. If the API is unreachable, unconfigured, or answers anything
 * unexpected, the panel does not appear at all. A broken panel on somebody's
 * LinkedIn is worse than no panel: it is our bug showing up in their workspace.
 */
(() => {
  const ROOT_ID = "venture-os-profile-panel";
  const DISMISS_HOURS = 24;

  // Design tokens, from the workspace brand. Kept here as the seed defaults; a
  // white-labelled deployment sends its own through the lookup response later.
  const T = {
    canvas: "#00051D",
    panel: "rgba(239,241,248,0.06)",
    line: "rgba(239,241,248,0.12)",
    ink: "#EFF1F8",
    muted: "#858CAE",
    accent: "#7427C6",
    gradFrom: "#310B59",
    gradTo: "#7427C6",
    warn: "#FFB3C2",
    warnBg: "rgba(255,92,122,0.12)",
    warnLine: "rgba(255,92,122,0.35)",
    ok: "#3DDC97",
  };

  /** Only ever run once per page, even if the script is injected twice. */
  if (document.getElementById(ROOT_ID)) return;

  const slug = (() => {
    const m = /^\/in\/([^/]+)/.exec(location.pathname);
    return m ? decodeURIComponent(m[1]).toLowerCase() : null;
  })();
  if (!slug) return;

  const profileUrl = `https://www.linkedin.com/in/${slug}`;

  const ask = (msg) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => resolve(res ?? null));
      } catch {
        resolve(null);
      }
    });

  const storage = {
    async get(keys) {
      try {
        return await chrome.storage.local.get(keys);
      } catch {
        return {};
      }
    },
    async set(obj) {
      try {
        await chrome.storage.local.set(obj);
      } catch {
        /* a storage failure must not break the page */
      }
    },
  };

  const dismissKey = `panelDismissed:${slug}`;
  const collapsedKey = "panelCollapsed";

  async function shouldShow() {
    const { autoPrompt = true, [dismissKey]: dismissedAt } = await storage.get([
      "autoPrompt",
      dismissKey,
    ]);
    // Silenced entirely from the popup.
    if (autoPrompt === false) return false;
    // Dismissed recently for THIS profile. Per-profile rather than global,
    // because "not this one" and "not ever" are different intentions.
    if (dismissedAt && Date.now() - dismissedAt < DISMISS_HOURS * 3600_000) return false;
    return true;
  }

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );

  function styles() {
    return `
      :host { all: initial; }
      .wrap {
        position: fixed; top: 76px; right: 16px; z-index: 2147483000;
        width: 268px; box-sizing: border-box;
        font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif;
        color: ${T.ink};
        background: ${T.canvas};
        border: 1px solid ${T.line}; border-radius: 12px;
        box-shadow: 0 10px 30px rgba(0,0,0,.45);
        overflow: hidden;
      }
      .bar {
        display: flex; align-items: center; gap: 8px; padding: 9px 11px;
        background: ${T.panel}; cursor: pointer; user-select: none;
      }
      .mark { font-size: 12.5px; letter-spacing: .01em; }
      .mark b { font-weight: 800; }
      .mark span { font-weight: 300; color: ${T.muted}; }
      .toggle { margin-left: auto; color: ${T.muted}; font-size: 15px; line-height: 1; }
      .body { padding: 11px; display: grid; gap: 9px; }
      .row { display: flex; gap: 8px; align-items: baseline; }
      .k { color: ${T.muted}; font-size: 11.5px; min-width: 74px; }
      .v { font-size: 12.5px; }
      .warn {
        border: 1px solid ${T.warnLine}; background: ${T.warnBg}; color: ${T.warn};
        border-radius: 9px; padding: 8px 9px; font-size: 12px;
      }
      .warn b { font-weight: 700; }
      button {
        font: inherit; font-weight: 600; font-size: 12.5px; cursor: pointer;
        padding: 8px 12px; border-radius: 9px; color: ${T.ink};
        border: 1.5px solid transparent;
        background:
          linear-gradient(${T.canvas}, ${T.canvas}) padding-box,
          linear-gradient(135deg, ${T.gradFrom}, ${T.gradTo}) border-box;
      }
      button.ghost {
        background: transparent; border: 1px solid ${T.line}; color: ${T.muted};
        font-weight: 500;
      }
      button:disabled { opacity: .6; cursor: default; }
      .actions { display: flex; gap: 7px; }
      .msg { font-size: 11.5px; color: ${T.muted}; }
      .msg.ok { color: ${T.ok}; }
      .msg.err { color: ${T.warn}; }
      .hidden { display: none; }
    `;
  }

  function knownBody(d) {
    const bits = [];
    if (d.contacted) {
      // The only coloured thing on the panel, deliberately. It is the fact that
      // changes what the operator does next.
      const when =
        d.contacted.daysAgo === 0
          ? "today"
          : d.contacted.daysAgo === 1
            ? "yesterday"
            : `${d.contacted.daysAgo} days ago`;
      bits.push(
        `<div class="warn"><b>Already contacted</b> — ${esc(d.contacted.count)} message(s), last ${esc(when)}${
          d.contacted.channel ? ` on ${esc(String(d.contacted.channel).toLowerCase())}` : ""
        }.${d.contacted.ownedBy ? ` Owner: ${esc(d.contacted.ownedBy)}.` : ""}</div>`,
      );
    }
    const row = (k, v) =>
      v === null || v === undefined || v === ""
        ? ""
        : `<div class="row"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`;
    bits.push(row("Stage", d.stageLabel));
    bits.push(row("Owner", d.owner ?? "unassigned"));
    bits.push(row("Last move", d.daysSinceTouch === 0 ? "today" : `${d.daysSinceTouch} days ago`));
    bits.push(row("ICP score", d.icpScore === null ? "not scored" : `${d.icpScore}`));
    bits.push(row("Audit", d.auditScore === null ? "none" : `${d.auditScore}/100`));
    bits.push(row("Company", d.company));
    bits.push(
      `<div class="actions"><button data-act="open">Open in Venture OS</button>` +
        `<button class="ghost" data-act="dismiss">Not now</button></div>`,
    );
    return bits.join("");
  }

  function unknownBody(d) {
    return (
      `<div class="row"><div class="v">Not in the pipeline yet.</div></div>` +
      `<div class="actions"><button data-act="capture">Capture as lead</button>` +
      `<button class="ghost" data-act="dismiss">Not now</button></div>` +
      `<div class="msg" id="m"></div>`
    );
  }

  async function render(data) {
    const host = document.createElement("div");
    host.id = ROOT_ID;
    // Shadow DOM in closed mode: LinkedIn's stylesheet cannot reach in and ours
    // cannot leak out. The single appended node is the whole footprint.
    const shadow = host.attachShadow({ mode: "closed" });

    const { [collapsedKey]: collapsed = false } = await storage.get([collapsedKey]);

    shadow.innerHTML =
      `<style>${styles()}</style>` +
      `<div class="wrap">` +
      `<div class="bar" id="bar">` +
      `<span class="mark"><b>venture</b> <span>${data.known ? "in pipeline" : "capture"}</span></span>` +
      `<span class="toggle" id="tg">${collapsed ? "+" : "−"}</span>` +
      `</div>` +
      `<div class="body ${collapsed ? "hidden" : ""}" id="body">` +
      (data.known ? knownBody(data) : unknownBody(data)) +
      `</div></div>`;

    const body = shadow.getElementById("body");
    const tg = shadow.getElementById("tg");
    shadow.getElementById("bar").addEventListener("click", async () => {
      const nowCollapsed = !body.classList.contains("hidden");
      body.classList.toggle("hidden", nowCollapsed);
      tg.textContent = nowCollapsed ? "+" : "−";
      // Remembered per user, not per profile: it is a preference about the panel.
      await storage.set({ [collapsedKey]: nowCollapsed });
    });

    shadow.addEventListener("click", async (e) => {
      const act = e.target?.getAttribute?.("data-act");
      if (!act) return;
      e.stopPropagation();

      if (act === "dismiss") {
        await storage.set({ [dismissKey]: Date.now() });
        host.remove();
        return;
      }
      if (act === "open") {
        const { baseUrl } = await storage.get(["baseUrl"]);
        if (baseUrl && data.leadId) {
          await ask({ type: "openLead", leadId: data.leadId });
        }
        return;
      }
      if (act === "capture") {
        const btn = e.target;
        const msg = shadow.getElementById("m");
        btn.disabled = true;
        msg.textContent = "Capturing…";
        msg.className = "msg";
        // The service worker runs the same explicit flow the popup does. This
        // panel never drives LinkedIn's UI itself.
        const res = await ask({ type: "captureProfile", url: profileUrl });
        if (res?.ok) {
          msg.textContent = "Captured.";
          msg.className = "msg ok";
        } else {
          btn.disabled = false;
          msg.textContent = `Could not capture (${res?.error ?? "unknown"}).`;
          msg.className = "msg err";
        }
      }
    });

    document.body.appendChild(host);
  }

  (async () => {
    if (!(await shouldShow())) return;

    const res = await ask({ type: "lookupProfile", url: profileUrl });
    // Fail silent on anything unexpected. A panel that appears broken on someone
    // else's LinkedIn is worse than a panel that does not appear.
    if (!res?.ok || !res.data || typeof res.data.known !== "boolean") return;

    try {
      await render(res.data);
    } catch {
      document.getElementById(ROOT_ID)?.remove();
    }
  })();
})();
