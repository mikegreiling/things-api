# UIFIX1 — the repeat toggles, the project repeat bar and the Move… picker, rebuilt from a census

**Probed under: `things-lab-golden-v6` / `-v6h` · Things 3.25 (build 32500008) · DB v30, and `things-lab-golden-v5` / `-v5h` · Things 3.24 (build 32400006) · DB v29 · macOS 15.7.7 guests · guest clock pinned 2026-07-05 12:00, never rolled.** Census on one direct-arm clone of each of golden-v6 and golden-v5. Certification on one ROUTED clone of each of golden-v6h and golden-v5h (helpers installed and granted in the guest, `helpers-enabled true`, HELPGST1), through [`lab/scripts/stage5-rc-run.sh`](../../lab/scripts/stage5-rc-run.sh) with [`lab/guest/uifix1-cells.sh`](../../lab/guest/uifix1-cells.sh). All fixtures synthetic (`UFX-*`, `UFC-*`, `UFX1-*`). Every clone destroyed. Date: 2026-11-24.

## 0. Verdict

All five commands now work on Things 3.25 and 3.24, through the deputy, with normal CLI syntax:

| command | before (GV6 §5.3, v0.20.12 dist, 3.23/3.24/3.25) | after (this branch, routed) | root cause |
|---|---|---|---|
| `things todo resume-repeat` | refused: `Can't get menu item "Resume"` | 12/12 on 3.25, 12/12 on 3.24 | a latent race in our recipe against an app behavior: the `Pause`/`Resume` item's title lags the write |
| `things todo pause-repeat` (same race, other direction) | not exercised back to back | 12/12 and 12/12 | same |
| `things project pause-repeat` | refused at preflight: `text area 2 of … row 1` does not resolve | 12/12 and 12/12 | APP CHANGE in 3.23: the template view gained a banner row and the repeat bar stopped being a text area |
| `things project resume-repeat` | exit 0 only on a series that was already running (the idempotency no-op) | 12/12 and 12/12 | same handle as pause |
| `things project reschedule-repeat` | refused at preflight (same handle) | 12/12 and 12/12 | same, plus the popover's `Change…` became `Edit Rule…` in 3.23, plus the dialog guard below |
| `things project move-heading-to-project` | refused: `expected other, found move-picker` | 12/12 and 12/12, every run into a destination whose title is a prefix of another project's | OUR REGRESSION (#627, 2026-08-27), plus a 3.25 re-role of the picker's rows that would have refused the commit next |

Each run is checked against the database (`rt1_instanceCreationPaused`, the rule blob changed in place on the same template uuid, the heading's `project` FK and its child's `heading` FK, and the open-project count unchanged by the picker). Zero alert beeps and zero deputy script refusals in either run.

## 1. How shipped operations got here — per operation, with the evidence

### 1.1 `todo resume-repeat` (and `pause-repeat`): the toggle's title lags the write

**Last green:** UIC1 (2026-07-14, golden-v1 / Things 3.22.11, direct arm) certified both. CERTSWEEP1 cell RES (2026-08-25, golden-v4 / Things 3.23, direct) drove `resume-repeat` successfully — but with a `Create Next Copy` press between the pause and the resume. The recipe is unchanged since #137 (`git log -S'menu item "Resume" of menu 1'`), so this is not a code regression.

**What the census found.** `Items ▸ Repeat` carries ONE item whose title follows the series' state — `Pause` on a running series, `Resume` on a paused one — and the title updates up to ~0.8 s AFTER the write is in the database, with the selection unchanged. Sampled by name every ~400 ms straight after the CLI's verified pause returned:

```
3.24  pause verified (paused=1):  Pause Pause Resume Resume Resume …   (2 stale samples)
3.25  pause verified (paused=1):  Pause Pause Resume Resume Resume …   (2 stale samples)
3.25  resume verified (paused=0): Resume Resume Pause Pause Pause …    (2 stale samples)
```

So a resume issued straight after a pause (or the reverse) asks for an item that does not exist yet. GV6's discriminator cell A did exactly that (pause, then resume at once) on all three versions. It is not a cell error: `things undo` of a pause is precisely a resume issued straight after a pause. It is also the "`Pause` where CNCAC1 had recorded `Resume`" inconsistency CERTSWEEP1 §5 noted and did not chase (it read the submenu straight after pausing).

**Fix.** Both toggle recipes now WAIT (≤ 5 s, polled in one hop) for the item they are about to press, then press it. The canary still resolves the `Repeat` submenu up front, which only exists on a selected template. A wait that never sees the item fails closed with nothing pressed.

### 1.2 `project pause-repeat` / `resume-repeat` / `reschedule-repeat`: the repeat bar moved in 3.23

