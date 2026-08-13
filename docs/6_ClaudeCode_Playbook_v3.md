# Claude Code Playbook v3 — Venture OS
### Jel-réteg, e-mail-intelligencia, magyar cégesemény-figyelő, bevétel-modulok

*Használat, mint a v1–v2-nél: egy prompt = egy kiadás, futás után ellenőrzés + commit, fázisvégen VERIFICATION. Előfeltétel: a v2 P2 (e-mail-szinkron) él, mert a P9 arra épül. Invazív séma-változás itt nincs, de a P8 és P9 személyesadat-közeli — a promptokba a GDPR-kezelés bele van írva, élesítés előtt a tájékoztató-szövegeket ügyvéddel nézesd át.*

| Fázis | Tartalom | Becslés |
|---|---|---|
| P8 | Jel-réteg: látogató-azonosítás + ajánlat-analitika + Public Pages statisztika | 4–5 nap |
| P9 | E-mail-intelligencia: 1:1 open/click tracking + cím-verifikáció | 3–4 nap |
| P10 | Magyar cégesemény-figyelő | 4–6 nap |
| P11 | Bevétel-réteg: MRR/ügyfél-egészség + post-sale mini projekt | 5–6 nap |

---

## P8 — Jel-réteg: ki nézi az oldalaidat

```
Two related features sharing one tracking infrastructure, plus an admin surface. One commit per lettered item. Privacy-first design is a hard requirement throughout: company-level identification only, no cross-site tracking, no third-party trackers, clear notice on every tracked page.

a) FIRST-PARTY TRACKING CORE. A tiny (<2 KB, no dependencies, self-hosted) tracking script served from our own domain, embedded ONLY on our public pages (audit share, quote acceptance, booking). It records: page view, referrer, timestamp, viewport class (mobile/desktop), session duration via heartbeat (15s interval, stops on blur), scroll depth, and per-section visibility time (sections marked with data-track-section attributes). Server-side: store the visitor IP for enrichment purposes but persist only a salted hash + the enrichment RESULT (company guess), never the raw IP beyond a 24h enrichment window (job deletes raw IPs). Honor Do Not Track and Global Privacy Control headers (no tracking beyond a bare view count). Add a short privacy notice line to the footer of every tracked public page ("Ez az oldal látogatottsági adatokat gyűjt a szolgáltatás működtetéséhez" + link to a simple privacy page). No cookies — session continuity via a sessionStorage token, so no consent banner is required for this measurement; document this reasoning in code comments for counsel review.

b) COMPANY-LEVEL VISITOR IDENTIFICATION. An enrichment worker resolves visitor IPs to companies where possible: reverse DNS (PTR) lookup → company domain heuristics; RIPE/whois org name lookup; match results against our Company records (domain match > name trigram match). Store an identification confidence level (high = PTR/org matches a known company domain; medium = org name fuzzy-matches; low/none = consumer ISP or unknown — the majority, be honest about this in the UI: "azonosítatlan látogató"). When a HIGH or MEDIUM confidence match hits a company that has a lead in our pipeline, create a VisitorSignal: "Danubia Kft. megnézte: audit riport — ma 14:32, 2 perc 40 mp" — surfaced as (1) a notification (existing notification center), (2) an activity on the lead timeline, (3) a warm-lead flag on the lead card for 7 days. Never present a guess as a fact: medium confidence renders as "valószínűleg". Rate-limit signals (max 1 notification per company per page per day).

c) QUOTE ANALYTICS. On the quote acceptance page specifically, use the section-level tracking to measure: total opens, distinct sessions, time on the pricing section vs. the scope section, scroll-to-bottom rate, and return visits. Surface on the quote document's admin view as a compact "Ajánlat-aktivitás" panel: open count, last open, total reading time, pricing-section attention, return-visit streak — plus an automatic signal when a quote is opened 3+ times without acceptance ("harmadszor nézte meg — hívd fel") as a notification + suggested task. Wire the same for audit share pages (simpler: opens, duration, return visits — the existing open tracking becomes a subset of this).

d) PUBLIC PAGES ADMIN VIEW. A new "Public Pages" section in the app listing every live public page (audit shares, quote pages, booking page) with per-page stats: total views, unique sessions, last view, average duration, and — per the visitor identification — a "Ki nézte?" column: identified company names with confidence badge and view count, or "n azonosítatlan látogató". Each row links to the page itself and to the related lead/deal. Filterable by type and date range; expired pages shown greyed with their lifetime stats. For pages tied to a specific target company (a quote sent to Danubia, an audit shared with Danubia), show prominently whether THAT company has viewed it: "A címzett cég megtekintette: igen, 2× (nagy bizonyosság)" / "címzett általi megtekintés nem igazolt".

e) GDPR & RETENTION. VisitorSignal and analytics data: 90-day retention, then aggregate-only (counts survive, sessions deleted). Raw IPs never persisted past 24h (verify with a test). Include visitor data tied to a lead in the erasure cascade. Add a one-page /privacy public route (Hungarian) describing the measurement, linked from tracked pages.

VERIFICATION: a visit from a datacenter/office IP with PTR produces a company match and a notification; a consumer-IP visit shows as unidentified; the raw-IP purge test passes; the quote admin panel shows section timings; the Public Pages view lists a quote with "címzett megtekintette" state; DNT header suppresses everything but the bare count.
```

