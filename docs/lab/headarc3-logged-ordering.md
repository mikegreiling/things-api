# HEADARC3 — the logged-children ORDERING law (multi-day discrimination)

**Probed under:** golden `things-lab-golden-v1` · Things **3.22.11** · macOS 15.7.7 · DB schema v26 · guest clock **advanced 2026-07-05 → 2026-07-09** (one day per completion, warm relaunch between days). Campaign **2026-08-03**, one disposable clone (`lab/artifacts/headarc3-lab/`, gitignored — screenshots `01…05*.png` + `final.sqlite` + `report.txt`), no crash. DB row deltas are ground truth; GUI order read off guest-side `screencapture -x` PNGs (framebuffer 2048×1536); the "Show N logged items" toggle was opened with a single `vncdotool` HID click (Accessibility is not granted in the golden). Build driver: `lab/scripts/research-headarc3.sh`.

Sibling to [HEADARC2](headarc2-residual-captures.md) (archived-heading residual captures, #372) — an immutable snapshot, **not** edited here. HEADARC2's captures were all **same-day**, so its "most-recently-completed first" could not distinguish `stopDate DESC` from `date DESC then index ASC` from `index ASC`. This campaign builds a **multi-day** fixture with a **same-day tiebreak pair** that separates all three.

## The maintainer's discriminating scenario

Project with heading "Foo" holding to-dos **A, B, C in that INDEX order**; complete them **B, then C, then A, across three distinct days**; observe the GUI order. HEADARC3 adds two more children **D, E** (same heading, index after C) completed **same day** in **index order (D then E)** — a fourth-day pair whose completion instants ascend with index, so a within-day `stopDate DESC` law renders **E, D** (reverse index) while a within-day `index ASC` law renders **D, E**. That pair is the discriminator HEADARC2 lacked.

## Fixture (byte evidence)

One `things:///json` call built project `HA3-Foo-P` in `LAB-AREA-A` with heading **Foo** (`type=2`, uuid `ATVevGHe2uDjo94U6JERWm`) and five children **A,B,C,D,E** in array (=index) order. Each headed child carries `project=NULL` + `heading=Foo` (the heading holds the project FK — the standard headed-child shape). Completions via `things:///update?completed=true` at the then-current guest clock:

| row | index | completed (guest day) | stopDate |
|---|---|---|---|
| A | −343 | 2026-07-07 (day 3) | 1783425612.78506 |
| B | −146 | 2026-07-05 (day 1) | 1783252835.62932 |
| C | −69 | 2026-07-06 (day 2) | 1783339212.8695 |
| D | −32 | 2026-07-08 (day 4) | 1783512012.7785 |
| E | 0 | 2026-07-08 (day 4, +5.8 s after D) | 1783512018.60036 |

So **index order** is `A < B < C < D < E`; **stopDate order** is `B < C < A < D < E`; and D,E share a day with `stopDate(D) < stopDate(E)`. The three candidate laws therefore predict DISTINCT top→bottom orders:

- pure `stopDate DESC` → **E, D, A, C, B**
- `date DESC` then within-day `index ASC` → **D, E, A, C, B**
- `index ASC` → **A, B, C, D, E**

## Captures & verdicts

### HEADARC3-1 — flat project logged toggle, heading Foo OPEN (`02-project-logged-shown-headingopen.png`)

The heading **Foo** renders as an ordinary active (blue) section header with **no open children** (all swept); its swept children sit in the **flat project-level** "Show 5 logged items" toggle. Expanded, the rows top→bottom:

`☑ Jul 8  E (Foo)` · `☑ Jul 8  D (Foo)` · `☑ Jul 7  A (Foo)` · `☑ Jul 6  C (Foo)` · `☑ Jul 5  B (Foo)`

→ order **E, D, A, C, B**. It is a **CONTINUOUS list** — each row carries its own muted `Jul N` completion-date label, and there are **no day-group section headers**. Each row also carries a muted **`Foo` HEADING sublabel** (re-confirms HEADARC2-B: the in-project toggle labels the heading). The same-day pair renders **E before D** (E's stopDate is 5.8 s later) → within-day tiebreak is the **completion instant (stopDate DESC), NOT index** (index would give D,E).

**Verdict:** flat project logged region = **`stopDate DESC`, continuous (no day grouping), most-recently-completed first**, same-day tiebreak by completion instant.

### HEADARC3-2 — archived-heading group (`05-project-archivedheading-shown.png`)

Archive Foo (certified AS `set status of to do id … to completed`; Foo → `status=3`, stopDate `1783598622.53585`; children unchanged). Default view collapses to "Show 6 logged items" (heading + 5 children; the archived heading is invisible in the default view — HEADARC2-A). Expanded, **Foo renders as a grouped section header** (bold title, hover `⋯`, divider rule — HEADARC2-A styling) with its children nested top→bottom:

`☑ Jul 8  E` · `☑ Jul 8  D` · `☑ Jul 7  A` · `☑ Jul 6  C` · `☑ Jul 5  B`

→ order **E, D, A, C, B**, per-row `Jul N` date, **NO per-child sublabel** (the group header supplies the heading context — HEADARC2-A). Same-day pair again **E before D**.

**Verdict:** archived-heading group children = **`stopDate DESC`, most-recently-completed first**, same-day tiebreak by completion instant — identical sort to the flat region.

### HEADARC3-3 — global Logbook (`03-logbook-headingopen.png`)

The Logbook **is day-grouped** with section headers — **`Yesterday`** (= Jul 8) then **`July`** (older days), most-recent day first:

- Yesterday: `☑ Jul 8  E (HA3-Foo-P)` · `☑ Jul 8  D (HA3-Foo-P)`
- July: `☑ Jul 7  A (HA3-Foo-P)` · `☑ Jul 6  C (HA3-Foo-P)` · `☑ Jul 5  B (HA3-Foo-P)` · then the golden's Jul-3 seed rows

→ order **E, D, A, C, B**, within-day pair **E before D**. Each row is labeled with its date + the **PROJECT** sublabel `HA3-Foo-P` (NOT the heading) — re-confirms the HEADARC2-B two-view asymmetry (in-project toggle labels HEADING; global Logbook labels PROJECT).

**Verdict:** global Logbook = **day-grouped (Yesterday / month sections), most-recent day first, within-day `stopDate DESC`**, project sublabel. Same underlying sort as the project toggle; only the SHAPE differs (Logbook adds day-section headers, the project toggle does not).

## The answer to the maintainer's literal scenario

Complete B (day 1), C (day 2), A (day 3). In every context the three render **A, C, B** top→bottom — most-recently-completed first (`stopDate DESC`). Not `index ASC` (would be A, B, C) and not entry order.

## Established law (all three contexts)

The logged region orders swept children by **`stopDate DESC`** — most-recently-completed first — and the **within-day tiebreak is the completion instant (still `stopDate DESC`), NOT child `index`**. This holds identically for the flat project logged toggle (heading open), the archived-heading group, and the global Logbook; the only inter-context difference is SHAPE: the global Logbook interposes day-section headers (`Yesterday`/month), the in-project toggle/group is a single continuous list with per-row date labels. Sublabel by view is unchanged from HEADARC2-B (in-project toggle → HEADING; Logbook → PROJECT; archived group → none).

## Shipped rendering — CONFIRMED, no divergence

Our reader already implements exactly this law:

- flat project logged region — [`src/read/project-view.ts`](../../src/read/project-view.ts) `logged.sort((a,b) => (b.stopped ?? 0) - (a.stopped ?? 0))` = `stopDate DESC` (full-timestamp, so same-day ties resolve by instant, matching the GUI).
- archived-heading group children — same `stopDate DESC` sort over `sweptHeadingChildren`.
- `logbook` view + the `project-view` `logbook`/`logged` wire — [contract](../contract.md) "Read views" rows already claim `stopDate DESC`; the flat continuous shape (no day grouping inside the project toggle) matches our flat `logged: Todo[]` / `loggedHeadings[].items` — **no shape change**.

The contract's `stopDate DESC` claim is confirmed (a full timestamp inherently specifies the within-day order), so per the version-stamping doctrine the confirmation accrues in the [assumption register](../reference/assumption-register.md) (RD-7, *Confirmed under* `3.22.11`), not by editing the contract. The multi-day/same-day law is newly LOCKED by two regression tests in [`test/cli/render.test.ts`](../../test/cli/render.test.ts) ("HEADARC3: flat project logged region…" and "…archived-heading group…") — a fixture with index order A,B,C,D,E but stopDate order B,C,A,D,E, asserting both regions render `E,D,A,C,B` (proving `stopDate DESC` over `index ASC`).

## Notes

- Nothing genuinely odd surfaced — no oddities entry. The one structural fact re-observed (headed children carry `project=NULL`, the heading holds the project FK) is already the reader's model and is exercised by the test fixtures.
- Teardown: clone `headarc3-lab` stopped + deleted; only `things-lab-golden-v1` (stopped) remains. No stray `tart run` process.
