# SIT6 — flag-safe index-axis MOVE protocols (the de-Today-free twins of the index bounces)

Sitting 6 characterises the **MOVE family** (`list-id` / `area-id` re-parenting legs) as the flag-safe counterpart to the `when=`-**bounce** family on the `index` axis. The shipped index-axis reorder protocols for heading children (`heading` BOUNCE2-h) and loose anytime rows (`anytime` ANYBNC) and top-level projects (`projects` P8e) are **when=-bounce-only**, and their `when=` legs OVERWRITE the Today/Evening flag — the **de-Today hazard**. Move legs are proven flag-safe everywhere probed (P9f, HEADSUB1/2, UPCORD1). Each arm pins ONE unknown insertion/preservation law that would make a move-based protocol wireable as the flag-carrying alternative. Four arms plus a priority hazard-confirm arm, all in ONE disposable clone:

- **PROJSTAR** (hazard confirm, FIRST) — does the shipped sidebar `projects` bounce (`when=someday`→`when=anytime`) de-star a Today-flagged area-less project? (Expected YES → a LIVE silent-de-star hazard.)
- **HEADMOVE** — heading anytime children: is the unhead (`list-id=P`) → re-head (`list-id=P&heading=H`) MOVE round-trip a flag-safe insertion protocol on the `index` axis, replacing the de-Today `heading` bounce?
- **LOOSEPARK** — loose area-less anytime rows: park into a scratch PROJECT, native reorder, UNPARK — the CENTRAL law is what unpark does to `index` (preserve the in-scratch order, or re-insert deterministically?) — plus the unpark-order SHORTCUT and the AREA-scratch variant.
- **PROJPARK** — area-less anytime PROJECTS: park into a scratch AREA (`area-id=`), native O14 project reorder, detach (`area-id=` empty) — the flag-safe alternative to the `projects` bounce.
- **AREADEL** (micro-arm, gates PROJPARK teardown) — when an area is deleted, what is the fate of a contained PROJECT and its child? (A25/A25B proved the area row is hard-deleted and contained TO-DOS are trashed; the project fate was unprobed.)

One offline Tart clone (`sit6-lab`, run 2026-07-31, Things **3.22.11**, macOS **15.7.7** Sequoia, DB schema **26**, pinned clock **2026-07-05 12:00**; ordering is local — no cloud account). Script: [`lab/scripts/research-sit6.sh`](../../lab/scripts/research-sit6.sh) (subcommands `setup` / `arm0` / `arm1` / `arm2` / `arm2d` / `arm2e` / `arm3` / `arm3b` / `teardown`). **ALL arms HEADLESS** (URL scheme + `things:///json` + AppleScript private reorder) — no Accessibility, no VNC. `encodePackedDate` discipline — ISO dates to the URL scheme, the app encodes; every value read back raw from SQLite. All reorder/re-entry targets are SCRAMBLED so a passing final order proves the sequence CONTROLS placement. Synthetic seeds only (`S6-*` prefix). "Star" = a Today flag = `start=1` + `startDate=today` (132805248) + a `todayIndex`; the flag-carrier rows additionally carry a `09:00` reminder (`reminderTime=603979776`) and a `2026-07-10` deadline (`132805888`) to bank reminder/deadline preservation on the index axis too.

**Status: RAN + BANKED.** Headlines:

