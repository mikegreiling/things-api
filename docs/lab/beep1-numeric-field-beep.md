# BEEP1 — the AX numeric-field alert beep: reproduced on 3.23, attributed, and silenced

**Probed under: `things-lab-golden-v4` · Things 3.23 (build 32300036) · DB v27 · macOS 15.7.7 · guest clock pinned 2026-07-05 (never rolled — the trial wall is 2026-07-18).** One disposable clone (`beep1-lab`), destroyed at the end. All fixtures synthetic (`BEEP1-*`). Driver: [`lab/scripts/research-beep1.sh`](../../lab/scripts/research-beep1.sh):

```sh
TART_HOME=/Volumes/Workspace/tart CELLS="O1 O2"          bash lab/scripts/research-beep1.sh   # arm + POSITIVELY validate the oracles
                                    CELLS="R0 R1 R2 R3"  …   KEEP=1 REUSE=1                   # per-field drives of the shipped scripts
                                    CELLS="B1 … B16"     …                                    # the keystroke bisect
                                    CELLS="E1 E2 E3"     …                                    # the app-wide Escape (suspect 6)
                                    CELLS="F1 F2 F3"     …                                    # the frequency pop-up in isolation
                                    CELLS="R0 G1 … G7"   …                                    # per-step attribution on a pre-populated dialog
                                    CELLS="R0 R6"        …                                    # the whole verb through the production CLI, x6
```

**REPRODUCE-FIRST.** The observation (Mike, live host, 2026-08-20) predates Things 3.23's Repeat-dialog redesign, so the campaign's first job was to establish whether the beep exists at all on the current dialog and the current recipes, before any bisecting.

**Verdict: NOT stale. The beep reproduces on 3.23, on every numeric field, deterministically — and there were TWO independent sources, both now closed.**

---

## 0. Summary

| | before | after |
|---|---|---|
| interval field (one drive) | **1 beep** | 0 |
| ends-after count field (one drive) | **1 beep** | 0 |
| start-days-earlier field (one drive) | **1 beep** | 0 |
| `todo reschedule-repeat --frequency weekly --interval 2 --weekdays tuesday` | **3 beeps** (3/3 rounds) | 0 (3/3) |
| `todo reschedule-repeat --frequency daily --interval 5 --ends-after 9` | **4 beeps** (3/3 rounds) | 0 (3/3) |

Every measurement is paired with a quiet control of the same window length; every quiet control read 0.

Two causes:

