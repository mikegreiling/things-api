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

---

# BOUNCEJSON — can ONE `things:///json` array collapse an N-item bounce to 1–2 dispatches?

Third offline Tart clone (`bjhx-lab`, run 2026-07-27, Things 3.22.11, pinned clock 2026-07-05; ordering is local — no cloud account). Script: [`lab/scripts/research-bouncejson-headxproj.sh`](../../lab/scripts/research-bouncejson-headxproj.sh) (subcommands `setup`/`bouncejson`/`headxproj`/`teardown`). All BOUNCEJSON arms are HEADLESS (URL `things:///json` + read-only SQLite) — no Accessibility, no VNC. The Phase A.1 bounce protocols cost **2 verified URL dispatches PER item** (away + back), so an N-item reorder is 2N dispatches; this campaign asks whether the app's `json` update-array surface collapses that to 2 (or 1) dispatches while preserving the BOUNCE2 front/back-insert order laws.

**Status: RAN + BANKED.** Headline: **YES for the BACK-insert classes — the whole bounce collapses to ONE `json` array** (interleaving both legs per item, applied in exact array order); **NO for the area-someday FRONT-insert class** — the `json` `when` update is INDEX-INERT on area-direct members (start toggles, `index` frozen), so it does not reproduce the front-insert and must stay on the sequential URL bounce.

## Verdict table (observed)

| Arm | Question | Verdict |
|---|---|---|
| **BJ-0** | does `json` `operation:"update"` accept a `when` change on an EXISTING item (auth-token op)? | **YES, both directions.** `[{type:to-do,operation:update,id,attributes:{when:someday}}]` set `start 1→2`; `when:anytime` set it back `2→1` (and front-inserted the loose item, `index -2522 → -22609`). The precondition holds — `json` can carry the bounce legs. |
| **BJ-a headed, 2-DISPATCH** | array-order vs the BOUNCE2-h BACK-insert law | **EXACT.** away-array = all-`someday`; back-array = `anytime` in a SCRAMBLED target order `BJH3,BJH1,BJH4,BJH2` → visible order became **`BJH3<BJH1<BJH4<BJH2`** (= array order), heading FK 4/4 intact. Array order controls the resulting `index` order, reproducing the forward-order back-insert. |
| **BJ-a headed, 1-DISPATCH** | can ONE array carry BOTH legs per item, in sequence? | **EXACT — the full collapse.** ONE array interleaving `[someday,anytime]` per item in scrambled target order `BJK2,BJK4,BJK1,BJK3` → visible **`BJK2<BJK4<BJK1<BJK3`**, headed 4/4, `start=1` 4/4. **A whole N-item back-insert bounce = ONE `json` dispatch (2N ops), applied in strict array order.** |
| **BJ-a area-someday, 2-DISPATCH** | array-order vs the SOMEBNC-area FRONT-insert law | **INERT — DEAD END.** away-array (`anytime`) + back-array (`someday`), reverse order, left `index` UNCHANGED on all four (`BJA4<BJA3<BJA2<BJA1` before AND after; indices byte-identical); only `start` toggled `2→1→2`. Clean (someday+area preserved) but NO reorder. |
| **BJ-a area-someday, 1-DISPATCH** | interleaved single array | **INERT — DEAD END** (same: order unchanged, `index` frozen, `start`/area preserved). |
| **BJ-b** | terminal state only, or distinct DB transactions? | **DISTINCT transactions, in array order.** A single 5-op array wrote **5 DISTINCT `userModificationDate`** values ~2.7 ms apart, MONOTONIC in array order (`BJM1<…<BJM5` by timestamp). NOT one atomic commit — each element lands as its own write, independently verifiable at `userModificationDate` granularity. |
| **BJ-c** | mid-array poison (bad uuid) — short-circuit / skip / abort? | **FULL ABORT (validate-first).** `[sd BJG1, sd BJG2, sd <BAD-uuid>, sd BJG3, sd BJG4]` applied to NONE — `BJG1=BJG2=BJG3=BJG4=start 1` unchanged, INCLUDING the two elements BEFORE the poison. The app validates every element first; any unresolvable id rejects the ENTIRE array (+ the `json` error modal / focus steal). No partial progress to reconcile, but a single bad ref kills the whole batch. |
| **BJ-d** | timing: 1×30-op array vs 30 sequential dispatches | **~7× faster.** ARRAY (1 dispatch, 30 ops) = **242 ms** (8 ms/op); SEQ (30 single-op dispatches) = **1763 ms** (58 ms/op, ≈ the BOUNCE2-t URL ~55 ms/leg). A 30-item bounce (60 legs): URL ≈ 3.4 s; `json` 1-dispatch interleaved 60-op array ≈ **~0.5 s**. |

