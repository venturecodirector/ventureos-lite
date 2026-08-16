# P4 — the deals layer: migration plan and record

*playbook-v2 P4. Safety tag: `pre-deals`. Runner: `npm run deals:migrate -- --dry-run | --apply | --verify | --rollback`.*

---

## 1. Why this is invasive

Until now a Lead was two things at once: a **person** we are trying to reach, and a **piece of
work with money attached**. That is why "how much is in the pipeline" had no answer, why a
company that buys twice could only ever be worth one thing at a time, and why the win/loss
record (`DealOutcome`) hung off a contact rather than off a sale.

P4 splits them. The rule that governs everything below:

> **A lead owns the pre-deal journey (Researched → Replied). A deal owns the money journey
> (Qualified onward).**

## 2. Data model

Three new tables, all workspace-scoped and guarded like every other business table.

### `pipelines`
| column | notes |
|---|---|
| `key` | stable slug (`web-projects`, `grants`); unique per workspace. Seeds and migrations look things up by meaning, never by a name someone has renamed. |
| `name`, `position`, `is_default`, `archived` | configuration. Archived rather than deleted — a pipeline with deals in it cannot vanish without taking their history. |

### `deal_stages`
| column | notes |
|---|---|
| `pipeline_id`, `key`, `name`, `position` | a column on the board. |
| `probability` | 0–100. The forecast weight for any deal here that has not overridden it. |
| `rotting_days` | days in stage before the card is flagged. Null = a stage nothing rots in. |
| `kind` | `open` \| `won` \| `lost`. Dragging onto a terminal stage closes the deal. Matching on `kind` rather than on the stage's *name* is what survives someone renaming "Won" to "Signed". |

### `deals`
| column | notes |
|---|---|
| `lead_id`, `company_id` | both nullable, both kept. Erasing a lead must not erase the revenue record; a renewal can outlive the contact who introduced it. |
| `title`, `value` (integer HUF), `currency` | money is an integer forint (CLAUDE.md). |
| `expected_close_at`, `probability` | `probability` NULL means "whatever the stage says", so moving a card re-weights it until someone states an opinion. |
| `pipeline_id`, `stage_id`, `stage_entered_at` | position on a board, and the rotting clock. |
| `owner_id`, `status` (`OPEN`/`WON`/`LOST`), `closed_at`, `lost_reason` | `status` is separate from the stage so "is this live?" is answerable without knowing the workspace's stage names. |
| `source` | `"p4_migration"` on rows this migration created. **This is what makes the migration reversible** — rollback deletes exactly those rows and nothing a person added afterwards. |

### Columns added to existing tables
| table | column | why |
|---|---|---|
| `documents` | `deal_id` | the quote → contract → certificate chain hangs off the **deal** once one exists. A company that buys twice has two quotes; hanging both off the lead made them look like one chain with a duplicate step. Nullable — pre-P4 documents keep their lead link only. |
| `subscriptions` | `deal_id` | exactly the nullable column the P11 schema comment predicted. MRR still reads `company_id`, so none of the revenue maths changed; only commission attribution now prefers the deal's owner. |
| `deal_outcomes` | `deal_id` | an outcome closes a **deal**. Nullable: outcomes recorded before this layer existed have no deal behind them, and inventing one would fabricate money-journey history that never happened. |

`ProposalKind` gains `STAGE_PROBABILITY` for the quarterly win/loss recalibration (P4/c) — a
proposal in the existing approval queue, never a silent change.

## 3. Seeded pipelines

Two, per the playbook. They exist because they close on **different clocks**: a grant
application sits with the awarding body for weeks and is not rotting while it does.

**Web projects** (default)

| stage | probability | rots after | from lead stage |
|---|---|---|---|
| Qualified | 20 | 14d | `QUALIFIED` |
| Meeting booked | 40 | 10d | `MEETING_BOOKED` |
| Quote sent | 60 | 14d | — |
| Negotiation | 75 | 10d | — |
| Handed off | 90 | 7d | `HANDED_OFF` |
| Won | 100 | — | *(terminal)* |
| Lost | 0 | — | *(terminal)* |

**Grants**

| stage | probability | rots after |
|---|---|---|
| Qualified | 15 | 21d |
| Consultation booked | 30 | 14d |
| Application drafted | 50 | 30d |
| Submitted | 70 | 60d |
| Won / Lost | 100 / 0 | — |

Seeding is **idempotent and additive**: a pipeline that already exists is left exactly as the
workspace configured it, renamed stages and re-tuned probabilities included.

## 4. How existing state maps

| existing lead stage | becomes |
|---|---|
| `RESEARCHED`, `CONTACTED`, `ACCEPTED`, `REPLIED` | **stays a lead.** No deal. |
| `QUALIFIED` | a deal in *Qualified* |
| `MEETING_BOOKED` | a deal in *Meeting booked* |
| `HANDED_OFF` | a deal in *Handed off* |
| `NOT_NOW`, `DISQUALIFIED` | **stays a lead.** A parked or dead lead has no money journey to own. |

Derived fields, per migrated lead:

- **pipeline** — `pipelineKeyForLead()`: a signal tag, industry or company name containing
  *pályázat / palyazat / grant / tender / eu-forrás* routes to **Grants**; everything else to
  **Web projects**. Deliberately a small, printable rule — the dry-run shows the chosen
  pipeline per lead, so a wrong guess is visible *before* anything is written.
- **value** — the latest `DealOutcome.value` if there is one, else the newest quote's
  `totals.net`, else `0`. The source of each figure is printed in the `SRC` column.
- **status** — latest outcome: `WON` → WON, `LOST` → LOST, `POSTPONED` or none → OPEN. A
  closed deal is placed in its pipeline's terminal stage rather than in the mapped one.
