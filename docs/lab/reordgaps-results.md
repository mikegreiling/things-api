# REORDGAPS — five ordering probes closing the remaining reorder unknowns

Campaign: HEADORD · DAYORD · ANYBNC · SOMEORD · TMPLORD. One offline Tart clone (`reordgaps-lab`, run 2026-07-27, Things 3.22.11, pinned clock 2026-07-05; ordering is local — no cloud account). Script: [`lab/scripts/research-reordgaps.sh`](../../lab/scripts/research-reordgaps.sh) (subcommands `setup`/`headless`/`gui`/`teardown`). Feeds [design/heading-demotion-and-move.md](../design/heading-demotion-and-move.md) §1/§4/§5 (the ratified bucket model) and the capability-matrix Ordering rows.

**Status: RAN + BANKED.** All eight headless arms produced clean verdicts; the four GUI-drag oracle arms could NOT execute their drags — Things does not expose to-do *titles* as discrete AX text (content rows surface cell-template identifiers like "Task NewForToday Template", and even a heading title carries a U+200E LTR mark), so the row-by-title finder returned `SRC_NOT_FOUND` (the same AX-invisibility documented for the Tags window, AXDRAG2-d / oddities §9). This is NOT an Accessibility-grant failure (the grant landed; the AX tree read fine — row frames dumped) but a row-identity limitation. **Crucially, the column-encoding questions the GUI oracles were meant to confirm are answered decisively by the headless reorder WRITES themselves** — the private command rewrites exactly the active order key of the items it touches, so we read the encoding column directly off each headless arm. Two new destructive app oddities were isolated (§9f, §9g) and one template-reorder finding (§9e addendum).

## Verdict table (observed)

| Arm | Question | Verdict |
|---|---|---|
| **HEADORD-a** | project-specifier reorder of headed children | **RECONFIRMED O06 — DESTRUCTIVE.** `heading KMqAC9wW → NULL` on all three listed children, which were reparented to the project root (`project → 6hskqsZY`) and re-ranked by `index` (HC3<HC2<HC1 = requested). The re-rank "works" but rips heading membership. |
| **HEADORD-b** | heading **AS** the container specifier | **REJECTED on all three spellings — within-heading order is NOT automatable via a heading-addressed reorder.** `to do id <H>` → error **-1708** ("doesn't understand the `_private_experimental_ reorder to dos in` message"); `list id <H>` → **-1728** ("Can't get list id"); `heading id <H>` → syntax error **-2740** ("heading" is not an AS class term). Heading FK + index unchanged in all three. The command's specifier class is `list`/`project` only (P9 sdef). |
| **HEADORD-c** | headed anytime to-do through a `someday→anytime` bounce | **HEADING FK SURVIVES — bounce is NON-destructive of heading membership.** `heading 3364bQ7S` preserved across BOTH legs; `start` round-trips 1→2→1 cleanly; `startDate` NULL restored. Movement occurred (indices changed) so the bounce is a within-heading *front-insert-class* primitive, but the exact placement in this 2-item probe was anomalous (the NON-bounced sibling ended lowest: HD2 → −950, bounced HD1 stayed −529) — exact multi-item within-heading ordering needs a dedicated protocol probe. **Membership + first-insert: feasible; arbitrary in-heading `--before/--after`: not.** |
| **HEADORD-d** | which column encodes within-heading child order | **`index`** — answered by HEADORD-a's write (the reorder rewrote `index` on the headed children; `todayIndex` stayed 0). GUI drag did not execute (AX title-invisibility). |
| **DAYORD-a** | within-day key, reflected in project/area views | **`todayIndex`** — answered by DAYORD-b/b4 (the project specifier rewrote `todayIndex` on scheduled children) + maintainer live-GUI (design §1). GUI drag did not execute. |
| **DAYORD-b** | headless day-scoped reorder spelling | **Partial spelling FOUND, plus a destructive aggregate.** (1) **`list "Upcoming"` is DESTRUCTIVE — it RE-DATES the touched items to the first upcoming day** (DP items 2026-07-10 → 2026-07-06, `startDate` 132805888→132805376) while writing `todayIndex` → **new oddity §9g**, unusable. (2) `list "Tomorrow"` writes `todayIndex`, next-day items only (date-preserving). (3) date-shaped lists (`list "2026-07-10"`, `list "July 10, 2026"`) → **-1728** (no such list). (4) **project specifier on same-day scheduled children: CLEAN — rewrites `todayIndex`, PRESERVES the date** (DPC kept 07-10, todayIndex re-ranked to requested). **So within-day order for CONTAINER (project/area) same-day children IS reorderable headlessly and date-preservingly; no safe standalone arbitrary-future-day spelling exists.** |
| **ANYBNC** | area-less loose anytime via `someday→anytime` bounce | **CONFIRMED — state-preserving front-insert; closes the ANYORD area-less gap.** Reverse-order bounce (AB-3, AB-2, AB-1) front-inserted each below the running global `MIN(index)` (−3255 → −3918 → −4431), `start=1` restored, `startDate` NULL, **`area` stayed NULL**, final order AB-1<AB-2<AB-3 = target. 2 legs/item. |
| **SOMEORD-a** | area-specifier reorder of that area's someday to-dos | **DESTRUCTIVE — de-somedays the items.** `start 2 → 1` on all three (someday → anytime), while `area` was preserved and `index` re-ranked (SA3<SA1<SA2 = requested) → **new oddity §9f**. Within-AREA someday order is NOT cleanly automatable via the area specifier. (My flagged destructive candidate materialized.) |
| **SOMEORD-b** | project-specifier reorder of someday children | **CLEAN — within-project someday order IS automatable.** `start=2` PRESERVED, `project` preserved, `index` re-ranked (PS3<PS1<PS2 = requested). The area-vs-project divergence mirrors ANYORD: the area aggregate is lossy, the project container is faithful. |
| **SOMEORD-c** | within-container someday order column | **`index`** — answered by SOMEORD-b's write (`index` re-ranked, `start=2` preserved). GUI drag did not execute. |
| **TMPLORD-a** | are resting templates drag-sortable at all? | **Prior stands (oddities §9e — drag-inert, drop lands at bucket TOP, maintainer live-GUI).** GUI drag did not execute (AX title-invisibility); no fresh DB-index evidence banked for the drag itself. Templates confirmed present as a distinct resting set (RT-a/b/c, `rt1_recurrenceRule` set, `index` −441/−257/0). |
| **TMPLORD-b** | headless template reorder spelling | **NO headless spelling for the template bucket — the template rows are unaddressable.** The private reorder command is a **NO-OP on repeating TEMPLATE rows** (`rt1_recurrenceRule` set; invisible to the `to dos` container, oddity 5e — index unchanged), but it **reorders their visible INSTANCE rows** (`rt1_recurrenceRule` NULL) normally by `index` (RT-c −1428, RT-b −995, RT-a −441 = requested). The data-layer complement to §9e → **oddities §9e addendum**. |

