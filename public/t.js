/*!
 * Venture OS page measurement (playbook-v3 P8/a).
 *
 * No cookies, no third party, no cross-site identity: a random token in
 * sessionStorage keeps one reading session together and dies with the tab.
 * Honours Do-Not-Track and Global-Privacy-Control — those visitors send one
 * bare view and nothing else, ever.
 */
(function () {
  var d = document, n = navigator, s = d.currentScript;
  if (!s) return;
  var page = s.getAttribute("data-page"), slug = s.getAttribute("data-slug");
  if (!page || !slug) return;

  var dnt = n.doNotTrack === "1" || n.doNotTrack === "yes" ||
    window.doNotTrack === "1" || n.globalPrivacyControl === true;

  var tok;
  try {
    tok = sessionStorage.getItem("vo_t");
    if (!tok) {
      tok = (Math.random().toString(36) + Math.random().toString(36)).slice(2, 20);
      sessionStorage.setItem("vo_t", tok);
    }
  } catch (e) { tok = "nostore-" + Math.random().toString(36).slice(2, 12); }

  var url = "/api/t";
  function send(body, beacon) {
    var json = JSON.stringify(body);
    try {
      if (beacon && n.sendBeacon) {
        n.sendBeacon(url, new Blob([json], { type: "application/json" }));
        return;
      }
      fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: json, keepalive: true });
    } catch (e) { /* measurement must never break the page */ }
  }

  var base = { t: tok, p: page, s: slug };
  if (dnt) { send({ t: tok, p: page, s: slug, dnt: 1 }, false); return; }

  base.r = (d.referrer || "").slice(0, 300);
  base.v = window.innerWidth < 700 ? "mobile" : "desktop";
  send(base, false);

  // ---- attention ---------------------------------------------------------
  var ms = 0, pct = 0, sec = {}, live = d.hasFocus(), last = Date.now(), cur = null;

  function depth() {
    var h = d.documentElement.scrollHeight - window.innerHeight;
    var p = h > 0 ? Math.round(((window.scrollY || 0) / h) * 100) : 100;
    if (p > pct) pct = p > 100 ? 100 : p;
  }

  function visible() {
    // The section occupying the middle of the viewport is the one being read.
    var mid = window.innerHeight / 2, best = null;
    var els = d.querySelectorAll("[data-track-section]");
    for (var i = 0; i < els.length; i++) {
      var r = els[i].getBoundingClientRect();
      if (r.top <= mid && r.bottom >= mid) { best = els[i].getAttribute("data-track-section"); break; }
    }
    return best;
  }

  function tick() {
    var now = Date.now(), delta = now - last;
    last = now;
    if (!live || delta > 60000) return; // asleep, or the tab was backgrounded
    ms += delta;
    if (cur) sec[cur] = (sec[cur] || 0) + delta;
    cur = visible();
  }

  d.addEventListener("scroll", depth, { passive: true });
  window.addEventListener("focus", function () { live = true; last = Date.now(); });
  window.addEventListener("blur", function () { tick(); live = false; });
  d.addEventListener("visibilitychange", function () {
    if (d.hidden) { tick(); live = false; } else { live = true; last = Date.now(); }
  });

  function payload() {
    tick(); depth();
    return { t: tok, p: page, s: slug, d: ms, sd: pct, sec: sec };
  }

  var beat = setInterval(function () { if (live) send(payload(), false); }, 15000);
  window.addEventListener("pagehide", function () { clearInterval(beat); send(payload(), true); });
})();
