# NEXTPOP1 — the deadlined promote on Things 3.23: the `Next:` pop-up lists DUE dates, and the drive was racing its recompute

**Probed under: `things-lab-golden-v4` · Things 3.23 (build 32300036) · DB v27 · macOS 15.7.7 · guest clock pinned 2026-07-05.** One disposable clone (`nextpop1-lab`), destroyed at the end. All fixtures synthetic (`NEXTPOP1-*`). Driver: [`lab/scripts/research-nextpop1.sh`](../../lab/scripts/research-nextpop1.sh):

```sh
TART_HOME=/Volumes/Workspace/tart bash lab/scripts/research-nextpop1.sh census   # START-or-DUE, one input at a time, full shape re-audit after each
                                                             … pre               # the VMRES1 §4.3 regression through the shipped CLI
                                                             … diag  diag2       # anchor → Next: propagation, driven the shipped way
                                                             … diag3 diag4       # the recompute window, and the settle that survives it
                                                             … cert              # the 8 post-fix certification cells
```

Closes [vmres1-residuals](vmres1-residuals.md) §4.3 (`add-repeating --deadline <date>` on a MONTHLY/YEARLY rule fails closed on 3.23) and its two open questions: *does the pop-up enumerate START or DUE dates under a nonzero start-offset*, and *is `More…` closed-loop drivable*.

---

## 1. The census — START or DUE?

VMRES1 could not separate the two because at `startDaysEarlier = 0` they coincide. The census builds a rule with a **real 14-day offset** — start `2026-08-06`, due `2026-08-20` — so a menu of START dates offers Aug **6** and a menu of DUE dates offers Aug **20**. Both are in the future; nothing else distinguishes them.

**Verdict: the menu enumerates the rule's DUE dates.**

```
MENU LISTS the START date 2026-08-06 (Aug 6, 2026): no
MENU LISTS the DUE   date 2026-08-20 (Aug 20, 2026): yes
```

Raw pop-up item lists, read off the settled dialog (`lab/artifacts/nextpop1-lab/ax/next-items-{Y,M}-deadlined.txt`):

**Arm Y — yearly, every Aug 20, start 14 days earlier**

```
[1] Today            [7] Wed, Aug 20, 2031    [13] Thu, Aug 20, 2037
[2] Thu, Aug 20, 2026    [8] Fri, Aug 20, 2032    [14] Fri, Aug 20, 2038
[3] Fri, Aug 20, 2027    [9] Sat, Aug 20, 2033    [15] Sat, Aug 20, 2039
[4] Sun, Aug 20, 2028   [10] Sun, Aug 20, 2034    [16] (separator)
[5] Mon, Aug 20, 2029   [11] Mon, Aug 20, 2035    [17] More…
[6] Tue, Aug 20, 2030   [12] Wed, Aug 20, 2036
```

**Arm M — monthly, every 20th, start 14 days earlier**

```
[1] Today            [7] Sun, Dec 20, 2026    [13] Sun, Jun 20, 2027
[2] Mon, Jul 20, 2026    [8] Wed, Jan 20, 2027    [14] Tue, Jul 20, 2027
[3] Thu, Aug 20, 2026    [9] Sat, Feb 20, 2027    [15] Fri, Aug 20, 2027
[4] Sun, Sep 20, 2026   [10] Sat, Mar 20, 2027    [16] (separator)
[5] Tue, Oct 20, 2026   [11] Tue, Apr 20, 2027    [17] More…
[6] Fri, Nov 20, 2026   [12] Thu, May 20, 2027
```

Every offered date is the **20th** — the deadline — never the 6th. The shape is `Today` + 14 of the rule's own upcoming occurrences + a separator + `More…`, consistent with RDLG2's reading of the control.

