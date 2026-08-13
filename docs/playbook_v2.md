# Claude Code Playbook v4 — Venture OS
### Innovációs csomag: inbound-gép, sales-végrehajtás, árazás-intelligencia, adat-fal

*Használat, mint eddig: egy prompt = egy kiadás, futás után ellenőrzés + commit, fázisvégen VERIFICATION. Előfeltételek fázisonként jelölve. A P12 lead-mágnes részének hozzájárulási szövegeit élesítés előtt ügyvéddel nézesd át (Grtv. + GDPR) — a promptok a védhető konstrukciót építik, a szövegezés jogi kör.*

| Fázis | Tartalom | Előfeltétel | Becslés |
|---|---|---|---|
| P12 | Inbound-gép: publikus önkiszolgáló audit + szektor-riportok | v1 audit-motor, P8 tracking | 4–6 nap |
| P13 | Sales-végrehajtás: LinkedIn-overlay, meeting-utáni csomag, referral-aktiválás | v2 P2 e-mail, extension v2 | 4–5 nap |
| P14 | Árazás- és bevétel-intelligencia | P4 deals, P11 MRR, registry | 4–5 nap |
| P15 | Adat-fal: lookalike, beszélgetés-DNS, KKV digitális index | P12 (index-hez volumen) | 4–6 nap |

---

## P12 — Inbound-gép: az audit-motor kifordítása

```
Two features turning the audit engine into an inbound lead machine. One commit per lettered item. Hard rules: the audit worker is rate-limited and queued (a public form must not be able to DoS our own worker); every email captured requires explicit consent (this is our legal basis for follow-up — treat the consent record as a first-class object).

1. PUBLIC SELF-SERVE AUDIT.
   a) A public landing at the root of audit.ventureco.agency (existing share pages move under /r/<slug> with redirects for old links): Venture-branded, one input ("Mennyit ér a weboldala? Ingyenes átvilágítás 60 másodperc alatt"), URL submit → queued audit with a live progress view (reuse the progressive results UI). Anti-abuse: rate limit per IP (3/day), honeypot + timing check, domain sanity validation, blocklist for our own and already-client domains (those get a friendly "ügyfelünk vagy — szólj és nézzük együtt" message), max concurrent public audits (queue with position indicator).
   b) TEASER vs FULL report split: the instant on-page result shows the overall score, 3 headline findings in plain language, and the two screenshots — deliberately valuable but incomplete. The FULL branded PDF + detailed findings unlock via a form: name, email, company name, and TWO separate checkboxes: (1) required — "kérem a teljes riportot e-mailben" (service delivery), (2) optional, unchecked — explicit marketing consent to be contacted about the findings (store consent text version, timestamp, IP — this consent is our lawful basis to follow up; leads without it get the report and NOTHING else). Full report delivered by Mailgun (transactional domain) with the PDF.
   c) CRM wiring: submission creates a Company + Lead (source: self_serve_audit) with the audit attached, deduped; consent status prominently on the lead card — a "no marketing consent" lead is visibly restricted (outreach composer shows a warning; cold campaign audience builder EXCLUDES them automatically). With consent → lead lands in a "meleg inbound" view at top of Today Queue with a suggested same-day follow-up task referencing their top finding.
   d) Analytics: funnel tracking on the page (visits → audits run → emails captured → consented) using the P8 first-party tracker; weekly counts in the Friday report.

2. SECTOR REPORTS (lead magnet + PR engine).
   a) Report builder (internal tool, Owner-gated): pick a sector + city/region → the system runs a Prospector search (with cost preview), audits the found websites in a throttled batch job (respect robots.txt, cache hits reused, configurable cap e.g. 150 sites), and aggregates ANONYMIZED statistics: score distribution, % without mobile layout, median load time, % missing allergen info (HoReCa), % missing impresszum/privacy, SSL/DMARC adoption, etc. No individual company is named or identifiable in the public output — aggregates and percentiles only (assert this in a test on the generated artifact).
   b) Output: a branded PDF report ("A budapesti fogászatok digitális állapota 2026 — N rendelő elemzése alapján") generated from a report template: cover, methodology note, headline stats with simple charts (render charts server-side on the brand palette), sector-specific findings, and a closing CTA to the self-serve audit page. One Sonnet call per report drafts the narrative text between the numbers (Owner reviews/edits before publish — the numbers are deterministic, only prose is AI-drafted).
   c) Distribution page: a public /reports section on the audit domain listing published reports; each downloads via the same email + dual-consent form as the full audit (same consent object, source: sector_report). Downloads create leads tagged with the sector.
   d) Content Hub integration: publishing a report auto-drafts 3 LinkedIn post variants (existing Claude drafting flow, human-edited and approved as always) teasing the headline stats.
   e) The batch audits feed the same AuditResult store — this is deliberately also the data collection engine for the P15 digital index.

VERIFICATION: a public URL submit produces the teaser, the form with consent unlocks the emailed full PDF, and a consented lead appears in the warm-inbound view; a non-consented lead is excluded from a test campaign audience; the sector builder produces an aggregate PDF where no company name appears (test asserts); rate limiting blocks a 4th same-IP audit.
```