## The unifying mechanism (why back-insert collapses but front-insert doesn't)

The `json` `when` update reindexes selectively:

| leg | on a LOOSE or CONTAINER (heading-child) item | on an AREA-DIRECT member |
|---|---|---|
| `when=anytime` | **REINDEXES** (BJ-0 loose → global min; headed re-entry → bucket end / back-insert) | index FROZEN |
| `when=someday` | index FROZEN (BJ-a headed away-leg left indices untouched) | index FROZEN |

So the `json`-array collapse reproduces a bounce **iff the PLACEMENT leg is `anytime` into a loose/container bucket** — i.e. the heading-children back-insert (`someday→anytime`), and by the same mechanism a project's unheaded-anytime children and area-less loose-anytime items (BJ-0 confirmed loose-anytime front-inserts). It is a DEAD END whenever the placement leg is `someday` (area-someday, project-someday, the shipped someday scope) OR the item is an area-direct member — those stay on the 2N-dispatch sequential URL bounce.

## Compile-able law (feeds `src/write/reorder.ts` — the bounce compiler)

- **BACK-insert reorder classes (heading children; project unheaded-anytime children):** compile the whole reorder to **ONE `things:///json` array** carrying `[{when:someday},{when:anytime}]` per item in target order (2N ops, 1 dispatch). Result order = array order exactly; heading/project FK preserved; ~7× faster than the URL loop. **Pre-validate every id** — a single unresolvable ref full-aborts the batch (BJ-c), so the compiler must resolve all refs before dispatch (it already does). Elements are independently verifiable via `userModificationDate` (BJ-b) if per-leg confirmation is wanted, but the terminal-order read suffices.
- **FRONT-insert / someday-placement classes (area-someday, project-someday, someday scope):** `json` is index-inert — **do NOT collapse**; keep the sequential URL bounce (the reindex only fires on the URL path). Documented dead end, not a regression.
- **Poison honesty:** the `json` array is all-or-nothing on validation failure (validate-first full abort), so partial-progress reconciliation is unnecessary for the collapsed path — but the whole batch fails on one bad ref (+ error modal), so ref resolution must precede dispatch.

## Reproduce

```sh
TART_HOME=/Volumes/Workspace/tart \
  bash lab/scripts/research-bouncejson-headxproj.sh setup       # clone+boot+airgap+clock-pin+seed
  bash lab/scripts/research-bouncejson-headxproj.sh bouncejson    # BJ-0 · BJ-a (both classes/shapes) · BJ-b · BJ-c · BJ-d
  bash lab/scripts/research-bouncejson-headxproj.sh teardown
```

No Accessibility, no VNC — all BOUNCEJSON arms are headless `things:///json`. The BJ-a headed arms use SCRAMBLED targets (seed order already equals a naive forward target) so a passing result proves array order CONTROLS placement, not a no-op. Evidence (gitignored, synthetic): `lab/artifacts/bjhx-lab/report.txt`.

---

# HEADXPROJ — heading move to a DIFFERENT project (the ellipsis-menu `Move…` recipe)

Same `bjhx-lab` clone (run 2026-07-27, Accessibility granted via the AXVM1 rung-b VNC toggle after materializing the TCC row with a denied AX op). A first-class GUI operation (a heading relocates WITH its children to another project) with NO automation spelling on any headless vector (URL ⛔, AppleScript `move → project id` 301 / `set-detail` Parent silent no-op scf P2, Shortcuts ⛔). Originally queued as an AX-DRAG candidate; **redesigned 2026-07-27 (maintainer live-GUI flag) to the heading row's `…` ellipsis → `Move…` MENU path** — drive that first, drag is the fallback of last resort. LOW stakes.

**Status: RAN + BANKED. VERDICT: FEASIBLE-with-recipe** via the ellipsis `Move…` menu — deterministic, keyboard-driveable, NO drag, NO §9 AX-mirror fragility. The drag fallback was not needed.

