# REM1 — hunting a doctrine-clean workaround for the repeat-reminder gate

**Verdict (2026-07-16): NO WORKAROUND — the gate stands.** Both candidate workarounds for the reminder-time defect (oddities §8l / UIC6-g) were probed end-to-end and BOTH FAIL; the quiet path is independently confirmed closed. `--reminder` on the repeat ops remains refused fail-closed in `assertRepeatRule` — this is the correct behavior, now with three fresh negatives so no one re-treads it. Ran in TWO sequential disposable `--vnc-experimental` clones named `rem1-lab` (one at a time; golden untouched), airgapped, clock pinned 2026-07-05 12:00, Things 3.22.11 / macOS 15.7.7 / DB v26, Accessibility granted via the AXVM1 rung-b VNC toggle, everything else over SSH; ground truth = guest Things-DB row deltas (read-only SQLite; `reminderTime` decoded as `hour<<26 | minute<<20`, and the whole `rt1_recurrenceRule` plist dumped key-by-key) driven through the **production CLI** (`todo make-repeating --dangerously-drive-gui`) for REM1-a and a bespoke AX/HID driver for REM1-b. Branch `mg/rem1-reminder-workaround`. Scripts: [`lab/scripts/research-rem1.sh`](../../lab/scripts/research-rem1.sh) (a + c), [`lab/scripts/research-rem1b.sh`](../../lab/scripts/research-rem1b.sh) (b, fixed re-run).

The defect being worked around (UIC6-g, oddities §8l): the Repeat dialog's reminder-time `AXDateTimeArea` reports `AXValueSettable=true` and accepts an `AXValue` write (read-back confirms the value), yet Things COMMITS ITS DEFAULT (12:00) instead. System-Events `set value`, ObjC `AXValue` set, ObjC focus+Tab, and whole-control HID keystrokes were all already shown to fail; `--reminder` is refused rather than write a wrong time. The end-date picker (same `AXDateTimeArea` role, same dialog) honors writes — so it is a per-control app defect.

## Executed verdicts (2026-07-16)

| Probe | What | Verdict | DB evidence |
|---|---|---|---|
| **REM1-a** inheritance seeding | seed a plain to-do that ALREADY has a 09:00 reminder (quiet URL `add?when=2026-07-20@09:00`), then drive `make-repeating` WITHOUT touching the reminder picker — does the new template/instance INHERIT the reminder? | **FAIL** | seed `reminderTime=603979776` (09:00 exact) ✓; after make-repeating the template's rule has NO time key (`RULEKEYS{ ed, fa=1, fu=16, ia, of=[{dy:0}], rc=0, rrv=4, sr, tp=0, ts=0 }`, `reminderTime=NULL`) and the spawned instance's `reminderTime=NULL`. The reminder is DROPPED by the make-repeating identity replacement. |
| **REM1-b** HID sub-field entry | tick "Add reminders", resolve the reminder `AXDateTimeArea` frame, HID-click the HOUR segment (left of the resolved frame), type absolute digits (07:00), OK | **FAIL (3/3)** | across 3 runs the control's `AXValue` stayed `2026-07-05 00:00:00` through the segment click AND both digit-type phases — the keystrokes never registered — and OK committed the DEFAULT `reminderTime=805306368` (12:00) every time, never the typed `469762048` (07:00). |
| **REM1-c** quiet-path closure | is there a quiet (non-GUI) reminder-set path on a repeating TEMPLATE? | **CLOSED (confirmed)** | keyword `update?id=<template>&when=someday` is a silent no-op (`start/startDate/reminderTime` = `2/NULL/NULL` before AND after — matches §8k). The ONLY URL reminder spelling is `when=<schedule>@<time>`, and a TIMED `when=` on a repeating template is the §1 / §7-C1 CRASH — so no quiet reminder-set exists for a template regardless (cited, NOT re-fired). |