---

## P13 — Sales-végrehajtás: overlay, follow-up csomag, referral-aktiválás

```
Three execution features. One commit per item.

1. LINKEDIN SMART OVERLAY (extension v3 — assistive, ToS-clean: reads only the page the user is viewing, never acts).
   When Fanni opens a LinkedIn profile or company page, the extension queries our API (authenticated, workspace-scoped) with the visible name/company/URL and renders a small, collapsible overlay panel: pipeline status if known ("már a pipeline-ban — Contacted, 3 napja"), ICP score with breakdown, latest audit score + top finding if the company was audited, last touchpoint, open tasks, warm signals (visitor signal, registry event), and the suggested hook from the lead card. If unknown: a one-click "Capture as lead" (existing capture v2 flow). Duplicate-prevention front and center: if ANY teammate already contacted this person, show who and when in red. The overlay must be read-only toward LinkedIn (no DOM automation, no injected actions into LinkedIn's UI beyond our own panel), fail silent when the API is unreachable, and respect a per-user toggle. Match the Venture design tokens in the panel.

2. POST-MEETING FOLLOW-UP PACKAGE. When a meeting outcome is logged, generate a ready-to-review follow-up kit within one flow: (a) a thank-you email draft summarizing what was discussed — sourced from the outcome form's structured fields plus optional pasted notes (one Sonnet call, human edits before send via the P2 composer); (b) attachments auto-suggested: the company's audit PDF if exists, relevant sector report if exists; (c) a pre-filled quote draft skeleton on the deal with the line items mentioned in the outcome form (deterministic from a service-item picker on the form — no AI in the quote); (d) a follow-up task at +3 days if no reply. The kit appears as a checklist on the meeting record; nothing sends without human action. Target: from outcome logged to email sent in under 10 minutes.

3. REFERRAL ACTIVATION. A BullMQ job watches for completion certificates acknowledged 14 days ago (the satisfaction peak): it creates a suggested task + a personalized referral-request email draft to the client (template with variables: their project, their industry, a concrete ask — "ismersz olyan [iparág] céget, akinek [a megoldott probléma] ismerős?"). Human reviews and sends via the composer. Tracking: sent referral requests get a state (sent / responded / produced referral), responses link to the Referrer ledger, and the Analytics referral view gains a "kérésből származó ajánlások" conversion metric. Per-client cooldown (max 1 request / 6 months) and a per-workspace toggle. No automation beyond drafting and timing.

VERIFICATION: the overlay shows pipeline status on a known profile and captures an unknown one; a logged meeting outcome produces the email draft + quote skeleton + task, and sending works through the composer; a certificate acknowledged 14 days ago (fixture) produces the referral draft task, and the cooldown blocks a second one.
```