*Elvárás-kezelés előre: a magyar mikro-KKV-k többsége lakossági netről böngészik, ott cég-szintű azonosítás nem lehetséges — a találati arány jellemzően a látogatók 10–30%-a. A rendszer ezért mutatja becsületesen a bizonyossági szintet; a valódi arany a d) pont „címzett cég megnézte-e az ajánlatot" jelzése, mert ott tudod, kinek küldted.*

---

## P9 — E-mail-intelligencia: tracking + verifikáció

```
Two features. One commit per item. Builds on the P2 email sync.

1. 1:1 EMAIL OPEN/CLICK TRACKING (personal emails sent from the app via Gmail). When composing from the app, an optional per-message "Követés" toggle (default ON, remembered per user) injects: a first-party tracking pixel (served from our domain, unique per message) and rewritten links through our redirect endpoint (first-party, preserving the visible URL text). Events: opened (with count and timestamps — note in the UI that Apple Mail Privacy Protection and image-blocking make opens indicative, not proof; label accordingly: "megnyitás jelzés"), link clicked (which link, when). Surface: on the email thread in the lead timeline (small "megnyitva 2×, utoljára ma 9:14" line), and a notification for the FIRST open of a quote/contract cover email specifically (these matter; don't notify on every newsletter-grade open). GDPR: every tracked email automatically gets a one-line footer notice ("Ez a levél megnyitás-visszajelzést tartalmaz — részletek: <privacy link>"); the toggle OFF sends completely clean mail; tracking data joins the lead erasure cascade; 90-day retention then aggregate. Cold campaign mail (Mailgun) keeps its existing webhook-based tracking — do NOT double-instrument it; unify the display so both sources render the same way on the timeline.

2. EMAIL VERIFICATION before cold sends (and available ad hoc). Layered, cheapest-first: (1) local checks: RFC syntax, disposable-domain blocklist (maintained list in repo), role-address detection (info@, office@ — flag, don't block); (2) DNS checks: MX record exists, domain resolves; (3) optional external verifier API behind a VerifierProvider adapter (configurable in Settings → Integrations like the other keys; NullProvider default so the system works without a paid service). Verification statuses: valid / risky / invalid / unknown, stored on the contact with checked-at date (re-verify if older than 90 days). Enforcement: the cold campaign audience builder runs verification on all recipients before a campaign can be armed — invalid addresses are excluded automatically, risky ones require explicit per-address confirmation, and the campaign summary shows the verification breakdown. The existing bounce circuit breaker stays as the last line of defense. Ad hoc: a "Verify" action on any contact email in the lead modal. Batch verification runs in the worker with rate limiting toward the external API and cost preview when a paid provider is configured.

VERIFICATION: a tracked email shows an open event and a clicked link on the timeline; toggle-off mail contains no pixel and no rewritten links (assert on raw MIME); a cold campaign with 1 invalid and 1 risky address arms only after the invalid is auto-excluded and the risky is confirmed; MX-check correctly fails a nonsense domain.
```