1. **The `⌘A` select-all keystroke** that opened the numeric-field write loop — in `axSetValueScript` and, since [#589](hxpc1-picker-assert.md), in `axSetGroupNumberScript` too. Things' `Edit ▸ Select All` menu item exists and is **DISABLED** while the Repeat sheet is up; AppKit dispatches ⌘A as a menu key equivalent first, the disabled item swallows it, nothing handles it, macOS beeps. The keystroke was also **redundant** — focusing the field already selects its whole content.
2. **A step landing on the cadence group while it is still being REBUILT after a frequency switch** — a pre-populated (reschedule) dialog only. Silent when the same steps run with any gap between them, which is why per-step measurement found nothing and the end-to-end verb beeped once.

Fixes shipped, both in `src/write/vectors/ui.ts`: the ⌘A keystroke is gone from both numeric primitives, and `axSetGroupNumberScript` now opens with a closed-loop settle on the group's own shape (never a sleep). Nothing in `ui-recipes.ts` was touched.

---

## 1. The oracle (cell O1) — validated POSITIVELY, and it survives the guest mute

No direct NSBeep hook exists (no DTrace under SIP), so the entry listed two candidate oracles. **Both work**, and both were validated against three deliberate `osascript -e beep` calls before any drive was measured.

**Oracle (a) — the unified log.** One line per system-sound play request:

```
systemsoundserverd | com.apple.coreaudio | sss | SSServerImp.cpp:733  -> Incoming Request : actionID 4096
```

| window | matching lines |
|---|---|
| quiet control, muted | **0** |
| 3 deliberate beeps, muted | **3** |
| 3 deliberate beeps, unmuted | **3** |
| quiet control, unmuted | **0** |

**Correction to the entry's suggested predicate:** it proposed `process == "Things3" AND …`, which would have matched **nothing**. The alert is not played by the app — the app asks `systemsoundserverd`, which plays it. The predicate must be subsystem-scoped, not process-scoped. The driver captures deliberately broadly (`process == "coreaudiod" OR subsystem CONTAINS[c] "audio" OR subsystem CONTAINS[c] "coreaudio" OR eventMessage CONTAINS[c] "beep" …`) and picks the 1:1 signature at analysis time, so the oracle is derived from the validation rather than guessed.

**Oracle (b) — `fs_usage` on a named alert sound.** `defaults write -g com.apple.sound.beep.sound /System/Library/Sounds/Submarine.aiff`, then count `open` lines for that path in `sudo fs_usage -w -f filesys`. Same score: 0 / 3 / 3 / 0. It is the independent second witness, and every count in this document was produced by both oracles in the same capture window; **they never disagreed on any cell.**

**The load-bearing detail for anyone reusing this: MUTING THE GUEST DOES NOT BLIND EITHER ORACLE.** `lab_wait_for_ssh` mutes every clone on boot (`lab_mute_guest`, so an unattended VM cannot beep through the host's speakers at 3am), and a muted guest still logs the full play request — with `SSServerImp.cpp:774 Device is currently muted` alongside it — and still opens the sound file. So beep probing needs no unmuted VM. The unmuted arms above exist only to prove that.

Cell O2 records the guest's audio hardware for the record: a headless Tart guest does have a real output device (`Apple Virtual Sound Device`, 2 channels, 48 kHz, default output), which is why the pipeline runs at all.

---

## 2. Reproduction (cells R1–R3, R6) — the beep is live on 3.23

Each numeric field was driven by **the shipped script text read straight out of `dist/`** (never a paraphrase), against a real 3.23 Repeat dialog, with the oracles armed:

| cell | field | primitive | quiet | drive |
|---|---|---|---|---|
| R1 | interval | `axSetGroupNumberScript(…, "interval")` | 0 | **1** |
| R2 | ends-after count | `axSetGroupNumberScript(…, "ends-count")` | 0 | **1** |
| R3 | start-days-earlier | `axSetValueScript("text field 1 of sheet 1 …")` | 0 | **1** |

Each returned `OK` — the value landed on the FIRST attempt, so the beep is not a retry artifact.

End to end through the production CLI (`--dangerously-drive-gui`), three rounds each, alternating the frequency so the dialog shape changes:

| verb | beeps |
|---|---|
| `reschedule-repeat --frequency weekly --interval 2 --weekdays tuesday` | 3 · 3 · 3 |
| `reschedule-repeat --frequency daily --interval 5 --ends-after 9` | 4 · 4 · 4 |

All six drives reported `ok:true` and drove 10 steps. The counts exceed the per-field tally because a frequency switch adds the second source (§5).

---

## 3. The bisect (cells B1–B16) — it is ⌘A, and only ⌘A

One keystroke removed at a time, each variant against its own fresh weekly dialog, interval field throughout:

| cell | gesture | beeps | field after |
|---|---|---|---|
| B1 | focus only | 0 | 1 (unchanged) |
| B2 | focus + **⌘A** | **1** | 1 |
| B3 | focus + **⌘A** + type | **1** | 3 |
| B4 | focus + Tab | 0 | 1 |
| B5 | focus + type | 0 | **3** |
| B6 | focus + `set value of tf to ""` + type + Tab | 0 | 3 |
| B7 | first responder VERIFIED (polled `focused of tf`) + **⌘A** + type + Tab | **1** | 3 (`fr=yes`) |
| B8 | focus + **1.5 s settle** + **⌘A** | **1** | 1 |
| B9 | focus + type `"12"` + Tab | 0 | **12** |
| B10 | focus + type `"12"` + Tab, then focus + type `"3"` + Tab | 0 | **12 → 3** |
| B12 | focus + explicit `AXSelectedTextRange` select-all + type + Tab | 0 | 3 |
| B14 | focus + type + Tab on the **ends-count** field | 0 | **7** |
| B15 | focus + type + Tab on the **start-days-earlier** field | 0 | **4** |

**Tab is innocent** (B4) — suspect (2) is falsified. **The digits are innocent** (B5, B9). **⌘A is the whole beep** (B2 isolates it with nothing else in the window).

### 3.1 The mechanism is menu dispatch, NOT the focus race the entry assumed

The entry's ranked suspect (1) was "⌘A arriving before the field editor is first responder, so Select All falls through to the sheet unhandled". The first half is right, the mechanism is wrong, and the difference matters because the proposed remedy (settle harder before sending ⌘A) does not work:

- **B7** polls `focused of tf` until it reports true, THEN sends ⌘A — still 1 beep.
- **B8** waits a full 1.5 s after focusing — still 1 beep.
- **B11 census** (the smoking gun): while the Repeat sheet is up, walking the menu bar for `Select All` returns

  ```
  Edit > Select All enabled=false
  ```

Things publishes an `Edit ▸ Select All` item and DISABLES it for the sheet. AppKit gives menu key equivalents first refusal on a key event; a disabled item still claims ⌘A and swallows it, so the field editor never sees the keystroke and `NSBeep()` follows. No amount of settling changes that — the keystroke can never reach the field. (This is ordinary AppKit behavior, not a Things defect: **nothing here belongs in [things-app-oddities](../things-app-oddities.md).** The bug was ours, for sending a keystroke the app had declared it would not accept.)

### 3.2 …and ⌘A was redundant anyway

`set focused of tf to true` installs the field editor with the **entire content already selected**, so typing replaces the old value without any select-all. Measured directly (cells B13/B16, reading `AXSelectedTextRange` around the focus):

| field content | selection before focus | selection after focus |
|---|---|---|
| `"1"` (1 char) | `loc1/len0` (caret, nothing selected) | **`loc1/len1`** (all of it) |
| `"12"` (2 chars) | — | **`loc1/len2`** (all of it) |

and behaviorally confirmed on the case a stale caret would corrupt: **B10 shrinks `12` to `3`** with no select-all and lands `3`, not `123`. B9 grows `1` to `12`. B14/B15 repeat it on the other two fields.

Two other candidate replacements also measured silent-and-correct — `set value of tf to ""` first (B6) and an explicit `AXSelectedTextRange` select-all (B12) — but neither is independently *proven* to do anything, since focus-select alone already covers the case. Per the alpha-contract convention (delete rather than add), the fix is the removal: **no select-all step at all.** The closed loop is untouched and remains the authority — a field that somehow did not auto-select would produce a read-back mismatch and a fail-closed `error`, never a silent wrong value.

---

## 4. The other ranked suspects

| suspect | verdict |
|---|---|
| (1) ⌘A before first responder | **CONFIRMED as the culprit, mechanism corrected** — it is a disabled-menu-item key-equivalent swallow, not a focus race (§3.1). |
| (2) Tab with no next key view | **FALSIFIED** — B4 sends Tab alone into the sheet's numeric field: 0 beeps. |
| (3) the number formatter rejecting a keystroke | **No evidence** — every drive landed its value on attempt 1 (`OK`), so no re-type cycle ever ran, and the digits alone are silent (B5/B9). |
| (4) the Move… picker's search-field typing | **Already gone, and doubly covered** — [#589 (HXPC1)](hxpc1-picker-assert.md) replaced the picker's field mechanic with a bare `type-text`. The picker's remaining `set-value` callers inherit the ⌘A removal automatically, since it is the same primitive. `ui-recipes.ts` was not touched by this campaign. |
| (5) `DIALOG_INTERVAL` / `DIALOG_ENDS_COUNT` colliding into a 3× retype storm | **FALSIFIED by HXPC1** before this campaign reached it. The collision was real but produced a silent wrong-field write, never a retype storm. Both fields are now row-discriminated by `axSetGroupNumberScript`, and this campaign drove that new primitive. |
| (6) `clearDialog`'s app-wide Escape with nothing modal open | **FALSIFIED** — cells E1/E2/E3 measure `tell application "System Events" to key code 53` with the Repeat sheet open (dismisses it, 0 beeps), with nothing modal and Things frontmost (0), and with Finder frontmost (0). `axAbortScript` is silent in every state; no change made. |

---

## 5. The SECOND source (cells F1–F3, G1–G7) — the post-frequency-switch re-layout

With ⌘A removed, the three field cells went to 0 — but the full CLI verb still beeped **exactly once**, reproducibly (1 in all six R6 rounds, down from 3 and 4).

Localizing it took the shape of the drive rather than any single step:

| cell | what ran | beeps |
|---|---|---|
| G4 | reveal + activate only | 0 |
| G3 | + `Items ▸ Repeat` press | 0 |
| G2 | + `Edit Rule…` press (dialog opens) | 0 |
| G1 | each dialog step ON ITS OWN, on a pre-populated weekly→daily dialog: shape probe · Add-deadlines checkbox · frequency · interval · ends pop-up · ends count · OK | **0 for every single one** |
| F1 | the shipped `select-popup` switching the frequency, isolated | 0 |
| F2 | the same pop-up driven to the value it already holds | 0 |
| G5 | the SAME six dialog steps **back to back, no gaps** (a weekly→daily switch) | **1** |
| G6 | the same run **without** the frequency switch | 0 |
| G7 | G5 again, with a 1.5 s pause after the frequency switch | 0 |
| F3 | frequency switch + interval, back to back, on a FRESH (create-path) dialog | 0 |

So: **a frequency switch REBUILDS the cadence group, and the step that follows it — the interval drive — lands mid-rebuild.** A keystroke arriving at a control that is being torn down is unhandled, and macOS beeps. It only appears on a PRE-POPULATED (reschedule) dialog: the create path's switch happens on an empty dialog and is silent (F3).

This is the entry's suspect (2)/(3) territory arrived at from the other end — not "Tab has no next key view" in a static dialog (falsified in §3), but a keystroke reaching a field that momentarily is not there.

### 5.1 The fix is a settle on the GROUP'S OWN SHAPE, never a clock

A `delay 1.5` would work (G7 proves it) and is exactly what the UI-automation determinism doctrine forbids ([decisions.md](../design/decisions.md), the RRD1 ruling: closed-loop convergence, never a blind timed gesture). `axSetGroupNumberScript` now opens with a closed loop instead: it reads the group's signature — every static text's value plus every text field's y-position — and polls until **two consecutive reads agree**, bounded (40 reads × 0.1 s), failing closed with the last-seen signature if the group never stops moving.

This is not beep-motivated bookkeeping bolted onto a working primitive. #589 addresses the two numeric fields by their **row position**; reading positions off controls that are still moving is a correctness hazard in its own right, and the gate closes both at once. The already-settled case (every drive that does not follow a frequency switch) costs one extra signature read plus one 0.1 s poll.

---

## 6. Verification

Rebuilt, re-shipped to the clone, and re-run with the identical cells:

| | beeps |
|---|---|
| R1 interval · R2 ends-count · R3 start-days-earlier | **0 · 0 · 0** (each returns `OK`, value landed) |
| G1, all seven dialog steps individually | **0** for each |
| G5, all six back to back with the frequency switch | **0** |
| `reschedule-repeat … weekly --weekdays tuesday`, 3 rounds | **0 · 0 · 0** (`ok:true`, 10 steps) |
| `reschedule-repeat … daily --ends-after 9`, 3 rounds | **0 · 0 · 0** (`ok:true`, 10 steps) |

Values still land: every drive reports `ok:true` with the requested rule observed (`repeating.rule.interval: 5`, `repeating.rule.occurrenceCount: 9`).

### 6.1 What this campaign could NOT drive

`todo make-repeating` / `todo add-repeating` (cells R8/R9) refuse in a clone with `blocked:environment` — the Wave A write gate blocks the AppleScript vector for every sshd-descended guest shell, so these promote-via-clone composites never reach the dialog ([harness.md](harness.md) §The UI-vector lab escape, CNC1 §9). **Nothing drove, so their 0 counts are not evidence.** The create path's Repeat-dialog leg is the same `repeatDialogEntry` step list that cells R1–R3 and G1 drove directly, so the coverage is by shared primitive, not by the composite. The fixture in cell R0 is built by a raw AX Repeat-dialog drive for the same reason.

The measurements are guest-side, so they establish that the *system* was asked to play the alert. Whether the maintainer's speakers reproduce it is not in question — that is where the report came from.

---

## 7. What shipped

`src/write/vectors/ui.ts` only:

- **`axSetValueScript`** — the `keystroke "a" using command down` line (and its `delay`) removed. Loop is now focus → type → Tab-commit → read back → bounded retry. The re-focus at the top of each retry re-selects the whole value, so a retry still starts from a clean field.
- **`axSetGroupNumberScript`** — the same removal, plus the cadence-group settle gate described in §5.1.
- Unit coverage in `test/unit/ui-scripts.test.ts` asserts both primitives contain no `using command down` and no `keystroke "a"`, that focus still precedes the typing, and that the settle gate is present and fails closed. No GUI fires — the tests assert generated script text, as the rest of that file does.

`src/write/vectors/ui-recipes.ts` was deliberately not modified.