1. **PROJSTAR = the shipped `projects` bounce DE-STARS a Today-flagged project — a LIVE silent-de-star hazard.** `update-project?when=someday`→`when=anytime` on a Today-flagged area-less project drove `start=1, startDate=today` → (`someday`: `start=2, startDate→NULL`) → (`anytime`: `start=1, startDate=NULL`) — the Today star is **destroyed**. The planner routes a Today/Evening-flagged project movee through this bounce (`projects` scope / `project move`) with no guard, exactly the failure the to-do side already refuses (`move.ts` de-Today refusals). **MUST-GUARD: a host-side de-Today refusal for a flagged project movee on the `projects` scope, mirroring the todo-side.** Flagged for an immediate host fix PR (NOT wired from the VM).
2. **HEADMOVE = the unhead → re-head MOVE round-trip is a FLAG-SAFE index sort.** Unhead (`update?id=<u>&list-id=P`) drops the heading FK, re-asserts the project, and PRESERVES `index` AND the full star (`start`/`startDate`/`todayIndex`/`reminderTime`/`deadline` byte-identical). Re-head (`update?id=<u>&list-id=P&heading=H`) BACK-INSERTS on `index` (append past the heading-bucket max), so a FORWARD-order re-head lands the exact target — a scrambled target landed byte-exactly ×2, the starred child's flag intact every pass. This is the SAME mechanism already shipped for `heading-someday` (HEADSUB2 q1fix), now proven for the ANYTIME class AND proven **flag-safe** — so it can replace the de-Today `heading` (`when=someday`→`when=anytime`) bounce for a flag-carrying anytime movee.
3. **LOOSEPARK = park-into-scratch-PROJECT + UNPARK-in-REVERSE-target-order is THE flag-safe loose-anytime sort.** The CENTRAL law: **unpark (`update?id=<u>&list-id=` empty) FRONT-INSERTS at the loose Anytime `index` minimum in dispatch order** → the net top-to-bottom order is the **REVERSE of the unpark dispatch order**. The in-scratch native reorder is therefore MOOT (unpark overwrites it). The wireable shortcut — park all, then unpark in REVERSE target order, no in-scratch reorder — landed the exact target, star-preserving (`start`/`startDate`/`todayIndex`/`reminder`/`deadline` all intact). The AREA-scratch variant is ALSO flag-safe for anytime+Today rows (§9f de-schedules `start=2` only; a Today star is `start=1`), but PROJECT-scratch is the robust default (area-scratch would de-schedule any `start=2` someday/future-dated movee).
4. **PROJPARK = park-into-scratch-AREA + DETACH-in-REVERSE-target-order is the flag-safe `projects` alternative.** Park (`update-project?area-id=PARK`) preserves `index` + the star; the native O14 area project reorder is flag-safe; DETACH (`update-project?area-id=` empty) FRONT-INSERTS identically to the to-do unpark (net order = reverse of dispatch). Detach in reverse target order landed the exact target, the starred project's flag intact end-to-end — a de-Today-free replacement for the PROJSTAR-hazardous `projects` bounce.

5. **AREADEL = deleting an area TRASHES a contained project (soft, area FK cleared) and shallow-trashes its children via the parent.** The area row is HARD-deleted; a direct to-do is `trashed=1` with its `area` FK cleared (A25B reconfirm); a contained PROJECT is `trashed=1` with its `area` FK cleared — a SOFT delete to Trash (the row survives, NOT hard-deleted, NOT orphaned-to-loose); the project's child is `trashed=0` with its `project` FK INTACT — derived-trashed VIA the parent, the shallow project-delete law (A24B). No crash. **This makes the PROJPARK (and LOOSEPARK) teardown require a verified-EMPTY-before-delete step** — a scratch container still holding a parked movee at delete time would trash that movee (recoverable, but wrong); the parallel host-side emptiness guard's refusal copy cites this child-fate law.

**The general MOVE re-entry insertion law on the `index` axis (all arms agree):** a move re-entry to a LOOSE bucket (unpark to Anytime; detach to area-less) **FRONT-inserts** at the bucket `index` minimum in dispatch order (net order = reverse of dispatch → dispatch in REVERSE target order); a move INTO a heading container **BACK-inserts** past the heading-bucket max (dispatch in FORWARD target order). Both are deterministic, and every move leg preserves `start`/`startDate`/`startBucket`/`todayIndex`/`reminderTime`/`deadline` and the untouched container FKs. This is the exact insertion GEOMETRY of the corresponding bounces (`anytime`/`projects` front-insert reverse-order; `heading` back-insert forward-order) — the move family is the bounce family's flag-safe twin, minus the `when=`-leg de-Today.