---

## P10 — Magyar cégesemény-figyelő (a hazai előny)

```
HUNGARIAN COMPANY-EVENT MONITOR. Watch official Hungarian company-registry events for (a) companies in our pipeline/portfolio and (b) prospecting segments, and turn them into actionable signals. PLAN FIRST: research the viable data sources and present options with cost before implementing — candidates: the existing registry provider's change-monitoring API (Opten/Céginformáció offer company-monitoring products — preferred, reliable, paid), and/or the public Cégközlöny (e-cegkozlony.gov.hu) publications. Respect terms of service; no circumvention of access controls; prefer the licensed API. Build behind the existing RegistryProvider adapter family as a new MonitorProvider interface with a MockProvider for dev.

a) WATCHLISTS. Two kinds: (1) automatic — every company with an open lead/deal or an active client relationship is watched by default (toggleable per company); (2) segment watch — Owner-defined rules like "new incorporations in TEÁOR codes X in Budapest/Pest" or "companies in our ICP industries entering felszámolás/végelszámolás" (available filters depend on the chosen provider's API; implement what it supports and document gaps).
b) EVENT TYPES & ROUTING. Normalize provider events into: new incorporation, address/headquarters change, executive change, capital increase/decrease, ownership change, liquidation/winding-up/enforcement proceedings, deletion. Routing: liquidation/enforcement on a watched pipeline company → urgent notification + red risk chip on the lead/deal + block on quote finalization (extend the existing liquidation warning); executive change on a prospect → signal + suggested task ("új ügyvezető — 90 napos ablak"); new incorporation matching a segment watch → auto-create a Researched lead (source: registry_monitor) with the registry data pre-filled, respecting dedupe; capital increase on a prospect → growth signal feeding the ICP score. Every event lands on the company timeline with the official source reference.
c) DIGEST & NOISE CONTROL. Events roll into the existing Monday digest ("cégesemények a héten" section) and only urgent ones (liquidation on active pipeline/client) notify immediately. Per-workspace caps on segment-watch lead auto-creation (default max 10/week, configurable) so a broad rule cannot flood the pipeline.
d) SIGNAL ENGINE INTEGRATION. Monitor-sourced signals (executive change, capital increase, new incorporation) become first-class trigger signals with their own conversion tracking — over time the Signal Engine reports which registry events actually convert.
e) COST CONTROL. Monitoring APIs price per watched company or per query: show the watched-company count and estimated monthly cost in Settings; warn before a segment rule would exceed a configurable budget.

VERIFICATION (with MockProvider): a mocked liquidation event on a pipeline company produces the urgent notification, risk chip and quote block; a mocked new-incorporation event auto-creates a deduped lead capped by the weekly limit; events appear in the Monday digest; the cost estimate reflects the watchlist size.
```

*Üzleti megjegyzés: az éles adatforráshoz kérj ajánlatot az Optentől és a Céginformációtól is a monitoring-termékükre (darabalapú áraik nagyságrendekkel eltérhetnek) — a kód provider-adapterrel készül, tehát a döntést az ár dönti el, nem a technika.*

---

## P11 — Bevétel-réteg: MRR/ügyfél-egészség + post-sale projekt