---

## P14 — Árazás- és bevétel-intelligencia

```
Four intelligence features on the pricing/revenue path. One commit per item. Everything here is deterministic or approval-gated learning — no silent AI pricing.

1. REVENUE-BASED PRICING GUIDANCE. In the quote builder, when the client company has registry data (revenue band, headcount band), show a "javasolt sáv" panel next to the totals: a suggested price range per service category derived from a per-workspace pricing matrix (Settings → Pricing: service category × client revenue band → min/target/max, seeded with sensible defaults the Owner edits). The panel shows why ("árbevétel-sáv: 300M–1Mrd → weboldal-projekt céltartomány 1,2–1,8 M") and flags when the drafted quote is below min or above max for the band — advisory only, never blocks. Log the suggested band vs. the actual quoted amount for learning (feeds items 2 and the Signal Engine).

2. OWN-DATA PRICING BENCHMARK. Once ≥20 quotes exist per category, the quote builder also shows the historical view: median quoted amount, acceptance rate by price tercile, and days-to-decision for similar quotes (same service category, similar revenue band). Computed nightly into a benchmark cache; shown as a compact strip ("hasonló ajánlataid mediánja 1,4 M · elfogadás 55% · döntés átlag 9 nap"). Below the n=20 threshold show "még kevés adat" instead of noise. Quarterly, the Signal Engine proposes pricing-matrix adjustments from win-rate × price-band data (approval queue as always, min n=20 per cell).

3. QUOTE BEHAVIOR → SUGGESTED NEXT STEP. Build on the P8 quote analytics: a small rule engine (Settings-editable rules, seeded defaults) mapping behavior patterns to suggested actions — examples: 3+ opens without acceptance → task "hívd fel" + optional draft "részletfizetési opció" follow-up template; long pricing-section dwell + no scroll to scope → draft "pontosítsuk a tartalmat" call task; opened once then silence 7 days → gentle nudge draft. Each fires max once per quote per rule, creates a task + optional email DRAFT (human sends), and logs rule executions. Track which rules save quotes (acceptance after rule-fire) so the quarterly review shows rule effectiveness.

4. PROJECT → SUBSCRIPTION CONVERSION ENGINE. For the VentStudio migration: a "SaaS-érettség" score per past project client, deterministic inputs — project age, count of change/support requests since delivery (from activities), latest re-audit delta (schedule automatic re-audits of CLIENT websites every 6 months — flag consent/notice: these are our clients, note it in the engagement terms; the re-audit result attaches to the client), hosting/retainer already active, invoice payment reliability. Monthly job produces a ranked "SaaS-ready" list on the Revenue tab with per-client evidence and a suggested conversion pitch angle (which concrete audit finding or request pattern justifies the subscription). Suggested task for the top N. Conversion outcomes (converted / declined + reason) tracked so the score weights can be tuned in Settings.

VERIFICATION: a quote for a company with registry revenue band shows the suggested band and flags an out-of-band price; with 20+ seeded quotes the benchmark strip renders with correct median math; a fixture quote with 3 opens fires the call-task rule exactly once; the monthly SaaS-readiness job ranks a fixture client with high change-request count on top with its evidence listed.
```

---

## P15 — Adat-fal: lookalike, beszélgetés-DNS, digitális index