## Verdict table (observed)

| Arm | Question | Verdict |
|---|---|---|
| **PROJSTAR** — de-star hazard | does the shipped `projects` bounce (`when=someday`→`when=anytime`) preserve a Today-flagged area-less project's star? | **NO — DE-STARS it (LIVE hazard).** `start=1,sd=132805248` → someday `start=2,sd=NULL` → anytime `start=1,sd=NULL`: the Today flag is destroyed. `tIdx` was left stale (−427) but `sd=NULL` makes it inert (no longer a Today member, §9n pattern). The planner's `projects`/`project move` routing has NO de-Today guard for a flagged project. **MUST-GUARD host-side**, mirroring the todo-side `move.ts` refusals. |
| **HEADMOVE** — heading anytime children | is unhead → re-head a flag-safe `index` sort? insertion law? | **YES — flag-safe BACK-INSERT.** Unhead preserves `index` + star (`sd`/`tIdx`/`rem`/`dl` byte-identical); re-head appends past the heading-bucket max, so FORWARD-order re-head lands the target — scrambled target `c2,c3,c1` landed byte-exactly ×2, star intact. Replaces the de-Today `heading` bounce for flag-carrying anytime movees (= the shipped `heading-someday` mechanism, now proven for anytime + flag-safe). |
| **LOOSEPARK** — loose anytime | park/reorder/unpark: what does unpark do to `index`? which protocol is wireable? | **UNPARK FRONT-INSERTS (net order = REVERSE of unpark dispatch); the in-scratch reorder is moot.** The wireable protocol: park all into a scratch PROJECT, then unpark in REVERSE target order — landed target `M3,M1,M4,M2` exactly, star (`sd`/`tIdx`/`rem`/`dl`) preserved. A flag-safe analog of the de-Today ANYBNC/`anytime` bounce. AREA-scratch variant also flag-safe for anytime+Today rows (§9f fires on `start=2` only) but PROJECT-scratch is the robust default. |
| **PROJPARK** — area-less projects | park into scratch area / O14 reorder / detach: flag-safe alt to `projects`? | **YES — park + DETACH-in-REVERSE-target.** Park (`area-id=`) preserves `index` + star; O14 area project reorder is flag-safe; DETACH (`area-id=` empty) front-inserts (reverse of dispatch). Detach in reverse target order landed target `PP3,PP1,PP2`, the starred project's flag intact — the de-Today-free replacement for the PROJSTAR-hazardous bounce. **Teardown risk (AREADEL): the scratch area MUST be verified empty before deletion** — deleting it while a project is still parked would trash that project (soft, FK-cleared) and shallow-trash its children. |
| **AREADEL** — contained project fate on area delete | trashed / hard-deleted / orphaned? child fate? | **Contained PROJECT → `trashed=1`, `area` FK cleared (SOFT delete to Trash, row survives); its child → `trashed=0`, `project` FK INTACT (derived-trashed via parent, A24B shallow law); direct to-do → `trashed=1`, `area` FK cleared (A25B reconfirm); area row HARD-deleted. No crash.** Gates PROJPARK/LOOSEPARK teardown (verified-empty-before-delete) + the host emptiness-guard refusal copy. |

## Per-arm detail

### PROJSTAR — the shipped `projects` bounce de-stars a flagged project (hazard confirm)

Seed: an area-less ANYTIME project `S6-P0` (`add-project`, `type=1 start=1 sd=- idx=−637`), flagged Today via `update-project?when=today` (`start=1, sd=132805248, tIdx=−427` — a Today member). Then the exact two legs of the shipped `projects` BounceSpec (`away=someday, back=anytime`, `legOp=project.update`, `src/write/reorder.ts`):

```
BEFORE flag:     ty=1 st=1 sd=-         sb=0 tIdx=0    idx=-637   (area-less anytime)
after when=today: ty=1 st=1 sd=132805248 sb=0 tIdx=-427 idx=-637   (STAR set: Today member)
after when=someday: ty=1 st=2 sd=-       sb=0 tIdx=-427 idx=-637   (start 1->2, startDate NULLED — de-scheduled)
after when=anytime: ty=1 st=1 sd=-       sb=0 tIdx=-427 idx=-637   (start 2->1, startDate STILL NULL — STAR LOST)
```

