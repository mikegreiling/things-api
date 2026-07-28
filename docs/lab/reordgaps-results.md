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

---

# BOUNCE2 — Phase A.1 bounce-protocol campaign (the ordering unknowns REORDGAPS left open)

Second offline Tart clone (`bounce2-lab`, run 2026-07-27, Things 3.22.11, pinned clock 2026-07-05; ordering is local — no cloud account). Script: [`lab/scripts/research-bounce2.sh`](../../lab/scripts/research-bounce2.sh) (subcommands `setup`/`headless`/`confirm`/`teardown`). Four probes Mike ruled worth resolving before the Phase A.1 build: **BOUNCE2-h** (the HEADORD-c multi-item within-heading bounce ORDERING anomaly), **SOMEBNC** (someday re-entry position within a container, via `when=` bounce not the destructive area specifier), **BOUNCE2-t** (bounce cap timing calibration), **DAYORD-o** (fold DAYORD-b into the recurring o-suite as O17). All arms HEADLESS (URL / AppleScript) — no Accessibility, no VNC.

**Status: RAN + BANKED.** Every arm produced a clean deterministic verdict. Headline: the within-heading bounce ordering IS deterministic (the HEADORD-c anomaly is fully explained — it is a **back-insert**), so multi-item in-heading ORDER can now be promised; and SOMEBNC closes the §9f within-area someday gap via a state-preserving bounce, no destructive area specifier needed.

## Verdict table (observed)

| Arm | Question | Verdict |
|---|---|---|
| **BOUNCE2-h** | multi-item within-heading bounce ordering (the HEADORD-c anomaly) | **DETERMINISTIC — a `someday→anytime` bounce BACK-INSERTS a headed child (appends to the END of the heading bucket), heading FK preserved every leg.** The bounced item keeps its `index`; the app renumbers the NON-bounced siblings to lower indices so the bounced one sorts last. Reverse-order bounce → exact REVERSE order (5-item: `BV5..BV1` gave `BV5<BV4<BV3<BV2<BV1`); **FORWARD-order bounce → exact TARGET order** (4-item confirmation `BZ1,BZ2,BZ3,BZ4` → `BZ1<BZ2<BZ3<BZ4`, heading FK 4/4). This RESOLVES the HEADORD-c anomaly (single-bounce `HD1` appended to the end, sibling `HD2` renumbered below → "non-bounced sibling ended lowest"). **Compile-able protocol: to order headed children `T1..Tn`, bounce them `someday→anytime` in FORWARD order `T1,T2,…,Tn`** — the P9e-class inverse of the loose ANYBNC reverse-order front-insert. **In-heading ORDER is now promisable** (membership + first were already; arbitrary order joins them). |
| **SOMEBNC-area** | someday re-entry position for an AREA's someday members (via `when=` bounce) | **DETERMINISTIC FRONT-INSERT — closes the §9f gap without the destructive area specifier.** A `someday→anytime→someday` toggle re-enters BELOW the someday group min (`SBA2` re-entered at `idx=-1387` < prior group min `-1025`), area FK + `start=2` preserved. **REVERSE-order protocol → target order** (`SBA3,SBA2,SBA1` → `SBA1<SBA2<SBA3`). State CLEAN 3/3: `start=2`, `area` intact, `reminderTime` NULL, `deadline` NULL throughout (someday items carry no dated reminder — confirmed stays true). This is the within-AREA someday order surface SOMEORD-a lacked (the area reorder command de-somedays, §9f). |
| **SOMEBNC-project** | someday re-entry position for a PROJECT's someday children (via `when=` bounce) | **DETERMINISTIC BACK-INSERT — a second clean path (SOMEORD-b's native project reorder was the first).** A `someday→anytime→someday` toggle appends to the END (`SBP2` toggled: sibling `SBP3` renumbered `0→-306`, `SBP2` sorts last), project FK + `start=2` preserved. **FORWARD-order protocol → target order** (`SZP1,SZP2,SZP3` → `SZP1<SZP2<SZP3`, CLEAN 3/3). Same back-insert law as headed children; contrast the area's FRONT-insert. |
| **BOUNCE2-t** | wall-clock cost per bounced item @ 10/20/30 | **~110 ms/item, linear.** Guest-local timing (URL open + DB-poll verify per leg, 2 legs/item, excludes host↔guest SSH RTT): 10 items 1215 ms (121 ms/item, incl. a 176 ms warm-up), 20 items 2169 ms (108 ms/item), 30 items 3365 ms (112 ms/item). 30 items ≈ 3.4 s guest-local on an idle clone. Each item = **2 verified mutations** = 2 Things-Cloud change records when online (cloud sync unmeasurable on the airgapped clone; SYNC2 model). Comfortably supports the ratified configurable `bounce-max-items` default of **30**. |
| **DAYORD-o** | reproduce DAYORD-b for the recurring o-suite (O17) | **CONFIRMED date-preserving.** Project-specifier reorder of same-day scheduled children (`DO3,DO1,DO2`) re-ranked `todayIndex` to the requested order (`DO3<DO1<DO2`), left `startDate` UNCHANGED (integer `132805888` = 07-10 on all three, before AND after) and `index` at 0. Encoded as o-suite **O17** (`order.container-same-day`) with `fieldUnchanged` on `startDate/start/status/project`. |