```
Three moat features that compound with data volume. One commit per item.

1. LOOKALIKE SEARCH FROM WON DEALS. When a deal is marked WON, offer "hasonló cégek keresése": build a lookalike profile from the client (TEÁOR/industry, revenue + headcount band, city/region, audit-score band, winning trigger signals) and generate a pre-configured Prospector search (with the usual cost preview) excluding companies already in the CRM. Results land as a saved search tagged with the source deal; converted lookalikes are tracked back to their seed ("a Danubia-lookalike keresésből 3 meeting lett") on the deal and in Analytics. Also available manually from any won deal or client. Deterministic matching — no AI call.

2. CONVERSATION DNA. Extend the weekly Signal Engine job: alongside frames/hooks, analyze the full touch-sequence shape of WON vs LOST deals — number of touches, channel order (message/call/email), timing gaps (first-touch→reply, reply→meeting, meeting→quote), and meeting count. Output per segment (industry × size band, min n=15): a "winning play" summary ("nyert HoReCa-dealek: 2. érintés hívás 70%-ban; válasz→meeting medián 4 nap") shown on a new "Playbook" panel in Analytics, and — the actionable part — Today Queue enrichment: when a lead's next suggested action diverges from the winning play for its segment, show a subtle hint chip ("ebben a szegmensben a hívás működik itt"). All computed in the existing weekly Sonnet call on aggregates (no new AI call sites — extend the prompt and output schema, version the prompt). Hints are suggestions only; no behavior is forced.

3. HUNGARIAN SMB DIGITAL INDEX (benchmark layer). Build the benchmark aggregation over ALL AuditResults (own runs + P12 public/self-serve + sector batches): per sector (TEÁOR group) and per check-category, compute distributions (percentiles for load time, score, mobile %, legal-compliance %), refreshed weekly, minimum n=30 per sector cell before a benchmark is shown (below that, fall back to the all-sector benchmark with a label). Surface: (a) in every audit report — internal, sales PDF AND public share/self-serve — a benchmark line per category: "Ez az oldal a [szektor] alsó 20%-ában van betöltési sebességben (n=214 audit)"; (b) a Benchmarks admin view showing sector coverage (which sectors have enough data, which need a P12 batch to unlock); (c) sector-report generation (P12) reuses these aggregates directly. Strictly aggregate + anonymized; a test asserts no company identifier leaks into benchmark outputs. Version the benchmark schema so historical reports keep their original benchmark context.

VERIFICATION: winning a fixture deal generates a lookalike search excluding existing CRM companies and the tracking links a converted lookalike to its seed; the weekly job (fixture data, n≥15) produces a playbook summary and a divergence hint appears on a matching lead; with 30+ seeded audits in one sector, the audit report renders the percentile line, and a sector below threshold falls back with the correct label.
```

---

## Zárás — v4 definition of done

```
Run the full test suite, typecheck and lint. Verify the P12-P15 VERIFICATION blocks end-to-end with evidence. Compliance audit: (1) consent records — every marketing-consented lead stores consent text version + timestamp + IP, non-consented leads are provably excluded from campaign audiences and outreach warnings render; (2) aggregate outputs — sector reports and benchmarks contain no company identifiers (tests green); (3) LinkedIn overlay — confirm it performs zero writes/automation toward LinkedIn. Budget audit: the only new AI call sites are the sector-report narrative (P12, per-report, Owner-triggered) and the post-meeting email draft (P13, per-outcome, user-triggered); Conversation DNA extends the existing weekly call — verify against the prompt registry and ClaudeUsage. Update docs/spec.md and docs/HANDBOOK.md (pricing matrix, consent handling, benchmark administration, report builder). Tag the release v4.0.
```

---

## Ajánlott sorrend a négy fázisra

**P12 → P14 → P13 → P15.** A P12 azonnal leadet termel (és adatot gyűjt a P15-höz), a P14 a margón dolgozik, a P13 a napi végrehajtást gyorsítja, a P15 pedig akkor ér a legtöbbet, amikor a P12 már hónapok óta töltötte az audit-adatbázist. Ha a szektor-riporttal (P12/2) akarsz nyitni PR-oldalról: az első riport szektorának azt válaszd, ahol már van referenciád és futó pipeline-od — a riport megjelenése után a szektor-leadek megkeresése hirtelen sokkal könnyebb lesz („mi készítettük a szektor-elemzést, az Önök oldala is benne volt a mintában").
