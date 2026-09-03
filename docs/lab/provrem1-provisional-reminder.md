# PROVREM1 — the provisional occurrence of an after-completion series: clearing its reminder, and moving it out of Today

**Version stamp:** `things-lab-golden-v4` · Things **3.23** (CFBundleVersion **32300036**, direct-download channel) · macOS **15.7.7 (24G720)** · `Meta.databaseVersion` **27** · airgapped clone, guest clock pinned **2026-07-05 12:00 (a Sunday)** and rolled ONCE to **2026-07-08** (the 2026-07-18 trial wall is never approached) · AXVM1 accessibility grant baked · both #597 lab escapes exported. Campaign run 2026-09-03, unattended, over **two** disposable clones — one per arm, one at a time. Immutable snapshot per the [harness](harness.md) version-stamping policy.

Driver: [`lab/scripts/research-provrem1.sh`](../../lab/scripts/research-provrem1.sh) (`ARM=pre` against the shipped 0.20.8 build, `ARM=post` against the fixed build; `REUSE_IP=` attaches to an already-booted clone). Fixtures fully synthetic (`PROVREM1-*`). Artifacts: `lab/artifacts/provrem1-lab-{pre,post}/` (gitignored) — `report.txt`, per-gesture full-row snapshots in `snap/`, per-command CLI output, AX censuses in `ax/`.

**DB oracle:** every gesture is bracketed by a **full-row snapshot** of every `TMTask` column of every fixture row (`rowsnap.py` → `uuid⇥column⇥value`, packed dates and `reminderTime` decoded, blobs hashed), diffed field by field. "No field changed on any surviving row" means all 41 columns of all 9 rows, not a spot check. Beep sentinel armed per drive (report-only per [BEEPSEN1](beepsen1-beep-sentinel.md)).