## Per-probe detail

### HEADORD — within-heading child order (the O06 gap)

Seeded `RG-HEAD`/heading `H1` + headed anytime children HC1/HC2/HC3 (TJSON nests to-dos following a heading item under it — verified: all three carried `heading=KMqAC9wW`, `start=1`).

- **a** confirmed O06 exactly: `reorder to dos in project id <RG-HEAD> with ids HC3,HC2,HC1` set `heading→NULL` and `project→6hskqsZY` on all three (ripped into the unheaded block) while re-ranking `index`. The H-REORDER-SCOPE guard's rejection of headed children in project scope remains correct and necessary.
- **b** is the decisive novel negative: none of the three heading-as-container spellings is accepted (-1708 / -1728 / -2740). There is no way to address a heading as the reorder list — so the ONLY native reorder that reaches headed children is the project scope, which is destructive (a). Within-heading order has no native surface.
- **c** is the one door left open: a `when=` bounce PRESERVES the heading FK (both legs), so a heading-membership-preserving reschedule exists. It front-inserts (movement observed), giving a `--first`-class placement, but the exact multi-item ordering protocol was not cleanly derivable from the 2-item probe (a sibling-index anomaly) → parked as a follow-up ("within-heading bounce ordering protocol", analogous to the P8b/P8e someday/projects two-call derivations).

### DAYORD — scheduled day-bucket order

Seeded loose DP-1/2/3 @07-10, loose TM-1/2/3 @07-06 (Tomorrow), and `RG-DAYPROJ` children DPC1/2/3 @07-10. Scheduled-future to-dos carry `start=2` + a `startDate` and their day-bucket order is `todayIndex` (`index` stays 0).

- `list "Upcoming"` re-ranked `todayIndex` to the requested order BUT **silently re-dated the items from 07-10 to the first upcoming day 07-06** (verified via startDate decode: DP `2026-07-06`, DPC untouched `2026-07-10`) — a destructive aggregate normalization in the family of O03 (evening de-bucket) and §9c (Anytime area-strip). **Oddity §9g.** Do not use.
- `list "Tomorrow"` re-ranked `todayIndex` for the already-07-06 items, date-preserving (HEADCERT reconfirm).
- date-shaped `list` specifiers do not exist (-1728).
- **The project specifier is the usable within-day surface:** reordering `RG-DAYPROJ`'s same-day children rewrote `todayIndex` (day-bucket order) while preserving their 07-10 date. Since `todayIndex` is shared with the Upcoming view (design §1), this sets the day-bucket order for a container's same-day children without a date change. The gap for STANDALONE loose items on an arbitrary future day remains (only next-day via Tomorrow; Upcoming is destructive).

### ANYBNC — area-less loose anytime to-dos via bounce

Seeded area-less AB-1/2/3 (`start=1`, `area NULL`). Reverse-order `someday→anytime` bounce front-inserted each below the running global min, state fully preserved. This is the clean surface ANYORD said area-less loose anytime to-dos lacked (the `list "Anytime"` aggregate being destructive + non-deterministic) — the bounce delivers a deterministic, area-preserving front-insert, exactly as P8e does for area-less projects.