**`More…` is drivable, and it is a recursive pager, not a free picker.** Descended once, its submenu holds **102 items**: 100 further occurrences (`Mon, Aug 20, 2040` … `Thu, Aug 20, 2139`), a separator, and another `More…` at `[102]`. So the menu is a paged enumeration of the same DUE-date series, 100 per page, addressable by the existing menu-walk. **The fix does not need it** — the first page already covers `Today` plus 14 occurrences, and a first occurrence beyond that horizon is not a case any promote verb produces — so `More…` stays unopened by the recipes and is recorded here as measured-and-available.

This also re-confirms the RDLG2 law from the other side: the menu is the rule's own occurrences, so an **off-rule** first occurrence remains inexpressible (refused fail-closed), deadlined or not.

---

## 2. Why the drive failed anyway — the recompute is async, and an input inside its window CANCELS it

The census settles the *what*. It does not explain the failure, because a drive that asks for Aug 20 against a menu offering Aug 20 should succeed. The `pre` cell reproduced the VMRES1 §4.3 regression through the shipped CLI and printed the menu it actually saw:

```
select-next-occurrence: this Repeat dialog offers only the rule's own upcoming occurrences
(and today) as the first occurrence, and 2026-08-20 is not one of them — searched 6 level(s)
of the Next: menu, which opened on "Thu, Aug 6, 2026" and led with:
  Today, Thu, Aug 6, 2026, Fri, Aug 6, 2027, Sun, Aug 6, 2028, Mon, Aug 6, 2029
```

The menu was listing **Aug 6** — the *previous* rule's dates, before the day-of-month anchor was absorbed. So the pop-up had not recomputed. Four diagnostic cells characterise that:

| cell | what it drove | `popup2` after the ordinal click | menu head at the end |
|---|---|---|---|
| **diag** | the shipped step order, no interval step | `Aug 6` → **`Aug 20` at t+0.5s** | Aug 20, 2026 / 2027 … |
| **diag2** | same, plus the shipped INTERVAL field drive | `Aug 6` → **`Aug 20` at t+0.5s** | Aug 20, 2026 / 2027 … |
| **diag3** | deadline checkbox pressed **INSIDE** the window | `Aug 6` — **stuck for the full 6 s poll** | **Aug 6**, 2026 / 2027 … |
| **diag4** | checkbox pressed **OUTSIDE** the window | `Aug 6` → **`Aug 20` at t+0.4s** | Aug 20, 2026 / 2027 … |

diag3 is the finding. Twelve consecutive reads at 0.5 s intervals:

```
checkbox pressed · popup2 = Thu, Aug 6, 2026
  t+0.5s … t+6.0s  popup2 = Thu, Aug 6, 2026      (all twelve reads identical)
menu head after the poll: [1] Today  [2] Thu, Aug 6, 2026  [3] Fri, Aug 6, 2027 …
```

**The recompute does not merely lag — it is CANCELLED, permanently.** A calendar-anchor change schedules a ~0.4–0.5 s asynchronous recompute of the `Next:` control (its displayed value *and* the menu behind it); an input that lands inside that window kills the pending recompute, and the pop-up then describes the previous rule indefinitely. Six seconds of polling never recovers it, and neither does opening and escaping the menu.

This is an app defect, recorded as [things-app-oddities](../things-app-oddities.md) §21.

The pre-fix drive lost this race intermittently — which is why the deadlined MONTHLY/YEARLY arms failed while the shorter daily/weekly ones (fewer anchor steps before the deadline controls) did not.

---

## 3. The fix

Three changes, all in the direction of *one meaning per field, one place that converts it*.

**(a) A `settle-occurrences` UI primitive** (`src/write/vectors/{types,ui,ui-recipes}.ts`). A step that polls the `Next:` control until it MOVES (the common case, ~0.4 s) or a bounded budget expires (1200 ms at a 100 ms poll — ~3× the measured recompute; nothing to absorb), inserted between the last calendar-anchor step and anything that follows. It is a wait, not a setter: no click, no keystroke. Per the UI-automation determinism doctrine it is a closed loop on the control's own value, never a sleep.

