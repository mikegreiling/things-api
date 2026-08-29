# TMOV1 — a repeating template's CONTAINER is independently mutable

**Version stamp:** `things-lab-golden-v4` · Things **3.23** (CFBundleVersion **32300036**, direct-download channel) · macOS **15.7.7 (24G720)** · `Meta.databaseVersion` **27** · airgapped clone, guest clock pinned **2026-07-05 12:00 (a Sunday)**; cell S alone rolls it, monotonically to 07-07 and 07-08, never approaching the 2026-07-18 trial wall · AXVM1 accessibility grant baked · both #597 lab escapes exported. Campaign run 2026-08-29, unattended, over **one** clone in two passes (pass 2 re-takes cell S — §7). Immutable snapshot per the [harness](harness.md) version-stamping policy.

Driver: [`lab/scripts/research-tmov1.sh`](../../lab/scripts/research-tmov1.sh) (cells selected by `CELLS=…`; `REUSE=1` attaches to a live clone; `SPNAME=…` names cell S's fixture so the cell can be re-taken on a clone whose clock has already moved). Fixtures fully synthetic (`TMOV1-*`). Artifacts: `lab/artifacts/tmov1-lab{,-s2}/` (gitignored) — `report.txt`, per-gesture full-row snapshots in `snap/`, per-command CLI output in `log/`.

**The dist shipped into the clone is GUARD-LIFTED** — `todo.move`/`project.move` removed from `REPEAT_SENSITIVE` in the working copy, nothing else about the ops changed — so every cell drives the **shipped verb** through the real pipeline (pre-read, compile, dispatch, read-after-write verify, `expectedDelta`). That is the only thing that can certify a lift; a raw-URL probe would not have exercised the verification the op will actually run.

**DB oracle:** every gesture is bracketed by a **full-row snapshot** of every `TMTask` column for every `TMOV1-%` row (`rowsnap.py` → `uuid⇥column⇥value`, packed dates decoded, blobs hashed), diffed field by field — 574 fields across 14 rows in pass 1, 738 across 18 in pass 2. Per arm the rule blob's **sha256**, both spawn cursors (`rt1_nextInstanceStartDate`, `rt1_instanceCreationStartDate`), `rt1_instanceCreationCount`, `rt1_instanceCreationPaused` and `start` are compared as a single string. Beep sentinel armed per drive (report-only per [BEEPSEN1](beepsen1-beep-sentinel.md)).

Predecessors: [rsim-results.md](rsim-results.md) §P3 (template-side CHILDREN move cleanly between projects on url-scheme), §S4/§S-R3 (the built-in-**LIST** wall, AS 301, measured on a template-side child), [oddities §1](../things-app-oddities.md) (URL *scheduling* writes on a template crash Things — T12/U12), [cnc1-template-mutations.md](cnc1-template-mutations.md) (the CNC composite cell S drives).

**Result: 42 passing assertions, 0 app failures** (pass 1 `PASS=37 FAIL=1`, pass 2 `PASS=5 FAIL=0`; the single FAIL is a rig defect in the driver, not the app — §7).

---

## 0. Headline

1. **Every container transition is CLEAN, on BOTH vectors.** project→project, project→area, area→project, container→loose and loose→project all land on a repeating to-do template; area→area and area→loose land on a repeating **project** template; the after-completion rule shape behaves identically. Verified through the shipped `things todo move` / `things project move` — url-scheme tier 0 by default, and the same result with `--vector applescript` (§2–§5).
2. **The rule is never touched.** In every arm the delta over the WHOLE fixture set is exactly three things: the moved row's container FK, the moved row's `userModificationDate`, and the two containers' cached leaf counts. `rt1_recurrenceRule` comes back **byte-identical by sha256**, both cursors, `rt1_instanceCreationCount`, `rt1_instanceCreationPaused` and `start` are unchanged, and the series' existing occurrence rows are untouched (§2).
3. **The fence it was behind was a placeholder, and the wall it was standing in for is somewhere else.** `H-REPEAT-SCHEDULE` refused `todo.move`/`project.move` on the strength of "status/move on templates are unvalidated" (`REPEAT_SENSITIVE`, annotated *E07/E14 probed plain rows*). What the app actually refuses is the **built-in-LIST destination**: `move … to list "Inbox"` and `move … to list "Someday"` on a TEMPLATE both error **301** with zero row delta — the same wall RSIM-S §S4/§S-R3 measured one level down, on a template-side child (§4).
4. **Spawning FOLLOWS the template; the already-materialized occurrence does NOT.** After a template is moved, both the app's own clock spawner and the shipped CNC composite mint the next occurrence into the **new** container — but the occurrence that already existed stays in the old one, and nothing says so. That is the one thing a caller has to be told, and it now rides the result as a disclosure (§6).
5. **Zero alert beeps, zero crash reports, app alive after all 13 gestures**, including the two raw-AppleScript 301s.
6. **A pre-existing, unrelated refusal rides every template move that lands in a dated day-group** — the placement leg reports `blocked: H-REORDER-SCOPE` (a day-group containing a template needs the native private reorder surface, inert since 3.23) and the result degrades to `placementClass: app-default` with `ok: true`. Membership always lands. Not introduced here and not in scope; recorded so the JSON in §2 reads correctly (§2.3).

---

## 1. What was fenced, and on what evidence

`src/write/guards.ts` listed both move ops in `REPEAT_SENSITIVE`:

```
"todo.move",
…
"project.move", // unvalidated on repeating projects (E14 probed a plain project)
```

and the block they produced said, verbatim:

> `target is a repeating template: URL scheduling writes crash Things (T12/U12); status/move on templates are unvalidated`
> remediation: `edit the repeat rule in the Things app; title/notes updates and checklist replacement remain allowed on templates`

Two things are wrong with that as a refusal for a container move. The *detail* cites a crash that belongs to a different parameter — `when=`/`deadline=` on a template ([oddities §1](../things-app-oddities.md)) — and then admits the move arm is **unvalidated**, which is a reason to measure, not a reason to refuse. The *remediation* answers a question nobody asked: a caller who typed `--to-project` is not trying to edit a repeat rule, and the Things app's Repeat dialog cannot move an item between projects anyway.

The measured facts sitting either side of the fence were both narrower than it:

| Fact | Evidence | Scope |
|---|---|---|
| URL **scheduling** writes on a template crash the app | T12/U12, [oddities §1](../things-app-oddities.md) | `when=` / `deadline=`. A `list-id` write carries neither |
| AS `move … to list "Someday"/"Inbox"` errors **301** | [RSIM-S §S4/§S-R3](rsim-results.md) | built-in **lists**, and measured on a template-side CHILD |
| Template-side **children** move between projects cleanly on url-scheme, "no guard, no residue" | [RSIM-P P3](rsim-results.md) | the adjacent row class |

Both ops compile to an ordinary container write on the tier-0 vector — `todo.move` → `things:///update?id=…&list-id=…`, `project.move` → `things:///update-project?id=…&area-id=…` — with an AppleScript alternate (`set project of to do id …` / `set area of project id …`). Neither spelling carries a scheduling parameter. Reported as **#655**.

## 2. Cell A — the container CHAIN on a fixed weekly to-do template

One template (`TMOV1-FIX`, `tp=0 fu=256 fa=1 ts=0 of=[{wd=0(Sun)}]`, `ruleSha=4a52076bf78643ec`, one materialized occurrence, `next = icStart = 2026-07-12`, `icCount=1`) walked through five transitions, each a separate shipped `things todo move` with a full-row snapshot either side.

| Arm | Transition | Container after | Rule + cursors |
|---|---|---|---|
| **A1** | project → project | `project=TMOV1-ProjTwo` | unchanged |
| **A2** | project → area | `area=TMOV1-AreaBeta`, `project=NULL` | unchanged |
| **A3** | area → project | `project=TMOV1-ProjOne` | unchanged |
| **A4** | container → LOOSE (`--loose`) | `project=NULL area=NULL` | unchanged |
| **A5** | loose → project | `project=TMOV1-ProjTwo` | unchanged |

The rule/cursor oracle read the identical string after every one of the five:

```
icCount=1 icStart=2026-07-12 next=2026-07-12 paused=0 ruleSha=4a52076bf78643ec start=2
```

### 2.1 The delta is three things, every time

A1's full-row diff, verbatim and complete (14 rows, 574 fields compared):

```
CHANGED 2HfCZHA6.openUntrashedLeafActionsCount: 0 -> 1
CHANGED 2HfCZHA6.untrashedLeafActionsCount: 0 -> 1
CHANGED JR5q9a5d.project: WJfbpHZxbUTW5VdnNPdxVD -> 2HfCZHA68pnSq7AoEZMczq
CHANGED JR5q9a5d.userModificationDate: 1783252845.134068 -> 1783252878.2807012
CHANGED WJfbpHZx.openUntrashedLeafActionsCount: 10 -> 9
CHANGED WJfbpHZx.untrashedLeafActionsCount: 10 -> 9
```

The template's own row moves its container FK and its modification stamp; the source and destination projects update their cached leaf counts. Nothing else in the fixture set moves — the series' materialized occurrence included. A2 is the same shape with the `area` FK set and `project` NULLed in one write (`CHANGED JR5q9a5d.area: None -> BR72W2Vb…` + `CHANGED JR5q9a5d.project: 2HfCZHA6… -> None`), which is the ordinary A22B "assigning an area clears the project link" law arriving on a template.

`start` stays `2` (Someday) throughout, which is where a resting template lives: a container move never re-buckets it.

### 2.2 Both vectors — cell X

`TMOV1-XAS`, a second identical fixture, moved project→project with `--vector applescript`. Result `ok:true`, `"vector":"applescript"`, `"tier":0`, and a delta of exactly the same six lines. So the alternate spelling (`set project of to do id X to project id Y`) is not a second-class path here; the two vectors agree field for field.

### 2.3 The placement leg's pre-existing refusal

Every one of these moves reports, inside an `ok: true` result:

```json
"placement":{"kind":"blocked","op":"reorder","reason":"hazard","hazard":"H-REORDER-SCOPE",
 "detail":"the 2026-07-12 day-group contains repeating template(s) […] whose day-block placement
 needs the native private reorder surface (a dated when= leg CRASHES a template — §1/§9e), but it
 is unavailable (Things 3.23 applies the private reorder command without changing anything…)"},
"placementClass":"app-default"
```

That is the pre-existing, correct behavior of the move orchestrator's *placement* half on 3.23 — membership lands, position falls back to app-default. It is not caused by, and does not qualify, anything in this campaign. It does mean a template move is never `placementClass: guaranteed`, which is worth knowing before reading the JSON above as a partial failure.

## 3. Cells P and AC — the other two shapes

**P — a repeating PROJECT template.** `TMOV1-PRJ` (weekly, `ruleSha=4a52076bf78643ec`, `icCount=1`) through `things project move`:

| Arm | Transition | Delta |
|---|---|---|
| **P1** | area → area | `CHANGED FqzKUrkS.area: H3nDnqLH… -> BR72W2Vb…` + `userModificationDate` |
| **P2** | area → LOOSE (`--no-area`) | `CHANGED FqzKUrkS.area: BR72W2Vb… -> None` + `userModificationDate` |

Two fields on one row, both times — a project has no cached-leaf-count neighbour to update because it is not a leaf. Rule and both cursors unchanged after each.

**AC — the after-completion rule shape.** `TMOV1-AC` (`tp=1`, `ruleSha=44961aadf17d2ff9`, `next=None`, `icStart=2026-07-06`) moved project→project. Same six-line delta as A1, `icCount`/`icStart`/`ruleSha`/`paused`/`start` unchanged. The rule KIND does not enter into it, which is what one would expect of a write that never reads the rule.

## 4. Cell C — the CONTROL, and the wall that is real

Three gestures at the same fixture (`TMOV1-CTL`, still in `TMOV1-ProjOne`).

**C1 — the shipped `things todo move <template> --inbox`** (which compiles ONLY to AppleScript `move … to list "Inbox"`; the url-scheme `update` has no Inbox target). Exit **3**:

```json
{"ok":false,"error":{"code":"verify-failed",
 "detail":{"failed":{"kind":"verify-failed","op":"todo.move","reason":"silent-noop",
  "expected":{"assert":[{"field":"start","equals":"inbox"},{"field":"startDate","equals":null}]},
  "observed":{"start":"someday","startDate":null},
  "detail":"transport failed (exit 1): 30:84: execution error: Things3 got an error: Cannot move to-do (301) — and a follow-up re-read found no landed change"}}}}
```

**C2 — raw AppleScript `move to do id <template> to list "Someday"`** (the §S4 spelling):

```
30:86: execution error: Things3 got an error: Cannot move to-do (301)
```

**C3 — raw AppleScript `move to do id <template> to list "Inbox"`** (the §S-R3 spelling):

```
30:84: execution error: Things3 got an error: Cannot move to-do (301)
```

All three: **zero field changed on any surviving row**, template still in `TMOV1-ProjOne`, rule and cursors unchanged, app alive, zero beeps.

**The law.** RSIM-S §S4/§S-R3 established the built-in-list wall for a template-side CHILD; it holds for the **template row itself**, on both list names, through the shipped verb and through raw AppleScript alike. The wall is keyed on the DESTINATION being a built-in list, not on the op being a move — which is exactly the shape the narrowed fence takes.

This is also why `todo.restore`/`project.restore` stay refused for a trashed template: our restore *is* a move to the Inbox, so it runs into this same 301 (RSIM-S §S-R3). That branch of `H-REPEAT-SCHEDULE` is unchanged and now shares a documented cause with the `--inbox` branch.

## 5. What the narrowed fence became

```
todo.move / project.move  →  removed from REPEAT_SENSITIVE
todo.move with `inbox: true` on a template  →  refused, by destination:

  detail: the target is a repeating template, and the app refuses to move one to a
          built-in list — the Inbox return errors 301 and changes nothing (TMOV1 C1/C3)
  remediation: move the series to a project or an area instead (`--to-project` /
          `--to-area`), or detach it from every container with `--loose`
```

`project.move` needs no branch at all — a project has no built-in-list destination to reach — so `H-REPEAT-SCHEDULE` was dropped from its hazard list rather than left declared and unfireable. Every scheduling and status fence is untouched: `todo.update --when/--deadline` still steers two ways, the status ops still route to the CNC composite with the guard as their backstop, and both `restore` arms keep their Put-Back message.

## 6. Cell S — does the SPAWN follow?

The question a container move raises that a plain row's does not: the template is a factory, so after it moves, where do its products land?

**Pass 1** (`TMOV1-SPN`, daily, seeded 2026-07-05 with one materialized occurrence dated 07-05) and **pass 2** (`TMOV1-SPN2`, daily, seeded 2026-07-07) answer it twice, once through the app's own clock spawner and once through the shipped CNC composite.

### 6.1 The existing occurrence does NOT follow

Immediately after `things todo move <template> --to-project TMOV1-ProjTwo`:

```
DOES THE EXISTING OCCURRENCE FOLLOW? 749aBx6cUgEj3vDN9vEYjX -> project=TMOV1-ProjOne …

uuid      status  trashed  start  startDate  proj      area  head
749aBx6c  0       0        1      132805504  WJfbpHZx  -     -      ← the occurrence, still in ProjOne
5KGcERAc  0       0        2                 2HfCZHA6  -     -      ← the template, now in ProjTwo
```

The series is split across two containers, and no surface says so. Confirmed from the other side by the composite's own result a moment later, which names the occurrence's project in its context block:

```json
"occurrence":{"templateUuid":"5KGcERAc…","occurrenceUuid":"749aBx6c…","minted":false,"date":"2026-07-07"},
"context":{"project":{"uuid":"WJfbpHZx…","title":"TMOV1-ProjOne","remainingOpen":5}}
```

### 6.2 Every NEW occurrence lands in the new container

**Through the CNC composite (pass 2, S3).** With the current occurrence resolved, a second `things todo complete <template>` mints the pending one:

```json
"occurrence":{"templateUuid":"5KGcERAc…","occurrenceUuid":"V22xqdym…","minted":true,"date":"2026-07-08"}
```

and the minted row is born `project = 2HfCZHA68pnSq7AoEZMczq` — `TMOV1-ProjTwo`, the NEW container. Cursors advance normally (`icCount 1 → 2`, `next/icStart 2026-07-08 → 2026-07-09`), rule blob unchanged.

**Through the app's own clock spawner (pass 1, S4).** Rolling the guest clock 07-05 → 07-07 made the daily series spawn the two slots it had missed. Both inserted rows carry `project = 2HfCZHA68pnSq7AoEZMczq`:

```
INSERTED row Sp6wEvwy…:  title = TMOV1-SPN  startDate = 132805376(2026-07-06)  project = 2HfCZHA6…
INSERTED row XvD1LRYt…:  title = TMOV1-SPN  startDate = 132805504(2026-07-07)  project = 2HfCZHA6…
CHANGED YMM73U24.rt1_instanceCreationCount:     1 -> 3
CHANGED YMM73U24.rt1_instanceCreationStartDate: 2026-07-06 -> 2026-07-08
CHANGED YMM73U24.rt1_nextInstanceStartDate:     2026-07-06 -> 2026-07-08
```

leaving the series' four rows in exactly two places — the one pre-move occurrence in `ProjOne`, everything from the move onward in `ProjTwo`.

A **third** confirmation fell out of pass 2 for free: its own clock roll (07-07 → 07-08) spawned the next slot of pass 1's `TMOV1-SPN` series — the one moved a pass earlier, at a different date, on a cursor the composite had never touched — and that row too was born `project = 2HfCZHA68pnSq7AoEZMczq`. (Pass 2's S4 assertion itself is weak evidence and is not counted as a spawn oracle: `TMOV1-SPN2`'s cursor had already been advanced past 07-08 by the S3 mint, so the roll had nothing of its own to spawn and the assertion re-read the S3 row.)

**Law (TMOV1-S).** *The spawner reads the template's CURRENT container at mint time. A container move is fully forward-effective and never retroactive: occurrences minted after the move land in the new container, and occurrences that already exist stay where they were.* Measured on both minting paths, on the same fixture shape, in two passes.

That asymmetry is defensible — it is what the GUI does too, since moving a repeating row in Things moves the rule row — but it is not guessable from the result of a move, so the op now discloses it whenever the moved target is a template with a live occurrence.

### 6.3 An incidental observation, recorded not chased

The clock roll in pass 1 also advanced the **unrelated** after-completion fixture's cursor (`M9grgmkJ.rt1_instanceCreationStartDate: 2026-07-06 → 2026-07-08`) with no row inserted and no `icCount` change. A never-anchored after-completion series appears to track the clock rather than hold a fixed cursor. Nothing in this campaign turns on it and it was not probed; noted here so a future reader of the S4 delta does not mistake it for a move effect.

## 7. Rig notes

**The pass-1 FAIL was the driver, not the app.** Cell S's composite calls were written as `things todo complete <template> --dangerously-drive-gui`, and that flag does not exist on `complete` — `todo complete` on a series routes through the CNC composite, which owns its own drive gating. Both calls exited 1 with `error: unknown option '--dangerously-drive-gui'`, nothing was minted, and the S3 assertion then read the PRE-EXISTING occurrence (still in `ProjOne`, correctly) and failed. A zero-delta cell whose command never ran is not evidence of anything — the [CNCAC1](cncac1-after-completion-checkoff.md) law in its plainest form. Fixed in the driver and re-taken as pass 2 on the same clone (`REUSE=1 CELLS=S SPNAME=TMOV1-SPN2`), where both composite legs return `ok:true` and S3 passes.

The re-take is also why cell S now **mints its own fixture** at the guest's current day rather than depending on the SEED cell's: pass 2 ran on a clone whose clock had already been rolled to 07-07 and whose original daily series had been consumed, and a cell that cannot be re-taken in place is a cell that costs a whole clone to re-run.

**Cell ordering.** Cell S is last because it is the only clock-rolling cell; every other cell runs at the pinned date so nothing it measures can be a spawn artifact.