Occasioned by [#699](https://github.com/mikegreiling/things-api/issues/699) — a field report from the maintainer's M1 (Things 3.23.3, CLI 0.20.7-dev): four commands aimed at one repeating occurrence, three refusals whose copy did not describe the situation, and a landed write reported as a failure.

Predecessors: [banner1-research](banner1-research.md) (L1/L2/L4 — what a provisional Today member IS), [sit3-arrival-evening-lists](sit3-arrival-evening-lists.md) BANNERACK (the `when=today` no-op, on 3.22.11, without a reminder), [remrev-stale-reminder-reschedule](remrev-stale-reminder-reschedule.md) RR-SF-TODAY (the same no-op on a stale `start=1` row, which still cleared the reminder), [cncac1](cncac1-after-completion-checkoff.md) §7.1/§9 + [acfut1](acfut1-after-completion-future-anchor.md) (the after-completion cursor, and the fabricated anchor a future-dated promote writes), [repx1](repx1-instance-semantics.md) §3 (an instance re-date takes no chooser, on five vectors).

**Result: every cell answered. Three shipped defects, all on OUR side; one unmeasured branch of the app closed; the app itself did nothing wrong in any cell.**

---

## 0. Headline

1. **`start=someday` + `today=true` is not a contradiction — it is the app's own representation of an unacknowledged Today member, and #699's verifier was reading it correctly and judging it wrongly.** The spawned occurrence is born `start=2` with an arrived `startDate` ([banner1](banner1-research.md) L2(c)); the read model reports it `stage: anytime` / `when: today` / `provisional: true`, byte-for-byte what the field report saw (§2).
2. **`when=today` on such a row is a schedule NO-OP that still clears the reminder.** Cell X4's row delta is exactly two columns — `reminderTime` 12:00 → NULL and `userModificationDate` — on all 41 columns of 9 rows. `start` stays 2, `startDate` stays the occurrence day, `todayIndex*` untouched. Our expected delta demanded `start == active`, so the CLI reported `verify-failed:mismatch` for a write that had done precisely what was asked and nothing else (§3).
3. **A bare `when=anytime` DOES clear a live reminder — measured for the first time.** Cell X6: `reminderTime` 12:00 → NULL, `start` 2→1, `startDate` → NULL. `effectiveReminder` had ASSUMED this for every non-schedulable `when` since the vocabulary registry landed, and `H-REMINDER-SCOPE` was refusing the one call that would have exercised it. So the guard was fencing off a branch that works, and sending callers to a two-step whose first step then verify-failed (§4).
4. **The GUI agrees with our write, column for column.** Cells G1/G2 drive the app's own `Items ▸ When… → Anytime` on a provisional row and on the spawned occurrence: `reminderTime` cleared, `start` 2→1, `startDate` NULL, `todayIndexReferenceDate` re-pointed, `umd` bumped — the same delta the URL leg lands (§6). The exception chooser does NOT appear, and the template is byte-untouched: REPX1 §3's law now holds on a sixth vector and on the one row shape REPX1/2/3 never had (§6.2).
5. **The `--exception` refusals were both misdiagnoses, and reproduce verbatim under 3.23.** The occurrence was told the series was *"no longer a repeating series"* with *"retry"* as the remedy — it is an occurrence of a live series, and an occurrence IS the exception. The template was told, truthfully, that it has no next date, and then sent to *"one of its occurrences"* without naming one — which is the command that had just refused (§5).
6. **`when=evening` is NOT a no-op on the same row shape** (X7): the app applies it in full (`start 2→1`, `startBucket 0→1`, reminder cleared). The short-circuit is specific to a `when` the row already satisfies, not to provisional rows (§4.2).
7. **A bonus confirmation the fixture had to earn:** the after-completion fabricated anchor law generalizes past ACFUT1's single measured point — at interval 2 and with a deadline offset, `acRef := due − interval` and `next := acRef + interval + ts` both land on the byte (§1).
8. **Rig findings worth carrying forward.** An unauthorized URL write raises a MODAL sheet that then swallows every later gesture, and a blocked app looks exactly like an app that declined: the pre arm's URL and GUI cells all reported clean empty deltas while driving nothing (§7.1). The URL token lives in `TMSettings.uriSchemeAuthenticationToken`, not in the app's defaults (§7.1). And a teardown trap armed AFTER the boot wait leaves a 50 GB clone running when the boot is slow (§7.2).

---

## 1. The fixture: #699's shape, built by the shipped CLI

The field's series is `after-completion / weekly / interval 2 / startOffsetDays −6`, deadlined, with a 12:00 reminder, and its current occurrence was spawned by the app at midnight (`created 2026-09-03T05:00:00Z` = local midnight — the clock-arrival birth stamp, [repx1](repx1-instance-semantics.md) §2.4/RD-28(c)). Reproducing that needs a series with a real cursor and NO instance, then a clock roll:

```
things todo add-repeating 'PROVREM1-P' --after-completion --frequency weekly \
  --interval 2 --when 2026-07-08 --start-days-earlier 6 --reminder 12:00 \
  --dangerously-drive-gui
```

At rest on the 07-05 clock (both arms, both fixtures, identical):

```
tp=1 fu=256 fa=2 ts=-6 rc=0 of=[] next=2026-07-08 icStart=2026-07-06 icCount=0
paused=0 acRef=2026-06-30 start=2 sd=None sb=0 rem=12:00 tIdxRef=2026-07-08 deadline=4001-01-01
```

— the cursor at the requested date verbatim, `icCount=0`, **zero instances**, the deadline sentinel from `ts=-6`, and the 12:00 reminder **on the template** (so every spawn inherits it — [RD-26](../reference/assumption-register.md)).

The fabricated anchor is worth its own line, because it settles a generalization [acfut1](acfut1-after-completion-future-anchor.md) §1.1 explicitly left inferred (`acRef := requested − interval`, measured at interval 1 weekly only). Here, at interval **2** and with a deadline offset, `acRef` = **2026-06-30** — which is requested − 8 days, neither one week nor one interval. It is exactly right once [cncac1](cncac1-after-completion-checkoff.md) §9.2's deadline geometry is applied, because a deadlined rule's interval lands on the DUE date, not the start:

```
requested start 2026-07-08  ⇒  its due date = start − ts = 07-08 + 6 = 2026-07-14
acRef := due − interval     =  07-14 − 14d   = 2026-06-30   ✓ (measured)
next  := acRef + interval + ts = 06-30 + 14d − 6 = 2026-07-08   ✓ (measured, = the requested start)
```

So ACFUT1's law holds at interval 2, and holds on a deadlined rule when read against the due date. Both arms landed the same anchor.

Rolling the clock to 2026-07-08 and relaunching spawns the occurrence:

```
INSERTED (spawn)  start=2  sd=2026-07-08  sb=0  rem=12:00  tIdxRef=2026-07-08  deadline=2026-07-14
                  rt1_repeatingTemplate=<template>  rt1_instanceCreationCount=0
CHANGED template.rt1_instanceCreationCount     : 0 -> 1
CHANGED template.rt1_instanceCreationStartDate : 2026-07-06 -> 2026-07-09
CHANGED template.rt1_afterCompletionReferenceDate : 2026-06-30 -> None
CHANGED template.rt1_nextInstanceStartDate     : 2026-07-08 -> None
CHANGED template.todayIndexReferenceDate       : 2026-07-08 -> None
```

The fabricated anchor is CONSUMED and the cursor cleared ([acfut1](acfut1-after-completion-future-anchor.md) §2.1) — which is exactly why `--exception` on the template has nothing to bring forward (§5.2).

Five plain controls (`PROVREM1-S1..S5`, `todo add --when 2026-07-08 --reminder 12:00`) carry the SAME provisional shape without the repeat FK — [banner1](banner1-research.md) class (b) rather than class (c) — so every law below is separable from the repeat machinery.

## 2. What the occurrence reads as (cell B)

`things todo show <occurrence> --json`, on the spawned row, both arms:

```json
{"uuid":"…","title":"PROVREM1-P","status":"open","startDate":"2026-07-08","deadline":"2026-07-14",
 "reminder":"12:00","created":"2026-07-08T00:00:00.000Z","instanceOf":"…",
 "repeats":{"rule":{"type":"after-completion","unit":"weekly","interval":2,"startOffsetDays":-6,…}},
 "stage":"anytime","when":"today","provisional":true}
```

Identical in every field to #699's step 1 (the field's rule additionally carries `offsets:[{weekday:4}]`, which its GUI-built series has and a CLI-built one does not — immaterial: every cell below reproduces without it). `things today --json` lists it with `provisional: true` alongside the four seeded `LAB-REPEAT-DAILY` instances and the S-controls — 7 of the 20 Today rows are provisional, which is the golden's ordinary state.

**So the read side was never in question.** `start=someday` + `today=true` is [today-placement](../../src/model/today-placement.ts)'s arrived-Today-member law meeting [banner1](banner1-research.md) L1's unmaterialized predicate, and the wire says so in one word.

## 3. Cell X4 — the remediation the CLI printed, and what the app did with it

`things todo update <occurrence> --when today --clear-reminder`

**PRE arm** (shipped 0.20.8) — #699 step 5, reproduced byte-for-byte, exit **3**:

```json
{"code":"verify-failed:mismatch","detail":{
  "expected":{"assert":[{"field":"start","equals":"active"},
                        {"field":"startDate","satisfies":{"predicate":"arrived-on-or-before","date":"2026-07-08"}},
                        {"field":"today","equals":true},{"field":"evening","equals":null},
                        {"field":"reminder","equals":null}]},
  "observed":{"start":"someday","startDate":"2026-07-08","today":true,"evening":null,"reminder":null}}}
```

**The row delta for that same command — the whole app-side answer:**

```
CHANGED <occ>.reminderTime         : 805306368(12:00) -> None
CHANGED <occ>.userModificationDate : None -> 1783512039.197902
(rows in both: 9; fields compared: 369)
```

Two columns. `start` 2, `startDate` 2026-07-08, `startBucket` 0, `todayIndex` −910, `todayIndexReferenceDate` 2026-07-08 — all unchanged; the template and the other eight rows byte-identical. The write did exactly what was asked (the reminder is gone, the occurrence is still in Today) and the verifier called it a contradiction.

This is [BANNERACK](sit3-arrival-evening-lists.md)'s no-op, first measured on 3.22.11 on a row with no reminder, now measured on 3.23 **on a repeating occurrence carrying one** — and with the reminder half of [REMREV](remrev-stale-reminder-reschedule.md) RR-SF-TODAY attached: the schedule is declined, the reminder is cleared, `umd` is bumped. Confirmed on the raw URL surface with no CLI in the path (cell U1, post arm, real auth token):

```
open -g things:///update?id=<S1>&auth-token=<token>&when=today
CHANGED <S1>.reminderTime: 805306368(12:00) -> None
CHANGED <S1>.userModificationDate: … 
```

**POST arm** (fixed build), same command, exit **0**:

```json
{"ok":true,"kind":"mutation-result","data":{"op":"todo.update","observed":
 {"start":"someday","startDate":"2026-07-08","today":true,"evening":null,"reminder":null},
 "vector":"url-scheme","tier":0,"undoToken":"m-96d1d8975da8"}}
```

with the row delta unchanged from the pre arm (`reminderTime` + `umd`). The fix is on the assertion, not the write: `start` is asserted as one of the two states an arrived Today member can hold, so the same landed bytes now verify.

## 4. Cell X6 — does a bare `when=anytime` clear a reminder?

Nothing in the corpus had ever sent `when=anytime` (or `someday`) to a row with a non-NULL `reminderTime`: BANNERACK's anytime arm had no reminder, REM1's was a template, the reordgaps bounces were NULL-byte fixtures. Meanwhile `effectiveReminder` returns `null` for every non-schedulable `when` and the reminder assertion then DEMANDS `reminderTime IS NULL` — an assumption the shipped code has carried from the start — while `H-REMINDER-SCOPE` refused the one call a caller would use to find out.

`things todo update <S4> --when anytime` — S4 still provisional, reminder 12:00 live. Both arms, exit **0**, verified:

```
CHANGED <S4>.reminderTime            : 805306368(12:00) -> None
CHANGED <S4>.start                   : 2 -> 1
CHANGED <S4>.startDate               : 132805632(2026-07-08) -> None
CHANGED <S4>.todayIndexReferenceDate : 132805632(2026-07-08) -> None
CHANGED <S4>.userModificationDate    : … 
```

**The assumption was right, and is now measured.** Independently on the raw URL surface (cell U2, post arm): the same five columns, same values. A reminder cannot outlive the date it hangs on, and the app does not leave one stranded.

Two consequences, both shipped in this batch: `--when anytime --clear-reminder` is one call (the guard no longer refuses it), and the `anytime` reminder assertion is no longer a guess.

### 4.2 Cell X7 — the evening leg, for the same reason

`--when evening --clear-reminder` on provisional S3, exit **0**, and the app applies the whole write:

```
CHANGED <S3>.reminderTime            : 805306368(12:00) -> None
CHANGED <S3>.start                   : 2 -> 1
CHANGED <S3>.startBucket             : 0 -> 1
CHANGED <S3>.todayIndex              : -3583 -> 660
CHANGED <S3>.todayIndexReferenceDate : 132805632(2026-07-08) -> 132804992(2026-07-03)
```

So the short-circuit in §3 is not "the app declines writes to provisional rows" — it is "the app declines a bucket write the row already satisfies". `evening` is a different bucket, so it lands, materializing the row on the way (`start 2→1`). Note the `todayIndexReferenceDate` move to **2026-07-03**: entering the evening sub-bucket re-ranks the row into an existing cohort rather than today's ([banner1](banner1-research.md) L5's cohort machinery; not load-bearing here, recorded so a future byte-diff is not surprised).