## The recipe (each step lab-confirmed)

1. **Show the source project** (`things:///show?id=<sourceProject>`), `activate` Things, set `AXEnhancedUserInterface=false`.
2. **Locate the heading row.** Content rows are frame-sorted and map to DB order (project-header = ordinal 0, the heading = ordinal 1, children 2…). **The heading is directly AX-identifiable regardless of ordinal**: its `…` button is an `AXUnknown` whose `AXDescription` is **`"More. <headingTitle>"`** (it CARRIES the heading title — unlike to-do content rows, which expose only cell-template identifiers like "Task NewForToday Template"), and the heading's own title node is an `AXUnknown desc="‎<title>"` (a U+200E LTR-mark prefix, strip it). So row-identity is NOT the reordgaps `SRC_NOT_FOUND` blocker for a heading.
3. **HID-click the `…` button** at its AX-resolved frame center. `AXPress` on the button is **INERT** (parallels §8j — the project card's `…` — but here the node DOES exist and carries the title), so use the UIC3 mouse-synthesis hybrid: `CGEvent` click at the frame center (AX points == CGEvent points; the golden is 2× Retina, so VNC pixels = AX points × 2).
4. **Popover opens: `Archive` / `Move…` / `Convert to Project…` / `Delete`.** HID-click `Move…`.
5. **A searchable project picker opens** (a `Move` filter field + the full project list, current project check-marked). **Type the destination project name → the list filters to the match → press Return to select** (it also offers `New Project "<name>"` to create the destination).
6. Done — the heading + its children relocate to the destination.

## DB delta (the verify oracle for a future `project.move-heading-to-project` op)

Moving heading `HXH` (children `HXC1`/`HXC2`) from `HX-PA` → `HX-PB` (empty destination):

| row | before | after |
|---|---|---|
| `HXH` (heading, type=2) | `project=HX-PA`, heading NULL, `index=0`, area NULL | **`project=HX-PB`**; heading NULL, **`index=0` (preserved, no renumber)**, area NULL — only the project FK changed |
| `HXC1` / `HXC2` (children, type=0) | `heading=HXH`, `project=NULL`, idx −593/0 | **UNCHANGED** — `heading=HXH`, `project=NULL`, idx −593/0 — children follow the heading via their intact heading FK; their own rows are not rewritten |

So a heading cross-project move is a **single-row project-FK rewrite on the heading** (its children re-home implicitly through the heading FK). Destination index = the heading's prior `index` preserved (dest was empty — collision behaviour on a populated destination is untested; a future op should capture the destination order and place explicitly). No `area`/`start`/`deadline`/`index` churn on any child.

## Observations (recorded, not re-certified)

- The same popover carries **`Convert to Project…`** — a SECOND spelling for heading→project promotion (currently the ui-vector Items-menu path certified in HEADCERT), and **`Archive`** / **`Delete`**. If a build ever wants a menu-driven promote/archive, this popover is the surface. Not re-certified here.
- The `Move…` picker doubles as a **create-destination**: `New Project "<typed name>"` appears below the filtered matches.
- Heading `…`-button AX-node existence (with title in `AXDescription`) is the load-bearing enabler — it sidesteps the reordgaps content-row title-invisibility that blocked the drag oracles. Filed as a novel path.

## Reproduce

```sh
TART_HOME=/Volumes/Workspace/tart VNCDO=/path/to/vncvenv/bin/vncdo \
  bash lab/scripts/research-bouncejson-headxproj.sh setup       # + AX grant (materialize TCC row via denied AX op, then VNC-toggle)
  bash lab/scripts/research-bouncejson-headxproj.sh headxproj     # headless reconfirm + ellipsis Move… recipe (AX-granted)
  bash lab/scripts/research-bouncejson-headxproj.sh teardown
```

The AX grant needs `$VNCDO` (throwaway `vncdotool` venv — the host has no `vncdo`) to toggle the `sshd-keygen-wrapper` Accessibility row; the TCC row must first be materialized by provoking a denied AX op (an `osascript` System Events UI-element read → −1719) BEFORE the toggle, else the pane has no row to flip. Evidence (gitignored, synthetic): `lab/artifacts/bjhx-lab/` (`report.txt`, `screens/*.png`).
