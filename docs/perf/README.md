# Performance at scale — the P6/3 report

*playbook-v2 P6/3. Target: smooth at 5,000 leads and 2,000 deals.*

```
npm run seed:scale                    5,000 leads + 2,000 deals (idempotent)
npm run seed:scale -- --clean         remove them again
npm run perf                          measure
npm run perf -- --save NAME           measure and record
npm run perf -- --compare before after
```

> **Run `--clean` before `npm run test:e2e`.** The browser suite shares one
> workspace and was written against a small one: with 2,000 seeded deals in it,
> a deal a test has just created is not in the first 25 cards of its column, so
> the column cap correctly hides it and the assertion correctly fails. The
> fixture is for measuring, not for driving the UI.

## The fixture

`scripts/seed-scale.ts` builds 5,000 leads across 3,572 companies and 2,000
deals, deterministically (a fixed-seed PRNG, so two runs produce the same
database). It is realistic where realism changes the timings: leads are spread
across stages in roughly the shape a funnel has rather than evenly, names carry
Hungarian accents — the fuzzy search folds every candidate, and folding is the
cost — a third carry extra signals, and deals sit across both pipelines with
close dates spread over six months so the forecast has something to group.

Measured on the development machine against Dockerised Postgres 16, with 5,530
leads and 2,067 deals in the workspace (the fixture plus what was already
there). Median of 7 runs after a discarded warm-up. Median rather than mean:
one GC pause should not decide whether an optimisation counts.

## Before and after

| interaction | before | after | |
|---|---:|---:|---|
| leads table — first page, unfiltered | 94.6 ms | **10.9 ms** | −88% |
| leads table — filtered by stage + score | 92.8 ms | 87.5 ms | −6% |
| pipeline board — page load | 131.3 ms | **7.9 ms** | −94% † |
| deals board — one pipeline | 37.5 ms | **5.3 ms** | −86% |
| forecast — six months, every pipeline | 17.6 ms | 15.1 ms | −14% |
| global search — fuzzy fallback | 96.5 ms | 97.0 ms | — |
| select-all-matching — resolve the id set | 91.0 ms | 79.8 ms | −12% |
| duplicate scan (Settings, lead banner) | *page timeout* | **107 ms** ‡ | see below |

‡ **The one the fixture caught.** The duplicate detection added in P5/2 compared
every company with every other one: 3,572 companies is 6.4 million edit-distance
computations, on every Settings load AND every time a lead modal opened its
"possible duplicate" banner. It never showed up at 400 leads, and at 5,000 it
timed the Settings page out at 30 seconds — the browser tests failed before I
had finished reading the numbers. Fixed two ways: **blocking** (compare only
candidates that already agree on the first three characters of the normalised
name, the standard record-linkage answer) and the same 60-second cache the
other aggregates use, invalidated the moment a merge or an undo happens. The
lead-duplicate pass was grouped by company first, for the same reason — the
rule is "similar name at the same company", so comparing 5,000 leads pairwise
and then discarding the mismatches did 30 million pointless checks.

The trade in blocking is explicit and worth stating: two names differing in
their first three characters are no longer compared. "Danubia" vs "Danúbia"
still blocks together, because accents fold first; "Danubia" vs "Anubia" no
longer does. A typo in the first three letters of a company name is rare; an
unusable Settings page is not.

† The pipeline row is renamed between the two files, because what the board
*does* changed: before it fetched every lead in the workspace, after it fetches
25 per column. The comparison is between the old whole-workspace read (5,530
cards) and the new capped one (225 cards) — which is the honest comparison,
since those are the two things the page actually did.

## What changed, and why each one

**Kanban columns are capped at 25 with "load more"** — both boards. The lead
board was fetching and painting 5,530 cards that nobody scrolled to. The cap is
per STAGE rather than per board: a board-wide limit empties the late columns,
because the oldest cards are all in the first one. One query per column costs a
handful of round trips and keeps every column showing its own oldest cards,
which are the ones worth looking at.

**The leads table got a SQL fast path.** With no filter conditions and a
database-sortable column — every ordinary load of that screen — one count plus
one paged query replaces reading the whole workspace into memory. The slow path
is still there and still required: `filters.ts` explains why the predicates
cannot live in a `where` clause, so a *filtered* table genuinely has to pass
over every row. That is why the filtered row above barely moved, and it is the
honest limit of this change.

**The registry join left the bulk read.** `avatarPath`, `sizeBand` and the
registry risk flags are display-only, and joining `registry_data` 5,000 times to
render 50 rows was a third of the query's cost. They are hydrated for the page
rows afterwards, in one extra query for ≤50 ids.

**Facets are cached for 60 seconds.** The filter dropdowns' contents are
distinct values across every lead — an inherently whole-table question — and
they change when somebody types a new city, which is not something a dropdown
has to notice within the second. Caching them is what lets the fast path exist
at all. The analytics aggregates are cached the same way and for the same
reason.

**Optimistic UI with real rollback** on stage moves (both boards) and task
completion. The card jumps or the tick moves immediately; a refusal — the score
gate, the qualification gate, a concurrent edit — puts it back exactly where it
was and says why. An optimistic update that cannot roll back is not optimism,
it is a lie the user finds out about on the next refresh.

## What was NOT done, and why

**DOM virtualisation.** The playbook asks to "virtualize long lists (leads
table, prospector results, notification list)". All three are already bounded
at the QUERY: the leads table pages at 50, the prospector takes 20–25, the
notification bell has its own limit. Windowing a 50-row table is machinery with
no user visible in it. Bounding the query is strictly better than fetching
5,000 rows and hiding 4,950 of them — the row that is never fetched costs
nothing to serialise, transfer or garbage-collect.

**Cursor pagination on the leads table.** It cannot help where the filtering
happens in memory: the page boundary is an index into an array the server
already holds, and a cursor would describe a position in a set the database
never computed. The fast path uses `skip`/`take` with a total order (`sort
column, then id`) so a row cannot swap pages between requests, which is the
actual failure cursors exist to prevent.

**Indexes.** `EXPLAIN ANALYZE` says the queries are 1–2 ms; a sequential scan is
the correct plan when the workspace IS the result set. The ~90 ms was Prisma
deserialising 5,530 rows and building 5,530 objects, which no index touches.
Adding indexes here would have been cargo cult — the fix was to stop asking for
the rows.

**The fuzzy search fallback** is unchanged at ~97 ms. It reads every lead,
company and document in the workspace by design (`search/fuzzy.ts` explains why
it is TypeScript and not `pg_trgm`), and it only runs when the exact pass found
nothing. It is the next thing to look at if the product outgrows ~50,000 rows —
the module already says so, and says to fix the RLS gap first. P6/2 fixed the
RLS gap.