Cell U3 (`when=evening` by raw URL) is **VOID as an independent measurement**: its target was S3, which X7 had already moved to the evening bucket, so the empty delta is a same-value no-op and nothing more.

## 5. Cell X1/X2 — the two `--exception` refusals

### 5.1 Aimed at the occurrence

**PRE** (exit 4), #699 step 2 verbatim:

```json
{"code":"blocked:environment","message":"this to-do is no longer a repeating series","remediation":"retry"}
```

The row is an occurrence of a live series (`rt1_repeatingTemplate` set, template intact). The branch's copy was written for the STATUS composite, whose caller has already established the target is a template — there, "no longer" and "retry" describe a real race. `update --exception` takes whatever uuid the user typed, so the one shape it actually meets is the series' own occurrence.

**POST** (exit 4):

```json
{"message":"this to-do IS one occurrence of a repeating series — an exception is what it already is,
  so there is nothing to carve out of the rule (the series is MZkm9jMt8KVksrQJSpEH5f)",
 "remediation":"change this occurrence on its own: `things todo update T5VVLX2N… …` with no --exception
  — the series and every other occurrence stay as they are"}
```

That remediation is [repx1](repx1-instance-semantics.md) §3.1's measurement, restated as a command: an occurrence re-date moves that row and leaves the template byte-untouched. Re-confirmed here twice over — X4/X5 on the occurrence leave the template byte-identical, and so does the GUI gesture in §6.2.