**Net:** the reminder time cannot be set headlessly for a repeat by ANY probed route — not by inheriting a pre-set reminder (a: the dialog opens with "Add reminders" unchecked and the reminder is lost on the identity replacement), not by driving the picker sub-field with HID keystrokes (b: they don't register; the picker commits its default), and not by any quiet vector after the fact (c: no-op or crash). The `assertRepeatRule` refusal is correct.

## REM1-a — inheritance seeding (FAIL)

Hypothesis: if the source to-do already carries a reminder, the Repeat dialog might pre-check "Add reminders" and pre-fill the time — so the recipe would never touch the broken picker; OK would commit the inherited value.

- **Seed (quiet URL, verified):** `open "things:///add?title=REM1-A&when=2026-07-20@09:00"`. A DATED schedule parses the time as a 24-hour literal (no am/pm heuristic, oddity 2d / R19) and `09` is zero-padded, so the reminder lands EXACTLY: `reminderTime=603979776` = 09:00, `startDate=132807168` (2026-07-20). A control to-do `REM1-A0` seeded `when=2026-07-20` (no time) confirmed `reminderTime=NULL`.
- **Drive:** `todo make-repeating <REM1-A> --frequency daily --interval 1 --dangerously-drive-gui` — NO `--reminder` flag, so the recipe drives only frequency → interval → OK and never touches the reminder controls. Returned `"ok":true`, original uuid gone (identity replacement, as expected).
- **Result:** the new template's decoded rule carries NO reminder/time key (only the ordinary `fu=16` daily, `of=[{dy:0}]`, `tp=0`), the template's `reminderTime` column is NULL, and the spawned instance's `reminderTime` is NULL. **The 09:00 reminder was not inherited — it was dropped.**

So the dialog does NOT seed "Add reminders" from the source item; making a to-do repeat discards its reminder. Inheritance seeding cannot un-gate make-repeating-with-reminder.

## REM1-b — HID sub-field digit entry (FAIL, 3/3)

The reminder control is a segmented NSDatePicker-style `AXDateTimeArea` (resolved frame `{x:322,y:338,w:94,h:21}`). This probe targets the HOUR segment specifically (a different code path than the failed whole-control `AXValue` set): resolve the frame, HID-click the left ~12% of it (the hour segment, derived from the AX-resolved frame — no guessed pixel), then post absolute digit keystrokes (`07`, Tab, `00`) via `CGEventPost(kCGHIDEventTap, …)`. Target 07:00 (`469762048`) was chosen distinct from the 12:00 default so a commit of 07:00 would be unambiguous evidence the keystrokes stuck.

Instrumented to read the control's `AXValue` at each phase:

```
INIT        2026-07-05 00:00:00 +0000
AFTER-CLICK 2026-07-05 00:00:00 +0000     ← hour-segment click landed, value unchanged
AFTER-HOUR  2026-07-05 00:00:00 +0000     ← typed "07", value UNCHANGED
AFTER-MIN   2026-07-05 00:00:00 +0000     ← Tab + typed "00", value UNCHANGED
→ committed reminderTime = 805306368 (12:00, the picker DEFAULT)
```

Identical across REM1-B1/B2/B3. The HID digit keystrokes never register in the control (its `AXValue` never moves off midnight), and OK commits the picker's default 12:00 — not the requested 07:00. This reproduces the §8l "HID keystrokes into the sub-field fail" finding with the more careful segment-targeted click and confirms it 3×.

Note on doctrine: absolute digit entry is the ONLY doctrine-clean primitive available here. Arrow-key-from-default (down N times from the initial value) is deterministic in keystroke count but depends on the picker's INITIAL value being the current wall clock — a non-deterministic, timing-dependent seed — so it is out of scope regardless of whether it would actuate.

## REM1-c — the quiet path is closed (confirmed)

To be sure the workaround must be GUI-side, re-confirmed there is no quiet (URL) reminder-set on a repeating template:

- A keyword `update?id=<template>&when=someday` is a **silent no-op** on a repeating template (start bucket `2/NULL/NULL` unchanged before and after) — matching UIC4 / oddities §8k (templates resist quiet-vector schedule edits).
- The ONLY URL spelling that carries a reminder is `when=<schedule>@<time>`, and a timed `when=` on a repeating to-do/project is the §1 (U12/R09) / §7-C1 **CRASH** (SIGTRAP). It was NOT re-fired here — the crash is already exhaustively documented and re-firing it only disrupts the session — but it means no quiet reminder-set exists for a repeating template either way.

## What this closes

- `--reminder` on all four repeat ops stays refused fail-closed (`src/write/repeat-rule.ts` `assertRepeatRule`). No code changed — the refusal is correct and now carries three fresh negatives.
- The reminder time for a repeating series must be set **in the app** after the series exists (every other rule dimension is drivable — UIC6).
- Recorded in [things-app-oddities.md](../things-app-oddities.md) §8l (workaround verdict appended) so the a/b attempts are not re-treaded.

## Reproduction notes (for the next sitting)

- `reminderTime` packs `hour<<26 | minute<<20`: 07:00 = `469762048`, 09:00 = `603979776`, 12:00 = `805306368`.
- The spawned instance of a template is `TMTask.rt1_repeatingTemplate = <template-uuid>`; the template is the row with `rt1_recurrenceRule IS NOT NULL`. A make-repeating identity replacement hard-deletes the original, so any same-titled rule-null row afterward is the spawned instance.
- VM lifecycle, AXVM1 grant, and the guest e2e bundle ship mirror `research-uic6.sh` exactly. One gotcha this campaign hit: the git WORKTREE must be `npm ci`'d before shipping the bundle (its `node_modules/commander` is not shared with the primary checkout, and the guest CLI needs it).