**(b) One meaning for `next`, one place that shifts it** (`src/write/commands.ts`, `src/write/promote-clone.ts`, `src/write/vectors/simulator.ts`). `next` is the requested first-occurrence **START** — what `--when` means to a caller — in every params bag at every layer. A deadlined rule anchors the dialog on the DEADLINE (YANCH1 #493), so the date the `Next:` control must carry is `next + startDaysEarlier`. That conversion now happens **only** in the compile, where the dialog is: `makeRuleExtras()` is the make/add twin of the existing `reschedRuleExtras()`.

It used to happen upstream too — the promote orchestrators shifted `next` before handing the bag down — so the same field meant a START from a caller and a DUE date from a composite. Everything downstream that shifts (`assessOffRuleFirst` via `assertRepeatRule` in preRead) then shifted a **second** time, and a deadlined monthly promote was refused before it ran, citing a date the caller never asked for:

```
--deadline 2026-08-20 --when 2026-08-06  →  "a first occurrence on 2026-08-20 would not hold"
```

**(c) A leaked flag that broke `--when` outright** (`src/cli/commands/repeat-flags.ts`). `addRepeatingRuleFieldsFromOpts` hand-destructured the fields an add-repeating params bag must not carry and **forgot `next`**. The composite passed `next` straight through to its `todo.add` leg, which since #584 refuses an unknown parameter — so *every* `things todo add-repeating --when <date>` (and the project verb) exited 2 with `params.next: not a parameter of "todo.add"` before creating anything. Replaced with a type-exhaustive `NON_ADD_RULE_FLAGS` map keyed on `Exclude<keyof RepeatRuleFlagFields, keyof AddRepeatingRuleFields>`, so adding a rule flag that is not also an add-repeating field breaks compilation until it is classified. The leak cannot recur silently.

### A guard the campaign paid for

The first cut of the settle step shipped as `set before to (value of pu) as text`. **`before` is one of AppleScript's own positional keywords** — the script did not *compile*, and `osascript` reports that only at run time, as a drive failure mid-dialog, indistinguishable from a control that moved:

```
178:180: syntax error: Expected expression but found “to”. (-2741)
```

It cost a whole certification pass (cert run 1: 8/8 red). The variables are now `wasValue`/`curValue`, and `test/unit/ui-script-syntax.test.ts` feeds **every** script the repeat/heading/clone recipes generate through `osacompile` — which parses without executing, launching no app and sending no event — so the entire reserved-word class is caught at `npm run check` rather than in a VM. Its second case is a negative control proving the guard is not vacuous (`set before to …` must still fail to parse). `osacompile` is macOS-only, so the suite self-skips on the Linux `check` job and the repo's macOS CI job runs it explicitly.

---

## 4. Certification

Fresh clone of `things-lab-golden-v4` (the golden is never booted), airgapped, clock pinned. Production CLI, `--dangerously-drive-gui`, ground truth read out of guest SQLite — CLI exit 0 proves nothing on its own. Both #597 escapes were exported (`THINGS_API_UI_DIRECT=1 THINGS_API_WRITE_DIRECT=1`), so each compound ran all three of its legs on its own vector:

| leg | route |
|---|---|
| seed the item | **URL scheme** (`things:///add`) |
| the Repeat dialog | **`ui`** (AX GUI drive), unlocked by `THINGS_API_UI_DIRECT=1` |
| DBLSPAWN1 clean-up of the double-booked preserved instance | **AppleScript**, unlocked by `THINGS_API_WRITE_DIRECT=1` (#597) |

**8/8 PASS.** `next` is the landed first-occurrence START; `ts` is `startDaysEarlier`.

| cell | command | landed rule | verdict |
|---|---|---|---|
| **c1-yearly** | `todo add-repeating --when 2026-08-06 --deadline 2026-08-20 --frequency yearly` | `fu=4 ts=-14 of=[{dy=19,mo=7}] next=2026-08-06` | **PASS** |
| **c2-monthly** | `todo add-repeating --when 2026-08-06 --deadline 2026-08-20 --frequency monthly` | `fu=8 ts=-14 of=[{dy=19}] next=2026-08-06` | **PASS** |
| **c3-project** | `project add-repeating --area LAB-AREA-A --when 2026-08-07 --deadline 2026-08-21 --frequency monthly` | `fu=8 ts=-14 of=[{dy=20}] next=2026-08-07` | **PASS** |
| **c4-weekly** | `todo add-repeating --when 2026-08-06 --deadline 2026-08-20 --frequency weekly` | `fu=256 ts=-14 of=[{wd=4}] next=2026-08-06` | **PASS** |
| **c5-daily** | `todo add-repeating --when 2026-08-06 --deadline 2026-08-09 --frequency daily` | `fu=16 ts=-3 of=[{dy=0}] next=2026-08-06` | **PASS** |
| **c6-plain** | `todo add-repeating --when 2026-08-06 --frequency yearly` (non-deadlined control) | `fu=4 ts=0 of=[{dy=5,mo=7}] next=2026-08-06 deadline=None` | **PASS** |
| **c7-make** | `todo make-repeating --when 2026-08-06 --deadline --start-days-earlier 14 --frequency yearly` | `fu=4 ts=-14 of=[{dy=19,mo=7}] next=2026-08-06` | **PASS** |
| **c8-resched** | `todo reschedule-repeat --frequency monthly --when 2026-09-10 --deadline --start-days-earlier 14` | `fu=8 ts=-14 of=[{dy=23}] next=2026-09-10` | **PASS** |

c1 and c2 are the two cells VMRES1 §4.3 measured failing 2/2. c3 is the project-side arm; c4/c5 are the previously-working deadlined regression arms; c6 is the non-deadlined control; c7 and c8 are the other two `deadlineDriveNext` callers.

The two readings that matter sit in the same row: **`of=` encodes the DUE date** (`dy` is 0-indexed — `dy=19,mo=7` is Aug 20) while **`next`/`icStart` hold the requested START** (Aug 6). The dialog carries the deadline; the cursor asserts the start. That is the law the fix enforces, read back out of SQLite.

`crash=ALIVE ips=0` on every cell.

### Beeps

`THINGS_LAB_BEEPS_OK=1` (probe phase — counted, not failing). **3 alert beeps across the 8-cell window** (8 marks, one per cell), attributed by the sentinel to `c3-project`, `c4-weekly` and `c7-make` — one each; the other five cells were silent.

These are **not** introduced by this change and are **not** deadline-specific. The attribution is unstable across runs: an earlier 8/8-green run of the identical matrix on the same golden beeped 4 times, in `c2-monthly`, `c3-project`, `c4-weekly` and **`c6-plain`** — the non-deadlined control. A non-deterministic ~3–4 beeps per 8-cell promote matrix is a residual of the BEEP1 class (a step landing on a group the app is still rebuilding), on a control this campaign did not touch. Every diagnostic cell that did *not* run a full promote (`diag`, `diag2`, `diag3`, `diag4`, and both census arms) was **clean at 0**. Recorded as an open item, not closed here.

---

## 5. What this leaves open

- **The residual promote beeps** above — a BEEP1-class follow-up, needs its own probe to attribute the specific step.
- **`More…` is measured but undriven.** A recursive 100-per-page pager; no shipped verb needs a first occurrence past `Today + 14 occurrences`, so no recipe opens it.
- **An area-less project with a future start date** still cannot be promoted: `project.make-repeating` addresses its target as a selectable ROW, and such a project is a Someday row that the app renders under UPCOMING, so the `someday` reveal the taxonomy picks lands on a view the row is not in. That gap **pre-exists this campaign** and is a row-addressing question, not a `Next:`-pop-up one — which is why c3 certifies the deadlined project arm on the area route, the certified row shape.