### 5.2 Aimed at the template

**PRE** (exit 4), #699 step 3 verbatim:

```json
{"message":"this repeating to-do has no upcoming occurrence to work on — its schedule names no next date,
  so there is nothing to bring forward","remediation":"work on one of its occurrences directly"}
```

The detail is TRUE: an after-completion series' cursor exists only between resolutions, and §1's spawn consumed it. The remediation is the circle — it names no occurrence, and the occurrence command had just refused.

**POST** (exit 4):

```json
{"message":"this repeating series has no occurrence left to create — the 2026-07-08 occurrence is already
  here and unfinished, and this series counts from each completion, so its next date only exists once
  that one is resolved",
 "remediation":"change that occurrence on its own: `things todo update T5VVLX2N… …` with no --exception
  — the series and its schedule stay as they are"}
```

The series is holding exactly one open copy and the composite already reads it (`readSeriesState.openInstance`, which the STATUS composite has always preferred). Naming it is what turns the remediation into something runnable.

### 5.3 And the third refusal is gone

`things todo update <occurrence> --when anytime --clear-reminder --dry-run` — #699 step 4 — was `blocked:H-REMINDER-SCOPE`. **POST**, exit **0**, a plan:

```json
{"kind":"mutation-plan","data":{"invocation":"things:///update?id=T5VVLX2N…&when=anytime&auth-token=REDACTED",
 "expectedDelta":{"assert":[{"field":"start","equals":"active"},{"field":"startDate","equals":null},
                            {"field":"reminder","equals":null}]},
 "hazardsChecked":["H-UNKNOWN-DESTINATION","H-REPEAT-SCHEDULE","H-REMINDER-SCOPE"]}}
```