The `when=someday` leg de-schedules (`start=2, startDate→NULL`) and the `when=anytime` leg only flips `start` back to `1` — the `startDate=today` is never restored. The Today star is **silently destroyed**. `todayIndex` is left at its stale `−427` but with `sd=NULL` the row is no longer a Today member (an inert stale byte, the §9n / REMSTALE pattern), so the star is genuinely gone GUI-side.

This is the project-side twin of the hazard `move.ts` already refuses for to-dos: ordering a Today/Evening-flagged row on a `when=`-bounce index axis OVERWRITES the flag (`move.ts:606–630`, `:668–682` — "the loose `${axis}` axis, whose `when=` legs OVERWRITE the Today/Evening flag (de-Today hazard) — refused rather than silently stripping it"). But the `projects` scope (sidebar top-level project order, `things project move`) has NO such guard: a Today/Evening-flagged area-less project movee is routed straight through the de-star bounce.

**MUST-GUARD verdict.** The planner MUST refuse a Today/Evening-flagged project movee on the `projects` bounce with a de-Today refusal, exactly like Phase B's todo-side refusal — because there is currently NO Today-flag-safe native surface for sidebar project order (P17 native writes are dead; the only order surface is this bounce). Until the flag-safe PROJPARK protocol (Arm 4) is wired, the correct behavior is to refuse rather than silently de-star. **Evidence only — NOT wired here; flagged for an immediate host-side fix PR.**

### HEADMOVE — the unhead → re-head move round-trip (flag-safe within-heading anytime sort)

Project `S6-P1` carrying heading `H1` (seeded via `things:///json` HX0 — a heading in an EXISTING project is Shortcuts-only, so the heading is born at project-create time). Three anytime children under `H1` — `c1`, `c3` plain (`start=1, sd=-`) and `c2` STARRED Today + `09:00` reminder + `2026-07-10` deadline (`start=1, sd=132805248, tIdx=−820, rem=603979776, dl=132805888`) — plus two unheaded root anytime children.

**(a) Unhead (`update?id=<u>&list-id=P1`, no `heading` param) — clean, keys KEPT.**

```
c2 before: st=1 sd=132805248 sb=0 tIdx=-820 idx=-313 hd=MZ3Xhm9Y rem=603979776 dl=132805888
c2 after : st=1 sd=132805248 sb=0 tIdx=-820 idx=-313 hd=-        rem=603979776 dl=132805888  p=X9mWZ8Tp
```

`heading` → NULL, `project` → the parent project, `index` UNCHANGED (`c1`=−617, `c2`=−313, `c3`=0 all kept), and the star (`start`/`startDate`/`todayIndex`/`reminderTime`/`deadline`) byte-identical. Confirms the HEADSUB1 Arm C unhead law and extends it to a Today-flagged carrier: **unhead is flag-safe.**

**(b) Re-head (`update?id=<u>&list-id=P1&heading=H1`) in forward order `c3,c1,c2` — BACK-INSERT on `index`.** Final in-heading `index` order `c3(−1276) < c1(−617) < c2(−313)` == the re-head dispatch order. Each re-headed row appends past the heading-bucket running max (§9l requires the heading FK to actually CHANGE — these rows were unheaded first, so the move fires). `c2`'s star intact.

**(c) Scrambled target `c2,c3,c1` (unhead all → re-head in target order), ×2.** Both passes landed the exact target on `index` (`c2 < c3 < c1`), and `c2`'s star byte-identical every pass (`st=1 sd=132805248 tIdx=−820 rem=603979776 dl=132805888`).