- **owner** — `lead.ownerId`, unchanged.
- **expected close** — open deals: `stage_entered_at + 30 days`. Closed deals: the outcome date.
- **`stage_entered_at`** — copied from the lead, so the rotting clock does not restart at
  migration time and hide a card that has been stuck for a month.
- **relinks** — every document, subscription and outcome on that lead is pointed at the new
  deal (only where the link is still null, so a re-run cannot steal a hand-made link).

### What the migration deliberately does NOT do

**It does not touch `Lead.stage`.** The deals layer is *additive*: a lead in `MEETING_BOOKED`
stays in `MEETING_BOOKED` and gains a deal beside it. Moving leads backwards to `REPLIED`
would destroy the very state this migration exists to account for, and would turn rollback
from a delete into a reconstruction. The UI states the boundary instead: the lead board
separates the top-of-funnel columns from the money-journey ones and links across to the deal.

## 5. Rollback strategy

`npm run deals:migrate -- --rollback`

1. Find every deal with `source = "p4_migration"`.
2. Null `deal_id` on the documents, subscriptions and outcomes pointing at them.
3. Delete those deals.
4. **Leave the pipelines in place** — they are configuration, they may already carry
   hand-made deals, and deleting a pipeline someone has since renamed and re-weighted would
   throw away work the migration never created.

Leads are untouched throughout, so a rollback restores the pre-migration state exactly. The
`pre-deals` git tag covers the schema side; `scripts/backup.sh` covers the data side.

## 6. Dry-run record

Run on 2026-08-17, before the real migration, against the development database.

```
> ventureos-lite@0.1.0 deals:migrate
> tsx scripts/migrate-deals.ts --dry-run

P4 deals migration — mode: dry-run — 1 workspace(s)

=== workspace: Venture CO Group (cmsoygoe50000bp94ul47q2n7) ===

Leads by stage (every prior state, accounted for):
  RESEARCHED         230  stays a lead
  CONTACTED          105  stays a lead
  MEETING_BOOKED      55  → deal
  NOT_NOW             32  stays a lead
  TOTAL              422

Pipelines to create: web-projects, grants
Leads already migrated (skipped): 0

Deals to create: 55

  LEAD                      COMPANY                     FROM            PIPELINE      STAGE               STATUS           VALUE  SRC
  E2E Guest 1786483852890   E2E Co 1786483852890        MEETING_BOOKED  web-projects  Meeting booked      OPEN              0 Ft  none
  E2E Lead 1786483870710    E2E Co 1786483870710        MEETING_BOOKED  web-projects  Meeting booked      OPEN              0 Ft  none
  E2E Guest 1786483948953   E2E Co 1786483948953        MEETING_BOOKED  web-projects  Meeting booked      OPEN              0 Ft  none
  … 49 further rows, identical in shape (MEETING_BOOKED → web-projects/Meeting booked, OPEN, 0 Ft, src=none) …
  E2E Guest 1786915300074   E2E Co 1786915300074        MEETING_BOOKED  web-projects  Meeting booked      OPEN              0 Ft  none
  E2E Guest 1786915584415   E2E Co 1786915584415        MEETING_BOOKED  web-projects  Meeting booked      OPEN              0 Ft  none
  E2E Guest 1786915871656   E2E Co 1786915871656        MEETING_BOOKED  web-projects  Meeting booked      OPEN              0 Ft  none

Summary:
  pipeline web-projects   55
  stage    web-projects/meeting         55
  total deal value              0 Ft
  documents to relink           0
  subscriptions to relink       0
  outcomes to relink            0
```

**Reading the record.** The development database is dominated by Playwright fixtures, so the
mapping it exercises is narrow by accident, not by design: 55 `MEETING_BOOKED` leads, none
with an outcome, a quote or a grant signal, hence 0 Ft of value and no relinks. The one quote
in the database belongs to a lead in a stage the deals layer does not take over, which is
why `documents to relink` is 0.

The paths this run does *not* exercise — grant routing, WON/LOST placement in a terminal
stage, value from an outcome, value from a quote, document/subscription/outcome relinking,
idempotency on re-run, and rollback — are covered by
`test/integration/deals-migration.test.ts`, which builds each case explicitly against a real
database.

## 7. Post-migration integrity check

`npm run deals:migrate -- --verify` — exits non-zero if any check fails.

1. **Every deal-owned lead has a deal.** No `QUALIFIED`/`MEETING_BOOKED`/`HANDED_OFF` lead
   left without one.
2. **No migration deal on a top-of-funnel lead.** Nothing was converted that should not have been.
3. **Document chains intact.** Every chained document sits on the same deal as its parent.
4. **No orphaned deals.** Every deal resolves to a live pipeline, a stage *of that same
   pipeline*, and a live lead where it claims one.
5. **Outcomes linked.** No outcome left dangling beside a deal it should point at.

### Result of the real run — 2026-08-17

```
P4 deals migration — mode: verify — 1 workspace(s)

=== integrity: Venture CO Group (cmsoygoe50000bp94ul47q2n7) ===
  [PASS] every deal-owned lead has a deal
         55 leads across MEETING_BOOKED=55 each carry at least one deal
  [PASS] no migration deal on a top-of-funnel lead
         55 migration deal(s), all on Qualified/Meeting booked/Handed off leads
  [PASS] document chains intact
         0 chained document(s) share a deal with their parent
  [PASS] no orphaned deals
         55 deal(s) resolve to a live pipeline, a stage of that same pipeline and a live lead
  [PASS] outcomes linked to their deal
         0 outcome(s) checked; none left dangling beside a deal
  → OK
```

Applied: **55 deals, 2 pipelines (13 stages), 0 documents / 0 subscriptions / 0 outcomes
relinked.** No rollback required.