Every dry-run cell left all 369 snapshot fields unchanged, in both arms.

## 6. Cells G1/G2 — the GUI oracle

The app's own gesture for "move this out of Today": select the row, `Items ▸ When…`, resolve `Anytime` in the natural-language picker, commit. The picker is a DETACHED window (`WhenPopUpDialog-<uuid>`, 341×396), not a sheet; the phrase `anytime` resolves to a row described `Source Anytime DarkSelected`, read back before committing per [repx2](repx2-exception-chooser.md)'s never-commit-blind rule.

### 6.1 On a plain provisional row (G1)

```
CHANGED <S5>.reminderTime            : 805306368(12:00) -> None
CHANGED <S5>.start                   : 2 -> 1
CHANGED <S5>.startDate               : 132805632(2026-07-08) -> None
CHANGED <S5>.todayIndexReferenceDate : 132805632(2026-07-08) -> None
CHANGED <S5>.userModificationDate    : … 
```

**The same five columns, with the same values, as our URL leg** (§4, cell X6 — a different fixture of the same shape). The app's own Anytime gesture clears the reminder too, so nothing about our write is an approximation of the GUI: it IS the GUI's delta.

### 6.2 On the spawned after-completion occurrence (G2)

```
CHANGED <occQ>.reminderTime            : 805306368(12:00) -> None
CHANGED <occQ>.start                   : 2 -> 1
CHANGED <occQ>.startDate               : 132805632(2026-07-08) -> None
CHANGED <occQ>.todayIndexReferenceDate : 132805632(2026-07-08) -> 132806400(2026-07-14)
CHANGED <occQ>.userModificationDate    : None -> …
(rows in both: 9; fields compared: 369)
```

Three facts, each from that diff:

- **No chooser.** The AX census after the commit shows one container, the menu-bar strip; no `AXSheet`, no `Make Exception` / `Update Rule`. [repx1](repx1-instance-semantics.md) §3 found the same on five vectors against a materialized instance; this is the sixth, and the first on a PROVISIONAL after-completion occurrence. The chooser needs a projection row, a projection row needs a cursor, and this series has neither ([repx2](repx2-exception-chooser.md) §0, [cncac1](cncac1-after-completion-checkoff.md) §7.1) — so "make an exception for this occurrence" is not a question the app asks here, because the occurrence is already the only thing there is.
- **The template is byte-untouched**, including its own 12:00 rule reminder: `next=None icStart=2026-07-09 icCount=1 acRef=None rem=12:00 deadline=4001-01-01`, identical before and after. The user's stated requirement in #699 — "the template, its cadence, its future dates and its future reminders must remain unchanged" — is what the app itself does on this gesture.
- **`todayIndexReferenceDate` follows the DEADLINE** (2026-07-14) rather than clearing, because the now-undated row still has a due deadline and re-ranks into that cohort ([banner1](banner1-research.md) Q4's deadline-cohort law). Our own X5 write produced the same value, so the two agree here too.

### 6.3 One beep per GUI cell — and it is ours

Both GUI cells recorded one alert beep (report-only). The driver's picker helper sends `⌘A` to select the field's contents before typing, and `⌘A` with no enabled Select All is precisely [BEEP1](beep1-numeric-field-beep.md)'s measured beep signature. It is a rig artifact of this campaign's own drive, not app behavior, and not a finding about the When picker. (Recorded rather than filtered: probes are exempt from failing on beeps, never from accounting for them.)

## 7. Rig findings

### 7.1 An unauthorized URL write leaves a modal sheet that silently voids everything after it

The pre arm read the URL-scheme token from `defaults read com.culturedcode.ThingsMac ThingsAuthToken` — which does not exist. Each U cell therefore sent `auth-token=` empty, and the app answered with a modal sheet (*"The URL command you used requires an authentication token to work…"*, one `OK` button). Consequences, in order:

- U1/U2/U3 reported *"no field changed on any surviving row"* — true, and NOT the measurement the cell was written to take.
- Both GUI cells then found every one of the 18 `Items` menu entries `enabled=false` and their menu clicks failed with `-1728`; their row deltas were also empty. **A blocked app is indistinguishable from an app that declined**, and four cells' worth of clean-looking negatives came from a dialog nobody was looking at.

Two fixes, both in the driver: the token comes from `TMSettings.uriSchemeAuthenticationToken` (the column [pipeline.ts](../../src/write/pipeline.ts) itself reads), and every GUI cell now runs a `require_no_sheet` preflight that reports the sheet count, tries to dismiss it, and declares the cell VOID rather than driving into a modal. The post arm's censuses show the difference plainly: `preflight: no sheet open`, and the same menu with `When… enabled=true`.

The generalizable rule, and it is the [DEFAULTS3](defaults3-observer-down.md) quadrant law in another costume: **a cell that can be voided by state an EARLIER cell created must assert its own preconditions.** Ordering was the whole defect — the same cells, run before any URL write, are the ones that answered.

### 7.2 A teardown trap armed after the boot wait is not a teardown trap

The first attempt lost its 6-minute boot to a `lab_wait_for_ssh "$VM" 360` timeout (this host boots a golden-v4 clone in ~6–7 minutes under load) and exited on the FATAL path — with the clone still running, because `trap cleanup EXIT` was installed on the line after. An orphaned `tart run` holding a 50 GB VM on a thin disk is the incident the harness forbids, and the driver's own structure produced it. The trap is now armed immediately after `tart clone`, before the boot; the `tart run` child is owned by the script's shell (not double-forked into `PPID 1`); and the wait is 900 s. This pattern is copied from campaign to campaign — [research-acfut1.sh](../../lab/scripts/research-acfut1.sh) has it too.

## 8. Open cells

1. **The anchor law at other intervals and units.** §1 confirms `acRef := due − interval` at interval 2, weekly, deadlined — one point beyond ACFUT1's interval-1 measurement, with the deadline geometry folded in. Monthly/yearly units and interval 3+ are still arithmetic nobody has watched.
2. **`when=evening` at a row ALREADY in the evening sub-bucket.** §4.2 measured the flat→evening move (it applies); the same-bucket corner is the one shape that would short-circuit if any evening write does, and it is the corner our relaxed assertion covers without evidence.
3. **`when=someday` with a reminder present.** Still unmeasured (`H-REMINDER-SCOPE` still refuses `--clear-reminder` there, on purpose). The someday bucket carries no date either, so the expectation is the anytime result — expectation, not measurement.
4. **Clearing a reminder in the GUI.** The oracle here is the Anytime gesture (which clears it as a side effect) and the URL surface (R07). The When picker's own `Add Reminder` row was censused but never driven, so "what the GUI does when a user removes just the reminder" is still inferred from the URL leg.
5. **Sync.** Single-device, as always. A provisional row's `start` byte is exactly the kind of state two devices can materialize independently ([banner1](banner1-research.md) L3 models it as sync-stable column state; [timezones](../reference/timezones.md) §8 is the open merge question).