## The bounce re-entry law (the unifying finding)

The `when=` bounce (`someday↔anytime` round-trip) re-inserts the touched item, but the DIRECTION depends on its containment context:

| Item context | Re-entry | Compile protocol |
|---|---|---|
| Loose anytime (ANYBNC, prior) | **FRONT** — `index` below the running GLOBAL min | reverse-order bounce |
| Area someday member (SOMEBNC-area) | **FRONT** — `index` below the someday GROUP min | reverse-order bounce |
| Project someday child (SOMEBNC-project) | **BACK** — appended to bucket end (siblings renumbered down) | forward-order bounce |
| Headed anytime child (BOUNCE2-h) | **BACK** — appended to heading-bucket end (siblings renumbered down) | forward-order bounce |

The split is **loose/area-direct = FRONT-insert; strict-container child (project child / heading child) = BACK-insert.** Both directions are deterministic and state-preserving, so BOTH give an exact-order protocol — the planner just picks reverse-order legs for the front-insert contexts and forward-order legs for the back-insert contexts. This is the same two-directional shape as the shipped Someday scope (P8b to-dos ascend / P9e projects descend), now extended to headings and within-container someday/anytime buckets.

## Design rule-5 (placement honesty) — changes from BOUNCE2

Feeds [design/heading-demotion-and-move.md](../design/heading-demotion-and-move.md) §4 rule 5. Relative to the REORDGAPS-era classification:

- **Heading buckets — in-heading ORDER moves from "best-effort-noted" to DETERMINISTIC (guaranteed-capable).** BOUNCE2-h resolved the HEADORD-c open anomaly: the bounce back-inserts headed children deterministically, so a FORWARD-order bounce places them in exact requested order (membership + first were already guaranteed via HEADORD-c). The only remaining in-heading refusal is `--before <sibling>`/`--after` *relative to an unmoved sibling* — still unspeakable (HEADORD-b: no heading-as-container specifier), but a full-block reorder of the heading's members is now a promisable protocol. Wiring it is Phase A.1 build scope.
- **Within-AREA someday order moves from REFUSED (destructive) to DETERMINISTIC via the bounce.** SOMEBNC-area gives a front-insert protocol that preserves `start=2` + the area FK, sidestepping the §9f de-somedaying area reorder command entirely. The area-someday capability-matrix row flips from "no clean surface" to "clean via the bounce (2 legs/item)."
- **Within-PROJECT someday order gains a SECOND path** (SOMEBNC-project bounce), alongside the already-guaranteed SOMEORD-b native project reorder. No classification change (already guaranteed) — banked as corroboration + an alternative when the native experimental command is unavailable.

None of these are wired into the shared reorder op yet — they are the Phase A.1 build (see up-next §0 A.1). Shipped honest-noted meanwhile per rule 5.

## App oddities filed (BOUNCE2)

- **§9h** — the `when=` bounce re-inserts a strict-container child (project child / heading child) at its bucket END by RENUMBERING the non-bounced siblings to lower `index` values (the bounced row keeps its own `index`), whereas the same bounce FRONT-inserts a loose/area-direct item below the group min. A benign but report-worthy cross-container inconsistency in how the ordering renumber is applied (BOUNCE2-h / SOMEBNC). Not destructive — every leg preserved `start`, the container FK, `reminderTime`, and `deadline`.

## Reproduce

```sh
TART_HOME=/Volumes/Workspace/tart \
  bash lab/scripts/research-bounce2.sh setup      # clone+boot+airgap+clock-pin+seed
  bash lab/scripts/research-bounce2.sh headless    # BOUNCE2-h · SOMEBNC · BOUNCE2-t · DAYORD-o
  bash lab/scripts/research-bounce2.sh confirm      # forward-order protocol positive-green (headed + project-someday)
  bash lab/scripts/research-bounce2.sh teardown
# DAYORD-o formal cert: npm run lab:run -- --suite lab/suites/o-suite.json  (O17 green)
```

No Accessibility, no VNC — all four probes are headless URL/AppleScript. The `confirm` subcommand runs the DERIVED forward-order protocol on fresh groups (the `headless` back-insert arms ran reverse order to MAP the law, so they show reversed output by design; `confirm` proves the forward protocol lands the target). Evidence (gitignored, synthetic): `lab/artifacts/bounce2-lab/report.txt`.