**Verdict.** The unhead → re-head MOVE round-trip is a flag-safe within-heading anytime sort — the same mechanism the shipped `heading-someday` scope already uses (HEADSUB2 q1fix), now proven for the ANYTIME class and proven to preserve the Today star + reminder + deadline. It is a drop-in flag-safe replacement for the `heading` (`when=someday`→`when=anytime`, BOUNCE2-h) bounce when the movee carries a Today/Evening flag: two `todo.move` legs per item, forward target order, no experimental/bounce gate. Evidence only — NOT wired.

### LOOSEPARK — park-sort-unpark and the central unpark front-insert law

Four loose area-less to-dos (`L2` starred Today + reminder + deadline). **Seed note:** a bare `things:///add?title=X` lands in the **Inbox** (`start=0`), not Anytime — `L1/L3/L4` were therefore inbox rows normalized to Anytime (`start=1`) by the park; the star-carrier `L2` (`when=today@09:00`) was a genuine `start=1` Today row throughout. The clean-anytime re-runs (Arm 2d/2e) seed with `&when=anytime` (verified to produce `start=1, sd=NULL`, loose).

**(a) Park into a scratch PROJECT (`update?id=<u>&list-id=SCR`).** `project` set; the star `L2` preserved (`sd=132805248, tIdx=−1465, rem=603979776, dl=132805888`). Park appends in dispatch order (each park a less-negative `index`: `L1(−2947) < L2(−2411) < L3(−2231) < L4(−1917)` for dispatch `L1,L2,L3,L4`).

**(b) In-scratch native project reorder** (`_private_experimental_ reorder to dos in project id SCR with ids L3,L1,L4,L2`) — `index` re-ranked to EXACT sent order (`L3(−5132) < L1(−4670) < L4(−4156) < L2(−3598)`), `L2`'s star intact. Flag-safe native reorder confirmed on parked-loose rows.

**(c) THE CENTRAL LAW — UNPARK (`update?id=<u>&list-id=` empty) FRONT-INSERTS.** Unparking in the SAME order `L3,L1,L4,L2` gave a FINAL loose `index` order of `L2(−6598) < L4(−6115) < L1(−5732) < L3(−5132)` — the exact **REVERSE** of the unpark dispatch. Each unpark front-inserts at the current loose Anytime `index` minimum, so the last-unparked lands on top. **The in-scratch reorder is completely overwritten by unpark** — a forward park-sort-unpark does NOT preserve the sorted order. Star preserved on `L2` throughout (`sd`/`tIdx`/`rem`/`dl`).

**(d) The wireable SHORTCUT (Arm 2d) — park all, unpark in REVERSE target order, no in-scratch reorder.** Fresh clean-anytime seeds `M1..M4` (`M2` starred). Park all into `SCR` (star-preserving). Target loose order `M3,M1,M4,M2` → unpark in REVERSE `M2,M4,M1,M3`:

```
FINAL loose index order: M3(-9483) < M1(-8975) < M4(-8792) < M2(-8412)   == target M3,M1,M4,M2  ✓
M2 star: st=1 sd=132805248 tIdx=-1844 rem=603979776 dl=132805888          (byte-preserved)
```

Exact target, star-preserving. This is the wireable flag-safe loose-anytime MOVE protocol: park each movee into a scratch PROJECT, then unpark (`list-id=` empty) in REVERSE target order. 2N dispatches (N park + N unpark) + scratch-project lifecycle. The scratch container is REQUIRED — a bare `list-id=` on an already-loose row is a no-op (UPCORD1), so an already-loose set has no "unpark" until it is first parked.

**(e) AREA-scratch variant (Arm 2e) — ALSO flag-safe for anytime+Today rows.** Fresh clean-anytime `N1..N4` (`N2` starred) parked into a scratch AREA (`update?list-id=SCRA`). The native area reorder (`reorder to dos in area id SCRA with ids N3,N1,N4,N2`) re-ranked `index` exactly AND left `N2`'s star UNTOUCHED:

```
N2 after area reorder: st=1 sd=132805248 sb=0 tIdx=-2276 rem=603979776 dl=132805888   (star INTACT — §9f did NOT fire)
```

