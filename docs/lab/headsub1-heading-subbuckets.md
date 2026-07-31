# HEADSUB1 — can the buckets UNDER a heading be ordered, and is the child-evening bounce insertion law provable?

Closes the remaining unprobed ordering cells: the per-class order of a heading's sub-buckets (anytime / someday / scheduled / evening) and the insertion law of the `when=` **evening bounce** when the movee is a CONTAINER child rather than a loose item.

One offline Tart clone (`headsub1-lab`, run 2026-07-31, Things 3.22.11, pinned clock 2026-07-05 12:00; ordering is local — no cloud account). Evening day = **2026-07-05** (the pinned today), scheduled test day = **2026-07-10**. Script: [`lab/scripts/research-headsub1.sh`](../../lab/scripts/research-headsub1.sh) (subcommands `setup` / `armA` / `armB` / `armC` / `armC2` / `armD` / `teardown`). **All arms HEADLESS** (URL scheme + `things:///json` + AppleScript private reorder) — no Accessibility, no VNC. No clock advance anywhere (evening items live on today; scheduled items on 07-10 — both reachable from the pinned date).

**Status: RAN + BANKED.** Headlines:

1. **Arm A = O06 is AXIS-AGNOSTIC.** The native container-day reorder (project specifier) re-ranks a headed child's `todayIndex` date-preservingly BUT **RIPS the heading FK to NULL** and reparents the child to the project root — the same O06 destruction HEADORD-a found on the `index` axis, now confirmed on the `todayIndex` (day) axis too. Headed scheduled day-order is **NOT directly achievable** via the native reorder. New oddity **§9k**.
2. **Arm B = a clean per-class move-to-heading law.** Moving a loose movee UNDER a heading (`update?list-id=<project>&heading=<title>`) **BACK-INSERTS deterministically on `index`** for the INDEX-ordered classes (anytime, someday, evening-under-heading), state fully preserved — so **re-heading a block in FORWARD target order IS a sort protocol** for those classes. For the SCHEDULED class the move is a **`todayIndex` NO-OP** (it only sets the heading FK; order is inherited, not set by move order).
3. **Arm C = the round-trip closes the scheduled case.** Unhead (clean, index/todayIndex/date preserved) → sort via the native unheaded scope (SOMEORD-b for someday, DAYORD-b for same-day) → re-head (preserves the sorted key). Both round-trips land the exact target. The SHORT direct-rehead sorts the index classes but NOT the scheduled class (rehead is a todayIndex no-op).
4. **Arm D = the evening bounce EXTENDS to container children.** A project child flagged this-evening, bounced `when=today → when=evening`, **FRONT-inserts deterministically** (below the evening group's `todayIndex` min) with the project FK + evening flag (`startBucket=1`) + `startDate=today` all preserved — the SAME direction as the loose evening control. The shipped `evening` BounceSpec applies to container-child evening items unchanged.

**Evening IS representable under a heading** (a novel structural finding, Arm B): moving an evening item under a heading preserves `startBucket=1` and the today `startDate`.

## Verdict table (observed)

| Arm | Question | Verdict |
|---|---|---|
| **A** — container-day reorder vs HEADED same-day children | does `reorder to dos in project id <p>` over a mix of headed + unheaded same-day children (a) re-rank headed rows' `todayIndex` date-preservingly, (b) SKIP them, or (c) RIP the heading FK (O06)? | **(c) O06 RIP — axis-agnostic.** The reorder re-ranked `todayIndex` EXACTLY to the mixed scrambled wire order (`A-h3<A-u2<A-h1<A-u1<A-h2`), date-preservingly (`startDate` 07-10 kept, `start=2` kept) — BUT on the three headed rows it set **`heading` → NULL** (hex `34726777…`=A-H before → NULL after) and **`project` → the project root** (NULL before → hex `46554E72…`=A-P after), reparenting them into the unheaded block. Identical destruction to HEADORD-a's `index`-axis rip, now proven on the `todayIndex` path. **Headed scheduled day-order is NOT directly achievable** via the native reorder; the `H-REORDER-SCOPE` guard's rejection of headed children in project scope is correct for the scheduled case too. → **oddity §9k.** |
| **B**-anytime | move a loose ANYTIME movee under a heading — landing + state? | **APPEND / back-insert on `index`, deterministic.** Two movees under a heading with two anytime anchors landed `B-anc-a1(-460) < B-anc-a2(0) < MV-any1(419) < MV-any2(850)` — each appends past the running max in move order. State: `heading`=B-H, `project`=NULL, `start=1` preserved. |
| **B**-someday | move a loose SOMEDAY movee under a heading | **APPEND / back-insert on `index`, deterministic; `start=2` PRESERVED (not de-somedayed).** Final `B-anc-s1(-530) < B-anc-s2(-463) < MV-some1(-420) < MV-some2(115)`. The non-bounced siblings are renumbered DOWN and the movee keeps its own index to sort last (the §9h back-insert renumber, here on a move rather than a bounce). |
| **B**-scheduled | move a loose SCHEDULED (same-day) movee under a heading | **`todayIndex` NO-OP — only the heading FK is set.** Each movee kept its pre-existing `todayIndex` (`MV-sched1`=1351, `sched2`=804, `sched3`=365 — all unchanged), `index` stayed 0. So the heading's scheduled sub-bucket orders by each item's PRE-EXISTING `todayIndex`, NOT by move order — **re-heading in target order does NOT sort scheduled children.** `startDate` (07-10) preserved; a reminder (`603979776`) + deadline (`132805888`) on `MV-sched3` survived intact. |
| **B**-evening | is EVENING representable under a heading, and how does the move land? | **YES — the evening flag SURVIVES (novel).** After moving under the heading, `startBucket=1` and `startDate`=today (07-05) were PRESERVED, `heading`=B-H, `project`=NULL. The move APPENDS on `index` (`MV-eve1`=1418, `MV-eve2`=1924 — back-insert) while `todayIndex` is retained (eve1=948, eve2=427). Both axes are present in the DB; which one a heading DISPLAYS evening children on is a GUI question not resolvable headlessly. |
| **C**-unhead | move a headed child OUT to the unheaded block (`--no-heading` = `update?list-id=<project>`): state preserved? index/todayIndex renumbered or kept? | **CLEAN, keys KEPT.** `heading` → NULL, `project` → the parent project, `index` UNCHANGED (someday `C-s1` kept idx=-348), `todayIndex` + `startDate` + `start` unchanged. No renumber of the movee or its siblings. |
| **C**-full someday | unhead N → sort via SOMEORD-b → re-head in target order | **LANDS TARGET — a wireable within-heading someday sort protocol.** Unhead all three (indices kept), `reorder to dos in project id <p>` re-ranked `index` to the scrambled target (`C-s3<C-s1<C-s2`, `start=2` preserved), re-head each → final in-heading order == target, `heading`=C-H, `start=2`. |
| **C**-short scheduled | unhead N → re-head DIRECTLY in target order (skip the middle sort) | **FAILS for scheduled.** Re-heading in target order left the `todayIndex` order == the ORIGINAL (`C-d1<C-d2<C-d3`), NOT the requested `C-d2,C-d3,C-d1` — the rehead is a `todayIndex` no-op (Arm B-scheduled), so move order cannot sort the day axis. (The short version DOES work for the index classes — Arm B.) |
| **C2**-full scheduled | unhead N → sort via DAYORD-b → re-head | **LANDS TARGET — a wireable within-heading scheduled day-order protocol.** Unhead all three (`todayIndex` + 07-10 date kept), `reorder to dos in project id <p>` re-ranked `todayIndex` to the scrambled target (`C-d2<C-d3<C-d1`), date-preserving, re-head each (todayIndex preserved) → final `todayIndex` order == target, `heading`=C-H. |
| **D**-child evening bounce | a project child flagged this-evening, bounced `when=today → when=evening`: deterministic re-entry position? container + evening flag preserved? | **DETERMINISTIC FRONT-INSERT, state-preserving — the evening scope EXTENDS to container children.** The bounced child re-enters BELOW the evening group's `todayIndex` min; `startBucket=1`, `startDate`=today, and the `project` FK are all preserved (FK hex byte-identical pre/post). A FORWARD-order full-block bounce (`D-e1,D-e2,D-e3`) produced the REVERSE final order (`D-e3<D-e2<D-e1`) — a front-insert, so a REVERSE-order bounce lands the target. **Same direction as the loose evening control** (`D-le3<D-le2<D-le1`) — a uniform law. Matches `BounceSpec.evening` (`away=today, back=evening, direction=front, rankKey=todayIndex`). |

## Per-arm detail

### Arm A — the O06 rip is axis-agnostic

Project `A-P` with heading `A-H`, two unheaded direct children (`A-u1/u2`) and three headed children (`A-h1/h2/h3`), ALL scheduled 2026-07-10. Seed confirmed a headed child CAN carry a future schedule: `start=2`, `startDate`=07-10, `todayIndex` set, `heading`=A-H, `project`=NULL. A mixed scrambled wire `A-h3,A-u2,A-h1,A-u1,A-h2` re-ranked `todayIndex` exactly to that order and preserved the date — but every headed row's `heading` FK went to NULL and its `project` FK to the project root (`A-P`), exactly HEADORD-a / O06. So the destruction is not specific to the `index`-axis (anytime) reorder — the `todayIndex` (day-axis) reorder rips too. DAYORD-b's "clean, date-preserving" property holds ONLY for UNHEADED children; putting a headed child in the wire triggers the rip. This is why the only path to ordering headed scheduled children is the Arm C2 round-trip, and why the reorder guard must keep rejecting headed children in project scope for the scheduled case.

### Arm B — the move-to-heading append law, per bucket class

The shipped move-to-heading leg (`src/write/move.ts` → `things:///update?id=<u>&list-id=<projectUuid>&heading=<headingTitle>&auth-token=<t>`; the `heading` param takes the heading TITLE) was driven directly. A heading `B-H` was pre-seeded with two anchors per class so a movee's landing position is measurable.

- **INDEX-ordered classes (anytime, someday, evening-under-heading): deterministic BACK-INSERT on `index`.** The moved item appends past the heading sub-bucket's running max; for someday the non-moved siblings are renumbered down and the movee keeps its own index (the §9h back-insert renumber). Because it is a deterministic append, **moving a block of movees under the heading in FORWARD target order lays them out in exact target order** — re-head-in-order IS a sort protocol for these classes. State preservation: anytime `start=1`; someday `start=2` (NOT de-somedayed); evening `startBucket=1` + today `startDate` (the flag survives — evening is representable under a heading).
- **`todayIndex`-ordered class (scheduled same-day): the move is a `todayIndex` NO-OP.** It sets the heading FK and leaves `todayIndex` (and `index=0`) untouched, so the heading's scheduled sub-bucket orders by each child's PRE-EXISTING `todayIndex`. Move order therefore does NOT control scheduled placement — re-head-in-order is NOT a sort protocol for the day axis (confirmed by Arm C-short). `startDate`, reminder, and deadline all ride through untouched.

### Arm C — unhead effects + the round-trip sort protocol

Unhead is the shipped `--no-heading` leg (`update?id=<u>&list-id=<projectUuid>` with no `heading` param): it drops the heading FK, re-asserts the project, and PRESERVES `index`, `todayIndex`, `startDate`, and `start` (no renumber of the movee or its siblings).

The round-trip within-heading sort protocol, per class:

- **Someday (and by Arm B, anytime): full round-trip lands target.** Unhead the block → `reorder to dos in project id <p> with ids <target>` (SOMEORD-b re-ranks `index`, `start=2` preserved) → re-head each. Final in-heading order == target. (The SHORT direct-rehead-in-order also works for these index classes — Arm B.)
- **Scheduled same-day: full round-trip lands target; short does NOT.** The SHORT direct-rehead-in-order fails (Arm C — the rehead is a `todayIndex` no-op, so the final day order is whatever it was at unhead time). The FULL round-trip closes it (Arm C2): unhead (todayIndex + date kept) → `reorder to dos in project id <p>` (DAYORD-b re-ranks `todayIndex`, date-preserving) → re-head (todayIndex preserved). Final `todayIndex` order == target.

So the wireable within-heading sort protocols are:

| Heading sub-bucket | Wireable protocol | Leg sequence |
|---|---|---|
| **anytime** | re-head-in-order (Arm B back-insert) OR unhead→SOMEORD-b→rehead | move each under the heading in FORWARD target order via `update?list-id=<p>&heading=<title>` — OR unhead all (`update?list-id=<p>`), `reorder to dos in project id <p> with ids <target>`, re-head all |
| **someday** | same as anytime (`start=2` preserved throughout) | as above |
| **scheduled same-day** | unhead→DAYORD-b→rehead ONLY (short fails) | unhead all (`update?list-id=<p>`; date+todayIndex kept), `reorder to dos in project id <p> with ids <target>` (todayIndex re-rank, date-preserving), re-head all (todayIndex preserved) |
| **evening** (container child) | the evening bounce (Arm D) — reverse-order front-insert | per child in REVERSE target order: `update?when=today` then `update?when=evening` |

Note: within-heading anytime order is ALREADY guaranteed and wired via the BOUNCE2-h forward-order bounce (reorder scope `heading`). HEADSUB1's move-to-heading back-insert and unhead→sort→rehead round-trip are a SECOND and THIRD path to the same result (corroboration + alternatives when the bounce surface is unavailable).

### Arm D — the child-evening bounce insertion law

`BounceSpec.evening` (`src/write/reorder.ts`) is `away=today, back=evening, direction=front, rankKey=todayIndex, legOp=todo.update` — the legs of the shipped `evening` reorder scope, until now proven only for LOOSE (today-view) evening items. Arm D ran those exact legs manually on a PROJECT child flagged this-evening (`update?when=today` then `update?when=evening`) and on a loose evening control.

Both classes FRONT-insert: the bounced item re-enters below the evening group's `todayIndex` min, and a forward-order full-block bounce yields the reverse final order (so the wireable protocol bounces in REVERSE target order). For the container child, the `project` FK (hex byte-identical pre/post), `startBucket=1`, and `startDate`=today were all preserved. The direction and state-law are IDENTICAL to the loose control — the evening scope is extensible to container children with no change to the BounceSpec.

**R07 caveat:** a bare `when=today`/`when=evening` CLEARS an existing reminder ([oddities](../things-app-oddities.md) §2d/R07). The Arm D items carried no reminder, so nothing was lost — but a container-child evening item that DOES carry a reminder would lose it across the bounce, exactly as a loose evening item would. Any wiring of a container-child evening reorder inherits the shipped evening scope's reminder-loss disclosure.

## Candidate capability-matrix promotions (for the orchestrator to wire — NOT changed here)

The Ordering §'s APP-DEFAULT list ("a headed scheduled/someday/evening sub-bucket, a project/area child's evening sub-bucket") loses its "no protocol" justification for three of its members. Feasibility cells intentionally left APP-DEFAULT in this change; the candidate flips are recorded here for the wiring change:

- **Within-heading SOMEDAY order → GUARANTEED** via either (a) the move-to-heading back-insert (re-head loose movees in forward target order), or (b) unhead→SOMEORD-b→rehead round-trip. `start=2` preserved throughout. (Arm B-someday, Arm C-full.)
- **Within-heading SCHEDULED same-day order → GUARANTEED** via unhead→DAYORD-b→rehead round-trip (date-preserving; the direct rehead does NOT sort — Arm C-short). The native container-day reorder alone RIPS the heading FK (Arm A / §9k), so the round-trip is mandatory. (Arm C2.)
- **Container-child EVENING order → GUARANTEED** via the evening bounce (reverse-order front-insert; container FK + `startBucket=1` + today `startDate` preserved) — the shipped `evening` BounceSpec extended to a container child, no code change to the spec. Inherits the R07 reminder-loss disclosure. (Arm D.)
- **Within-heading ANYTIME order** — already GUARANTEED + WIRED (BOUNCE2-h forward bounce, scope `heading`). HEADSUB1 banks two alternative paths (move-to-heading back-insert; unhead→SOMEORD-b→rehead). No classification change.
- **Headed EVENING sub-bucket** — stays app-default pending a GUI oracle: evening IS representable under a heading (the move preserves `startBucket=1`), but the display ordering axis is ambiguous headlessly (the move rewrites `index` while `todayIndex` is retained). Representability is the new datum; the order axis needs VNC.

## App oddities filed

- **§9k** — the private container-day reorder (project specifier, `todayIndex` axis) RIPS a headed child's heading FK to NULL and reparents it to the project root, exactly like the `index`-axis O06/HEADORD-a rip. O06 is axis-agnostic — DAYORD-b's date-preserving property holds only for UNHEADED children. (Arm A.)

The Arm B someday move-to-heading renumber (siblings renumbered DOWN, movee keeps its index to sort last) is the already-filed §9h back-insert renumber, now observed on a `move` leg rather than a `when=` bounce — recorded here, not re-filed.

## Reproduce

```sh
TART_HOME=/Volumes/Workspace/tart \
  bash lab/scripts/research-headsub1.sh setup      # clone+boot+airgap+clock-pin+seed all four arms
  bash lab/scripts/research-headsub1.sh armA        # O06 axis-agnostic rip
  bash lab/scripts/research-headsub1.sh armB        # move-to-heading append per class
  bash lab/scripts/research-headsub1.sh armC        # unhead + full someday round-trip + short scheduled (fails)
  bash lab/scripts/research-headsub1.sh armC2       # scheduled full round-trip (DAYORD-b middle sort)
  bash lab/scripts/research-headsub1.sh armD        # child-evening bounce insertion law
  bash lab/scripts/research-headsub1.sh teardown
```

No Accessibility, no VNC — all arms headless URL / `things:///json` / AppleScript. All reorder wire lists use SCRAMBLED targets so a passing result proves array order CONTROLS placement, not a no-op. Evidence (gitignored, synthetic): `lab/artifacts/headsub1-lab/report.txt`.

---

# HEADSUB2 — confirming two inference gaps #327 relied on (and correcting one)

HEADSUB1 shipped three matrix promotions in #327. Two rested on INFERENCES it never directly probed. HEADSUB2 tests both. One inference was WRONG and the shipped scope was broken; it is corrected in the same change that files this section.

One offline Tart clone (`headsub2-lab`, run 2026-07-31, Things 3.22.11, pinned clock 2026-07-05 12:00; ordering is local — no cloud account). Evening day = **2026-07-05**. Script: [`lab/scripts/research-headsub2.sh`](../../lab/scripts/research-headsub2.sh) (subcommands `setup` / `q1` / `q1fix` / `q2` / `teardown`). All headless (URL scheme + `things:///json` + AppleScript). Evidence (gitignored, synthetic): `lab/artifacts/headsub2-lab/report.txt`.

**Status: RAN + BANKED.** Headlines:

1. **Q1 = (b) — the shipped `heading-someday` compile was BROKEN.** Re-heading a row that is ALREADY under the target heading (`update?id=<u>&list-id=<project>&heading=<same-title>`) is a **same-heading NO-OP on `index`** — the block never reorders. HEADSUB1 proved the back-insert only for LOOSE→heading (Arm B) and unhead→re-head (Arm C), and OVER-GENERALIZED it to "re-head the already-headed block in forward order"; #327 shipped that inert compile. New oddity **[§9l](../things-app-oddities.md#9l)**. **Fixed in this change:** `runHeadingSomeday` now does the **unhead → re-head round-trip** (q1fix, proven below).
2. **Q1 fix = the round-trip lands target.** Unhead the whole block (clean — `heading`→NULL, `index`/`start=2` preserved, Arm C), THEN re-head each in forward target order → each now-loose row genuinely BACK-INSERTS at the someday-bucket end (Arm B), so the block lands the exact scrambled target. `start=2` preserved throughout.
3. **Q2 = CONFIRMED — the area-direct evening bounce matches the project-child law.** An area-direct this-evening to-do bounced `when=today → when=evening` FRONT-inserts deterministically (below the evening group's `todayIndex` min), with the **area FK byte-identical**, `startBucket=1`, and today `startDate` all preserved — the SAME direction and state-law as HEADSUB1 Arm D's project child and the loose evening control. #327's routing of area-direct evening children to the shipped `evening` scope is correct by more than inference now.

## Verdict table (observed)

| Q | Question | Verdict |
|---|---|---|
| **Q1**-someday | re-head 4 someday children ALREADY under one heading, in scrambled forward target order, via the shipped direct-re-head leg — does each leg back-insert (order = target) or is a same-heading re-head a no-op? | **(b) SAME-HEADING NO-OP.** Original `index` order `Q1-s1<Q1-s2<Q1-s3<Q1-s4` (idx −363/−136/−83/0) stayed **byte-identical through all four re-head legs** — the target `s3,s1,s4,s2` was never realized. `heading`=Q1S-H, `start=2` unchanged. The shipped `heading-someday` protocol (re-head-in-forward-order WITHOUT unheading) is therefore **inert** — it can never reorder an already-headed block. → oddity **§9l**; scope **fixed** this change. |
| **Q1**-anytime | same, for 4 ANYTIME already-headed children (the direct-re-head LAW, though anytime ships on the bounce) | **(b) SAME-HEADING NO-OP, identically.** `Q1-a1<Q1-a2<Q1-a3<Q1-a4` (idx −538/−264/−91/0) unchanged through all four legs; `heading`=Q1A-H, `start=1` kept. Confirms the no-op is a property of the same-heading move itself, not of the someday class. (Within-heading anytime order is unaffected — it ships on the `someday↔anytime` bounce BOUNCE2-h, not a same-heading re-head.) |
| **Q1**-fix | the FIX law: unhead the block (`update?list-id=<p>`), then re-head each in forward target order | **LANDS TARGET — the wireable already-headed someday sort.** Unhead all four (clean: `heading`→NULL, `project`→Q1F-P, `index` −583/−298/−169/0 preserved, `start=2` kept), then re-head in forward target order `f3,f1,f4,f2` → final `index` order **`Q1-f3(−978)<Q1-f1(−583)<Q1-f4(−459)<Q1-f2(−298)` == target**, all re-headed (`heading`=Q1F-H), `start=2` preserved. Each now-loose row back-inserts at the someday-bucket end (Arm B), so forward-order re-heads realize the target. |
| **Q2**-area evening | an area-DIRECT this-evening to-do bounced `when=today→when=evening`: same front-insert law as the project child (Arm D)? area FK + `startBucket=1` + `startDate` preserved? | **CONFIRMED — same front-insert, state-preserving.** Single-item bounce (`Q2-ae2`) re-entered BELOW the evening group's `todayIndex` min (front-insert: `ae2<ae3<ae1`), area FK **hex byte-identical** pre/post (`37436B34…`), `startBucket=1`, `startDate` 132805248 (07-05) all kept, `project`/`heading` NULL. A FORWARD-order full-block bounce (`ae1,ae2,ae3`) produced the REVERSE final order (`ae3<ae2<ae1`) — a front-insert — matching the loose evening control (`le3<le2<le1`) run alongside. Identical to HEADSUB1 Arm D's project child: the shipped `evening` BounceSpec (`away=today, back=evening, direction=front, rankKey=todayIndex`) applies to area-direct children unchanged. Inherits the R07 reminder-loss caveat. |

## The correction (Q1)

**What #327 shipped:** `runHeadingSomeday` re-headed a heading's someday children in forward target order via `todo.move` (`update?list-id=<project>&heading=<title>`) on rows *already under that heading*, expecting the Arm B back-insert. Q1 proves that call is a **same-heading no-op** — the block never moves. The scope silently did nothing (it would report `ok` while leaving the order untouched, because the leg mutations "succeed").

**Root cause:** HEADSUB1 measured the back-insert on two paths — a LOOSE movee arriving under a heading (Arm B) and an UNHEADED row re-headed (Arm C) — and generalized to "re-head-in-order sorts an already-headed block." It never tested a row already sitting under the target heading. The move-to-heading back-insert only fires when the heading FK actually CHANGES (§9l).

**The fix (this change):** `runHeadingSomeday` now runs the **unhead → re-head round-trip** (q1fix): unhead the whole block first (clean, `index`/`start=2` preserved), then re-head each in forward target order so each now-loose row genuinely back-inserts. Two `todo.move` legs per item (unhead + re-head) instead of one, a terminal order verify, and — like `heading-day` — a mid-protocol failure leaves items UNHEADED in the project root and fails loudly. Still no experimental/bounce gate (pure URL move legs). The `heading-someday` matrix cell stays **GUARANTEED**; only the mechanism changed.

## Reproduce

```sh
TART_HOME=/Volumes/Workspace/tart \
  bash lab/scripts/research-headsub2.sh setup      # clone+boot+airgap+clock-pin+seed both questions
  bash lab/scripts/research-headsub2.sh q1          # re-head already-headed (someday + anytime) => NO-OP (b)
  bash lab/scripts/research-headsub2.sh q1fix       # unhead -> re-head round-trip => lands target (the fix law)
  bash lab/scripts/research-headsub2.sh q2          # area-child evening bounce => front-insert, area FK preserved
  bash lab/scripts/research-headsub2.sh teardown
```

All reorder wire lists use SCRAMBLED targets so a passing result proves array order CONTROLS placement. Evidence (gitignored, synthetic): `lab/artifacts/headsub2-lab/report.txt`.