**Last green:** UIC3 (2026-07-15, golden-v1 / Things 3.22.11, direct arm), the only certification these three ever had. RDLG2 re-certified the TO-DO repeat family on 3.23 and nothing drove the project family on 3.23, 3.24 or 3.25 until GV6 — and it never ran routed at all. The handle (`text area 2 of UI element 1 of row 1 …`) is unchanged since #145.

**What the census found (3.24 and 3.25 agree in structure; roles differ).** A repeating project's TEMPLATE view now opens with two rows before the project's own header:

```
row 1  AXButton (3.25) / AXUnknown (3.24) d="You're editing the template of a repeating project."
row 2  (spacer)
row 3  the header: title, "More" (the project's …), checkbox, deadline, when, … and the repeat bar:
         AXButton (3.25) / AXUnknown (3.24)  — no description          @344,230 376x22
         AXStaticText (3.25) / AXUnknown (3.24) d="Repeat every week on Friday – Jul 10, Jul 17, Jul 24,  …"  @347,232 366x17
```

The bar is no longer a text area on either version (on 3.24 `text area 2` of the header cell is the NOTES field). Its label's description reads `Repeat every week on Friday – …`, `… – Paused` when paused, and `Repeat 2 weeks after the previous project has been completed – Waiting` for an after-completion rule. With the template shown, every `Items` menu entry is disabled and there is no `Repeat` submenu (3.24 and 3.25), so there is no menu-bar route.

Clicking the bar opens a detached window identified `RepeatingTaskPopUpMenuComponent-<uuid>` holding `Edit Rule…`, `Create Next Copy`, `Pause` (or `Resume`), `Stop` — 3.22's `Change…` and `Show Latest` are gone. Its items are `AXStaticText` (3.25) / `AXUnknown` (3.24); `AXPress` on an item returns success and does nothing (UIC2's finding, unchanged), and a HID click at its frame centre acts. `AXPress` on the bar's unlabeled button DOES open the popover on 3.25 (and a HID click at the label's centre does too, on both). The popover shows the series' current state as soon as it opens — no lag like §1.1's. `Edit Rule…` opens the standard Repeat sheet, attached.

**Fix.** The bar is resolved by walking the content table for the first row whose cell has a direct child whose description begins `Repeat ` — exactly one such child, or nothing is clicked — and clicked at that label's centre (the existing click-element primitive, the same frame-resolved HID click UIC3 certified). The post-click assert now waits for the ONE item the next step clicks (`Pause`, `Resume` or `Edit Rule…`), so a popover offering the wrong state fails closed and is dismissed. Reschedule clicks `Edit Rule…` and declares the Repeat sheet as the dialog it drives (§1.3).

### 1.3 `project move-heading-to-project`: our own dialog guard refused the picker