This REFINES §9f: the area-reorder de-schedule is keyed on **`start=2`** (someday AND future-dated members → collapsed to anytime, startDate stripped), NOT on "has a startDate". A Today star is a **`start=1`** anytime-bucket state (a status pip on an `index`-sorted row), so the area reorder leaves it alone. Detach in reverse target `N2,N4,N1,N3` then landed `N3 < N1 < N4 < N2`, star intact. So BOTH scratch containers are flag-safe for an anytime+Today set — but PROJECT-scratch is the robust default: an AREA scratch would de-schedule any `start=2` someday/future-dated movee mixed into the set (§9f), whereas a project scratch never does.

### PROJPARK — area-less projects via a scratch area (flag-safe `projects` alternative)

Three area-less anytime projects `PP1..PP3`; `PP2` flagged Today (`update-project?when=today` → `start=1, sd=132805248, tIdx=−2859`). Scratch area `S6-PARK`.

**(a) Park (`update-project?id=<p>&area-id=PARK`).** `area` set; `index` PRESERVED (`PP3(−3103), PP2(−2740), PP1(−2275)` unchanged); `PP2`'s star preserved (`sd=132805248, tIdx=−2859`).

**(b) Native O14 area PROJECT reorder** (`reorder to dos in area id PARK with ids PP3,PP1,PP2` — the misleadingly-named command accepts project uuids, O14/S-campaign P1) — `index` re-ranked exactly (`PP3(−4746) < PP1(−4113) < PP2(−3449)`), `PP2`'s star intact. The area PROJECT reorder is flag-safe (like the to-do case; the §9f de-schedule does not fire on `start=1`).

**(c) Detach (`update-project?id=<p>&area-id=` empty) — FRONT-INSERT, and (Arm 3b) landing the target.** Detaching FORWARD `PP3,PP1,PP2` produced the reverse (`PP2,PP1,PP3`), confirming the same front-insert law as the to-do unpark. The land-target re-run (Arm 3b) — park all, then detach in REVERSE target `PP2,PP1,PP3`:

```
FINAL area-less project index order: PP3(-6774) < PP1(-6317) < PP2(-5748)   == target PP3,PP1,PP2  ✓
PP2 star: st=1 sd=132805248 sb=0 tIdx=-2859                                  (flag intact end-to-end)
```