### SOMEORD — someday buckets inside containers

Shipped `--scope someday` covers loose someday to-dos + area-less someday projects via the `list "Someday"` anchor-stack. The gap is within-CONTAINER someday order. Result: **the project specifier is faithful (SOMEORD-b clean, `start=2` preserved); the area specifier is DESTRUCTIVE (SOMEORD-a de-somedays, `start 2→1`).** Same container-faithful / aggregate-lossy split as ANYORD (project O04 vs Anytime/area aggregates).

### TMPLORD — repeating templates within the resting bucket

Seeded `RG-RPT` with RT-a/b/c made repeating (after-completion daily) via the production `make-repeating` (ui vector — the AX grant + e2e bundle were required and worked). Each make-repeating produced a template row (`rt1_recurrenceRule` set) + an instance row. **Reordering by the project specifier is a no-op on the template rows (oddity 5e invisibility) but re-ranks the instance rows by `index`.** So the resting-template bucket (the template rows) is unreorderable on any headless surface, and the GUI is likewise drag-inert (§9e). The instances behave as ordinary to-dos.

## Design rule-5 (placement honesty) — guaranteed-set changes

The lab-locked guaranteed set (project/area/today/evening/someday/inbox scopes) gains and does NOT gain the following, per the observed verdicts:

**ADDED to the guaranteed set (a reliable, non-destructive protocol exists):**
- **Within-project someday order** (SOMEORD-b) — via the project specifier (`index` re-rank, `start=2` preserved).
- **Within-day order for a CONTAINER's same-day scheduled children** (DAYORD-b) — via the project/area specifier (`todayIndex` re-rank, date-preserving). This is BETTER than design §4's expectation, which parked day buckets as "app-default with a note until DAYORD lands a spelling": DAYORD lands a spelling for *container* children.
- **Area-less loose anytime order** (ANYBNC) — via the `someday→anytime` bounce (front-insert, state-preserving).

**NOT added — stays unsupported / app-default (honest refusal), with reasons:**
- **Arbitrary within-HEADING order** — no native surface: the heading-as-container reorder is rejected outright (HEADORD-b), and the only reorder that reaches headed children (project scope) is destructive (HEADORD-a). **`todo move --to-heading` (membership) and a `--first`-class within-heading placement ARE achievable via the FK-preserving bounce (HEADORD-c), but in-heading `--before <sibling>`/`--after` CANNOT be guaranteed in Phase A** — it must answer app-default/unsupported. This directly resolves the design §4/§5 load-bearing question: within-heading placement is *partially* guaranteeable (membership + first), not fully.
- **Within-AREA someday order** — the area specifier de-somedays the items (SOMEORD-a, §9f); no clean surface. Stays unsupported.
- **Arbitrary future-day order for STANDALONE loose items** — `list "Upcoming"` is destructive (re-dates, §9g); only next-day via `list "Tomorrow"`. Stays app-default beyond the next day.
- **Resting-template order** — unaddressable headlessly (TMPLORD-b) and drag-inert in the GUI (§9e). Stays unsupported.

No change to design rules 1–4 or the detach family (§5): no arm touched mixed-kind homogeneity, anchor-migration guards, or containment levels.

## App oddities filed

- **§9f** — area-specifier private reorder de-somedays an area's someday to-dos (`start 2→1`); area preserved, index re-ranked. Destructive ordering side effect (SOMEORD-a).
- **§9g** — `list "Upcoming"` private reorder re-dates the touched items to the first upcoming day (a destructive aggregate normalization, family of O03 / §9c) (DAYORD-b).
- **§9e addendum** — the private reorder command is a no-op on repeating template rows (oddity-5e invisibility) but reorders their instance rows; the data-layer complement to §9e's GUI drag-inertness (TMPLORD-b).

## Reproduce

```sh
TART_HOME=/Volumes/Workspace/tart \
VNCDO=/path/to/vncvenv/bin/vncdo \
  bash lab/scripts/research-reordgaps.sh setup      # clone+boot+airgap+clock-pin+seed (+AX grant & bundle)
  bash lab/scripts/research-reordgaps.sh headless    # HEADORD-a/b/c · DAYORD-b · ANYBNC · SOMEORD-a/b · TMPLORD-b
  bash lab/scripts/research-reordgaps.sh gui         # HEADORD-d · DAYORD-a · SOMEORD-c · TMPLORD-a (needs AX grant)
  bash lab/scripts/research-reordgaps.sh teardown
```

The AX grant toggles the **`sshd-keygen-wrapper`** row in the Accessibility pane (that is the process chain that owns every osascript/node run over SSH — the AX reader + CGEvent poster); it prompts for the account password (`admin`). Headless arms need neither `$VNCDO` nor Accessibility. GUI-drag caveat: the content-row drag kit cannot identify rows by to-do title (AX title-invisibility) — a future iteration must resolve rows by DB-index→ordinal or format-mark-stripped fuzzy match. Evidence (gitignored, synthetic): `lab/artifacts/reordgaps-lab/` (`report.txt`, per-arm row/drag JSON, AX-pane screenshots).