**Last green:** HXPC1 (2026-08-25, golden-v4 / 3.23, direct) certified the click-the-row commit (#589), and CERTSWEEP1 (2026-08-25, 3.23) drove the op in its umd cell.

**What broke it.** #627 (2026-08-27) added the per-step focus guard and its dialog LATCH: the first census that approves a hop while a dialog is open records that dialog as the drive's own, and every later keystroke must find exactly it. The census classifies any detached `AXUnknown` window that is not the 40×40 utility window as a dialog, and names it `other` unless it is the Repeat sheet or a `MovePopUpDialog-`. The click on `Move…` is a pointer hop taken while the heading's `…` popover (`ActionGroupPopUpMenu-<uuid>`) is open, so the drive latched `other`; the next hop types the destination into the picker and the guard found `move-picker`. Trace (GV6, golden-v6h): `ellipsis menu ▸ Move…` ok → `type-text … refused … expected other, found move-picker`. The cleanup then treated the picker as someone else's dialog and left it open. Two days separate HXPC1's green from the regression; nothing drove the op between them and GV6.

**A second defect waiting behind it (3.25 only).** The picker's rows are `AXStaticText` on 3.25 (`AXUnknown` on 3.24); the commit's resolver accepted only `AXUnknown`, so on 3.25 it would have reported the destination absent. The only other described children are images (`Dialog MoveToNewList Template` on the New-Project row, `Dialog Tick Template` on the current project), so the filter is now "not an image" and the identity, exact-title, uniqueness and on-screen checks are unchanged.

**Fix.** A click step can now declare the dialog it opens (`opensDialog`). When that click succeeds — its own post-click assert having seen the dialog — the drive records the declared dialog as its own. The `Move…` click declares `move-picker` and the project reschedule's `Edit Rule…` click declares `repeat`. The guard is unchanged: every later keystroke still has to find exactly that dialog in front, and a test pins that a different dialog after the `Move…` click still refuses (`expected move-picker, found other`).

## 2. Why the gate missed all four

- The write-layer e2e keeps `ui-enabled` OFF in both arms, by design, so none of its steps drives the window.
- The routed GUI smoke (`lab/guest/routed-gui-smoke.sh`) drove ONE operation: `todo add-repeating`.
- The engine tests ran the drives against a fake screen that never changed when a popover or picker opened, so the latch never saw a popover; and their recipes were checked for shape, not against a census.
- The ui certification runbook is per-version and was taken for the to-do family only after 3.23 (RDLG2).

**What covers them now.** `routed-gui-smoke.sh`, which `npm run lab:regress` runs in its routed arm, drives every one of these through the deputy with normal CLI syntax on every gate: to-do pause then resume back to back, project make-repeating → pause → resume → reschedule (every 2 weeks, rule changed in place), and move-heading-to-project into a destination whose title is a prefix of another project's (heading and child moved, no project created). The engine fake now models the popover (`other`) and the picker (`move-picker`) for the move drive, and the Edit Rule… sheet for the project reschedule.

## 3. Certification (routed, golden-v6h and golden-v5h)

`uifix1-cells.sh`: four quadrants {observer on/off} × {prefill on/off} × 3 reps × 6 drives = 72 drives per version, each DB-checked. Each quadrant gets its own fixtures, and each rep moves a fresh heading.

| run | Things | result |
|---|---|---|
| `uifix1-v6h-r1` | 3.25 (32500008) | **GREEN** — 72 drives, 87 assertions, 0 failures, 0 beeps, 0 deputy refusals |
| `uifix1-v5h-r1` | 3.24 (32400006) | **GREEN** — 72 drives, 87 assertions, 0 failures, 0 beeps, 0 deputy refusals |

Which machinery applies, read from each drive's own trace: the AX observer arms only on `project reschedule-repeat` (the one drive that opens the Repeat dialog) — armed in all 6 observer-on runs and absent in all 6 observer-off runs on each version. Prefill never engages on any of the five (it is a `make-repeating` mechanism that shapes the dialog from the seed row), in either setting. No other verb opens a dialog.

**Drive latency in the guest, wall per CLI call, routed (median, min–max, n=12 each):**

| command | 3.25 | 3.24 |
|---|---|---|
| `todo pause-repeat` | 807 ms (762–884) | 824 ms (744–936) |
| `todo resume-repeat` (straight after the pause) | 837 ms (802–891) | 862 ms (805–942) |
| `project pause-repeat` | 1763 ms (1617–1925) | 1781 ms (1622–2226) |
| `project resume-repeat` | 1727 ms (1585–2102) | 1790 ms (1575–2001) |
| `project reschedule-repeat` | 3483 ms (3403–3828) | 3698 ms (3395–4045) |
| `project move-heading-to-project` | 2650 ms (2564–2732) | 2847 ms (2536–2917) |

These are guest numbers; field latency on real hardware is the maintainer's own measurement.

A direct-arm smoke on the golden-v6 census clone ran the same six drives back to back once before the routed runs: all exit 0, DB-verified.

**The gate on the final code:** `npm run lab:regress` GREEN on golden-v6/-v6h. All eight suites passed: u 23, a 39, x 3, o 43, r 21, e 19, p 30, s 4 (182 probes, 2 interactive s-probes skipped as always). The write-layer e2e passed in both arms, direct 133 steps and routed 136, and the extended routed GUI smoke passed 13 steps (`things-run-e2e-routed-20261124-174235`). The same extended GUI smoke also ran alone on golden-v5h (3.24): 13 steps, 0 failures (`things-run-e2e-routed-20261124-171757`).

## 4. Observations, not chased

- **`project make-repeating --after-completion` returned `verify-failed:mismatch` once** on the golden-v6 census clone (`--frequency weekly --interval 2 --after-completion`, an area project dated 2026-07-10), leaving two untrashed templates of the same title and the trashed original. One sighting in a census pass that was not testing it; recorded so a second sighting is a report (it is the census's after-completion bar-text fixture, §1.2).
- On the census clones, `things:///show?id=<template>` issued while a project window was already showing opened a SECOND standard window. The recipes address `first window whose subrole is "AXStandardWindow"`, which is the frontmost one, and every drive above passed with two windows open on the 3.25 census clone.

## 5. Evidence

Gitignored, primary checkout: `lab/artifacts/uifix-census-v6.txt` and `uifix-census-v5.txt` (the census transcripts), `lab/artifacts/uifix1-v6h-r1/` and `uifix1-v5h-r1/` (transcripts, every drive's JSON and trace, the deputy log, `latency.tsv`). The "before" evidence is GV6's: `lab/artifacts/gv6-s5-cellsb-v4h`, `-v5h`, `-v6h` (§5.3 of [gv6-325-campaign.md](gv6-325-campaign.md)).

The census used read-only JXA over the AX API plus a few probe gestures (open the repeat popover, pause through it, open the heading popover and the picker, type into the picker's filter), each dismissed with Escape. The tools are committed in [`lab/guest/uifix1-census/`](../../lab/guest/uifix1-census/README.md), and `cen.sh` reproduces the whole pass.