**Verdict.** Park each area-less project into a scratch AREA (`area-id=`), then detach (`area-id=` empty) in REVERSE target order — lands the exact target, star-preserving. This is the flag-safe MOVE alternative to the de-Today `projects` bounce (PROJSTAR): the wireable answer to the Arm-0 hazard once the guard ships. 2N dispatches + scratch-area lifecycle. **Teardown-risk profile (AREADEL, below):** the scratch area MUST be verified EMPTY before it is deleted — a project still parked in it at delete time is TRASHED (soft, `area` FK cleared) and its children shallow-trashed via the parent (recoverable, but wrong). The wiring detaches all movees first (the protocol's final legs) and then deletes only a confirmed-empty scratch area. Evidence only — NOT wired.

### AREADEL — the fate of a contained project when its area is deleted (PROJPARK teardown gate)

A25/A25B proved an AppleScript area delete HARD-deletes the `TMArea` row and sets `trashed=1` on contained TO-DOS, but the fate of a contained PROJECT was unprobed — and it decides the PROJPARK teardown risk. Seed: disposable area `S6-DELA` with one direct to-do `DT` (`area=DELA`), one project `DELP` (`area=DELA`) carrying one child to-do `DPC` (`project=DELP`, area resolved via the project). Then `delete area id <DELA>` (the shipped AppleScript spelling).

```
BEFORE:  DT   ty=0 tr=0 a=DELA           (direct to-do)
         DELP ty=1 tr=0 a=DELA           (contained project)
         DPC  ty=0 tr=0 p=DELP  a=-      (project child; area via parent)
         TMArea[DELA] present

delete area id DELA  →  Things3 pid ALIVE before AND after (no crash, §7 clear)

AFTER:   TMArea[DELA]  → 0 rows           (area HARD-deleted)
         DT   → tr=1  a=NULL              (direct to-do TRASHED, area FK cleared — A25B reconfirm)
         DELP → tr=1  a=NULL  status=0    (project SOFT-deleted to Trash: row SURVIVES, area FK cleared;
                                            NOT hard-deleted, NOT orphaned-to-loose)
         DPC  → tr=0  p=DELP (INTACT)     (child NOT directly trashed; project FK kept — derived-trashed
                                            VIA the parent, the shallow project-delete law A24B)
```

**Reconciliation (AREADEL2) — corrects the stale P20 claim.** The p-suite P20 note asserted "deleting an AREA does not trash its projects — the project survives with `area=NULL`" (a live orphan). AREADEL contradicts it, so AREADEL2 re-ran the split with BOTH an EMPTY project and a child-bearing project in one area:

```
EMPTYP (empty project)        AFTER area delete →  exists, tr=1, area=NULL
CHILDP (child-bearing project) AFTER area delete →  exists, tr=1, area=NULL
CPC    (CHILDP's child)         AFTER area delete →  tr=0, project=CHILDP (INTACT)
```

BOTH projects are TRASHED regardless of emptiness — so child-presence is NOT a discriminator, and **P20's "orphan to no-area" claim is SUPERSEDED** (a behavior/version change or an original mismeasurement; current app is Things 3.22.11). The authoritative current law: a contained project is TRASHED (`trashed=1`, `area` FK cleared), exactly like a contained to-do.

**Verdict.** Deleting an area cascades a TRASH (not a hard delete) to its direct members — both to-dos AND projects go `trashed=1` with their `area` FK cleared — and each trashed project is itself SHALLOW toward its own children (they keep their `project` FK, `trashed=0`, derived-trashed through the parent, exactly A24B). Contrast the AREA row itself, which IS hard-deleted (areas have no Trash, P20's one still-correct half). This is the **PROJPARK / LOOSEPARK teardown-risk profile**: a scratch container deleted while it still holds a parked movee TRASHES that movee (soft, recoverable — an area-scratch project or a project-scratch to-do). Both protocols therefore require a **verified-empty-before-delete** step — the wiring detaches every movee (its final legs) and asserts the scratch container is empty before deleting it. The parallel host-side emptiness guard cites this child-fate law in its refusal copy. Evidence only.

## Candidate capability-matrix wiring (for the orchestrator — NOT wired here)

The move family gives every de-Today-hazardous index bounce a flag-safe twin. Recorded here for the wiring change (feasibility cells stay as-is; SIT6 adds the protocol-proven-unwired notes):

- **PROJSTAR — immediate host fix (independent of the below):** add a de-Today refusal to the `projects` scope for a Today/Evening-flagged project movee (mirror `move.ts`), because there is no flag-safe native sidebar-project order surface. Refuse rather than silently de-star. (A separate, small PR — flagged, not made here.)
- **`heading` (flag-carrying movee):** route a Today/Evening-flagged within-heading anytime movee through the **HEADMOVE** unhead → re-head round-trip (= the shipped `heading-someday` mechanism, forward target order) instead of the de-Today `when=someday`→`when=anytime` bounce. Flag-safe, no gate.
- **`anytime` (flag-carrying movee):** route a Today/Evening-flagged loose area-less anytime movee through the **LOOSEPARK** park-into-scratch-PROJECT → unpark-in-REVERSE-target protocol instead of the de-Today ANYBNC bounce. Flag-safe; scratch-project lifecycle is the only new machinery.
- **`projects` (flag-carrying movee):** route a Today/Evening-flagged area-less project movee through the **PROJPARK** park-into-scratch-AREA → detach-in-REVERSE-target protocol instead of the de-star bounce. Flag-safe; scratch-area lifecycle.
- **Plain (unflagged) movees** keep the cheaper shipped bounces — the move protocols are the flag-carrying alternative, not a wholesale replacement (though HEADMOVE/LOOSEPARK/PROJPARK would serve the plain population too, at 2N move dispatches vs the bounce's 2N `when=` dispatches).

## App oddities filed / refined

- **§9f refinement (SIT6, this change):** the private area reorder's de-schedule side effect is keyed on **`start=2`** (someday + future-dated), NOT on the presence of a `startDate`. A **Today-flagged (`start=1`) member is PRESERVED** by the area reorder — `start`, `startDate=today`, `todayIndex`, reminder and deadline all survive (LOOSEPARK Arm 2e; PROJPARK Arm 3b for a Today project). So the UPCORD1 "collapse ANY non-anytime member to anytime" wording is narrowed: the collapse is `start=2 → 1` (+ `startDate→NULL`); `start=1` anytime-bucket rows (plain OR Today-flagged) reorder cleanly. Recorded in [things-app-oddities.md](../things-app-oddities.md) §9f.

No genuinely new app bug: the PROJSTAR de-star is our planner routing a flagged project through a `when=` bounce whose `startDate`-clearing is already-documented app behavior (`when=someday` NULLs `startDate`) — it is a library hazard to guard, not an app quirk. HEADMOVE/LOOSEPARK/PROJPARK move-leg preservation CONFIRMS existing move-family flag-safety (P9f, HEADSUB1/2, UPCORD1). AREADEL CONFIRMS + EXTENDS existing delete laws: the area row hard-delete (A25) and direct-to-do trash (A25B) reconfirmed, the contained-project trash-with-FK-cleared is the project analog, and the child's via-parent derived-trash is the shallow project-delete law (A24B) — recorded in the matrix Trash & system note, not filed as a new quirk.

## Novel paths added

- **The flag-safe index MOVE re-entry law** — unpark/detach (`list-id=`/`area-id=` empty) FRONT-inserts at the destination loose bucket's `index` min in dispatch order (net order = reverse of dispatch → reverse-target dispatch); re-head (`list-id=P&heading=H`) BACK-inserts past the heading-bucket max (forward-target dispatch); all move legs preserve `start`/`startDate`/`startBucket`/`todayIndex`/`reminder`/`deadline`. The de-Today-free twin of the BOUNCE2/ANYBNC/`projects` insertion geometry. Filed in [reference/novel-paths.md](../reference/novel-paths.md).

## Reproduce

```sh
TART_HOME=/Volumes/Workspace/tart \
  bash lab/scripts/research-sit6.sh setup      # clone+boot+airgap+clock-pin+warm-up+token
  bash lab/scripts/research-sit6.sh arm0        # PROJSTAR de-star hazard confirm (FIRST)
  bash lab/scripts/research-sit6.sh arm1        # HEADMOVE unhead/re-head flag-safe within-heading sort
  bash lab/scripts/research-sit6.sh arm2        # LOOSEPARK park/reorder/unpark — the central front-insert law
  bash lab/scripts/research-sit6.sh arm2d       # LOOSEPARK shortcut (park all, unpark in REVERSE target)
  bash lab/scripts/research-sit6.sh arm2e       # LOOSEPARK AREA-scratch variant (§9f start=2-only refinement)
  bash lab/scripts/research-sit6.sh arm3        # PROJPARK park/O14-reorder/detach — front-insert law
  bash lab/scripts/research-sit6.sh arm3b       # PROJPARK land-target (detach in REVERSE target)
  bash lab/scripts/research-sit6.sh areadel     # AREADEL contained-project fate on area delete (PROJPARK teardown gate)
  bash lab/scripts/research-sit6.sh areadel2    # AREADEL2 empty vs child-bearing project (reconciles the stale P20 orphan claim)
  bash lab/scripts/research-sit6.sh teardown
```

All arms headless (no Accessibility, no VNC — URL scheme + `things:///json` + AppleScript private reorder). Every re-entry target is SCRAMBLED so a passing final order proves the sequence controls placement. Evidence (gitignored, synthetic): `lab/artifacts/sit6-lab/report.txt`.