```
Two modules closing the revenue loop. One commit per lettered sub-item.

1. MRR / CUSTOMER HEALTH MODULE.
   a) Model: Client entity (a company promoted to client status when its first deal is won) and Subscription entity: linked client + deal, plan name, monthly net amount (integer HUF), billing day, start date, status (active / paused / churned with churn date + reason taxonomy), source (VentStudio / hosting / retainer / other). One-off revenues stay on deals; subscriptions carry the recurring book.
   b) MRR dashboard (Analytics gains a "Revenue" tab): current MRR, MRR movement chart (new / expansion / contraction / churn per month), ARR, client count, average revenue per client, and a subscriptions table with status filters. All computed from Subscription history events (append-only SubscriptionEvent log so the movement chart is exact, not reconstructed).
   c) Customer health: a simple traffic-light health score per client from deterministic inputs — invoice payment lateness (from the Számlázz.hu payment-status polling), months since last touchpoint (any activity/email/call on the client), open support-flag (manual toggle), and subscription age. Red clients surface in a "figyelmet igényel" list on the Revenue tab + Monday digest section; each red client gets a suggested task. No AI in the scoring — rules in Settings with sane defaults.
   d) Commission integration: a monthly job computes the BDR recurring commission per the employment contract logic — 10% of net recurring revenue actually PAID that month (payment-status = paid), per client, for clients within their 12-month commission window from first payment, attributed to the sourcing user via the lead's referral chain. Output: a monthly commission report (per user: base list of clients, window months remaining, paid amounts, commission due) exportable as branded PDF for payroll — computation only, no money movement. Include the termination lump-sum calculator: given an end date, remaining commission per the contract's 5.6 clause. Owner-only visibility, audit-logged report generation.
   e) Churn handling: marking a subscription churned prompts for reason, ends the commission accrual correctly (only payments received count), and feeds a churn-reasons breakdown on the Revenue tab.

2. POST-SALE MINI PROJECT MODULE.
   a) When a deal is marked WON, offer "Projekt indítása": creates a Project linked to the deal/client with a milestone checklist pre-filled from a per-workspace template library (e.g. "Weboldal projekt": kickoff meeting → tartalom beérkezett → design jóváhagyva → fejlesztés kész → átadás → teljesítésigazolás). Milestones: title, due date (offsets from project start in the template), owner, done state, optional note; plus free-form extra milestones.
   b) Views: a compact project board (list of active projects with progress bars and next-due milestone) and a project detail with the checklist; milestones integrate with the existing Tasks system (a milestone IS a task under the hood — reuse, don't duplicate: milestone completion = task completion, appears in Today Queue when due).
   c) Chain integration: the final milestone type "teljesítésigazolás" links directly to the certificate generator pre-filled from the deal's contract scope — completing the chain in one flow; a project cannot be closed while its certificate milestone is open. Overdue milestones notify the owner and appear in the Monday digest.
   d) Keep it deliberately small: no Gantt, no dependencies, no time tracking — a checklist with dates, owners and chain integration. Template editor for milestone templates in Settings (per workspace, versioned like document templates).

VERIFICATION: winning a deal offers project creation from a template; a milestone due tomorrow appears in Today Queue; the certificate milestone opens the pre-filled generator and blocks project close until issued; a paid invoice month produces the correct commission line for the sourcing user, and the movement chart shows a churned subscription as negative MRR in the right month.
```

---

## Zárás — v3 definition of done

```
Run the full test suite, typecheck and lint. Verify the P8-P11 VERIFICATION blocks end-to-end with evidence. Privacy audit: confirm raw visitor IPs cannot survive past 24h, tracked emails always carry the notice footer, DNT/GPC suppress tracking, and all new personal data (visitor signals, email events, subscriptions, projects) participates in the GDPR erasure cascade and retention jobs. Budget audit: diff Claude call sites against the prompt registry — P8-P11 must introduce ZERO new AI calls (everything here is deterministic). Update docs/spec.md with the new modules and docs/HANDBOOK.md with the Owner-facing features (watchlists, commission report, health rules, milestone templates). Tag the release v3.0.
```
