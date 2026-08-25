# HXPC1 — the Move… picker's blind commit, and the Repeat dialog's two numeric fields

**Probed under: `things-lab-golden-v4` · Things 3.23 (build 32300036) · DB v27 · macOS 15.7.7 · guest clock pinned 2026-07-05 (never rolled — the trial wall is 2026-07-18).** One disposable clone (`hxpc1-lab`), destroyed at the end. All fixtures synthetic. Driver: [`lab/scripts/research-hxpc1.sh`](../../lab/scripts/research-hxpc1.sh):

```sh
TART_HOME=/Volumes/Workspace/tart bash lab/scripts/research-hxpc1.sh setup          # clone + boot + airgap + clock pin + seed + ship the CLI
                                                          … census         # AX dumps: the Repeat dialog and the Move… picker
                                                          … dialog-census  # §A — the cadence group in all four numeric-field modes
                                                          … prefix-hazard  # §B3/§B4 — the PRE-FIX blind Return, both arms
                                                          … cert           # cells (b)/(c)/(d) through the production CLI
                                                          … cert-a         # cell (a) — the shipped dialog script text, driven live
                                                          … teardown
```

`prefix-hazard` drives raw AX rather than shipped code, so the falsification and the hazard both stay reproducible after the fix.

Two shipped ui-vector defects, both parked 2026-08-20, measured and closed. The campaign also **discharges the `pending HXPC1 certification` marker** the heading-ellipsis recipes carried since HEADXPROJ (2026-07-27): three of its four provisional element paths were wrong, and two of them meant the drive could never have worked on 3.23 at all.

---

## §A — `DIALOG_INTERVAL` and `DIALOG_ENDS_COUNT` were the same control

Both constants resolved to `text field 1 of group 1`. Measured, with the cadence group (`AXGroup id=_NS:60`) dumped in every mode that shows a numeric field:

| dialog state | group text fields | #1 | #2 |
|---|---|---|---|
| fixed frequency, `Ends: never` | 1 | interval `@[311,283]` | — |
| fixed frequency, `Ends: after N` | 2 | **ends COUNT** `@[402,372]` | interval `@[311,283]` |
| after completion (any) | 1 | interval `@[284,328]` | — |

So selecting the `after` bound **inserts the count ahead of the interval**. Raw children of the group with both fields shown (`ax/a4-after-distinct-writes.txt`):

```
  [3] role=AXGroup | id=_NS:60 | @[256,270 511x142]
    [1] role=AXStaticText | val=times | id=_NS:114 | @[431,375 35x16]
    [2] role=AXTextField | val=4 | id=_NS:108 | @[402,372 24x24]      <- ends count
    [4] role=AXPopUpButton | val=after | id=_NS:175 | @[313,372 83x25]
    [5] role=AXStaticText | val=Ends: | id=_NS:171 | @[275,375 31x16]
    [8] role=AXPopUpButton | val=Today | id=_NS:144 | @[313,327 151x25]
   [10] role=AXTextField | val=9 | id=_NS:25 | @[311,283 24x24]       <- interval
   [11] role=AXStaticText | val=Every | id=_NS:10 | @[275,286 36x18]
```

**Why the create path survived it, and the reschedule path did not.** `repeatDialogEntry` drives the interval BEFORE selecting the ends bound, while the interval is still the group's only text field — so `text field 1` was correct at that instant. A **reschedule opens the dialog PRE-POPULATED**: a rule that already ends after N presents both fields from the first step, so the interval drive wrote the requested interval into the **count** field, the count drive then overwrote it, and the interval silently never changed. The AX-beep entry's candidate (5) — "if ends-after re-addresses the interval field the read-back never matches and the full 3× retype cycle runs (3 beeps, then an `error`)" — is therefore **FALSIFIED for the create order** (each write landed in a field that held it, so the loop returned on attempt 1); the defect was a wrong-field write, not a retype storm.

**The fix: address each field by the ROW it sits on.** The group's `Ends:` static text is the anchor (y=375 against the count's y=372 — the same row tolerance `probe-dialog-shape` uses): the count is the field sharing that row, the interval is the field that does not. After-completion offers no ends bound at all (its group carries neither an `Ends:` label nor an Ends pop-up — only the unit pop-up and the interval), so "not on that row" leaves exactly the one field there too. Anything other than exactly one match fails closed, reporting the whole numeric-field inventory. Shipped as the `set-group-number` primitive (`axSetGroupNumberScript`).

### Cell (a) — certification, 9/9

The `todo make-repeating` / `reschedule-repeat` CLI legs are unreachable from a clone (their composites carry an AppleScript leg, and the Wave A write gate returns `direct-unknown` for every sshd-descended shell — [harness](harness.md), CNC1 §9). So the primitive was certified the REPX2/REPX3 way: a URL-scheme add, a direct AX Repeat-dialog drive, and **the exact script text `dist/` emits**, read out of the build so the thing under test is the thing that ships.

```
shipped interval=3 (sole field): OK                    <- a1
shipped ends-count=5:            OK                    <- a2
shipped interval=6:              OK                    <- a3 (BOTH fields present — the reschedule shape)
field readback: tf1=[5]@y372 tf2=[6]@y283              <- the count kept 5; the interval took 6
old spelling, value 8: OK                              <- a4: axSetValueScript on `text field 1 of group 1`
field readback after the old spelling: tf1=[8] tf2=[6] <- it wrote the COUNT and left the interval alone
rule: tp=0 fu=16 fa=6 ts=0 rc=5 of=[{dy=0}] …          <- a5: interval 6 + ends-after 5 in the database
```

Cell a4 is the falsification: the old shared spelling reports `OK` — its read-back is satisfied — while the number lands in the wrong field.

---

## §B — the Move… picker: three wrong paths and one real stray-project hazard

### §B0 — the heading `…` button was NOT addressable at all

`headingMoreButton` resolved `(first UI element of <content table> whose description is "More. <title>")`. A `whose` clause searches DIRECT children, and the table's direct children are its rows, which carry no description. Measured:

```
exact "More. HXPC1-HEAD" resolves: false          <- the shipped selector
{"cx":915,"cy":197,...}                            <- the raw AX API resolves it at the same instant
```

The node lives three levels down, and System Events reaches it fine once the walk is explicit:

```
#-1 AXApplication Things
 #2 AXWindow  sub=AXStandardWindow  ttl=HXPC1-SRC2
  #1 AXScrollArea
   #1 AXTable
    #3 AXRow sub=AXTableRow
     #1 AXCell
      #4 AXUnknown desc=More. HXPC1-HEAD2      <- the ellipsis button
      #5 AXUnknown desc=‎HXPC1-HEAD2           <- the title node (U+200E prefix, as HEADXPROJ recorded)
```

So **both** ellipsis drives — `project.move-heading-to-project` and `project.dissolve-heading` — died at their own frame resolution before any click, on every host. This is the cause of the clean `verify-failed:silent-noop` the timestamp-residual cells recorded against the golden-v2 rig ([reference/timestamps.md](../reference/timestamps.md) §2c): not a headless-rig limitation, a wrong path. Fixed with `axRowCellFrameScript` (rows → cells → cell children, exact match, fails closed by name). Note the U+200E prefix rides the **title** node only — the `More. <title>` description is clean, so an exact match on it is right.

### §B2 — the picker is a detached window, not a sheet

`HEADING_MOVE_PICKER` was `sheet 1 of <main window>`; the picker is a top-level `AXUnknown` window with `AXIdentifier = MovePopUpDialog-<uuid>` (the same class as the ellipsis popover, which is `ActionGroupPopUpMenu-<uuid>` and is already closed by the time the picker appears). Its filter field is nested one level under an untitled `AXUnknown`, so `text field 1 of <picker>` counts 0 direct text fields — the old `HEADING_MOVE_PICKER_FIELD` could not have resolved either. The picker's own direct children:

```
picker id=MovePopUpDialog-162C8B64-6B42-4F01-BC3E-32376D3B6F43
  [1] AXScrollArea  [2] AXImage Dialog Search Loupe Template
  [3] AXUnknown (holds the filter AXTextField)   [4] AXUnknown (clear button)
  [5] AXUnknown desc=[Move]        <- picker-only; the popover has just its scroll area
direct text fields=0     scroll areas=1
```

`[5]` is what the post-click assert now waits for: without it the assert (`the detached AXUnknown window exists`) was satisfied by the popover that was *already open*, i.e. by the click having done nothing.

### §B3 — there is no highlight to read, and the prefix collision was never the danger

Every picker row is an `AXUnknown` whose `AXDescription` IS the project title. **No row carries `AXSelected`, `AXFocused`, or `AXHighlighted` at all** — only the filter field is focused. There is therefore nothing to read back from a Return: the brief's "assert the highlighted row" is not implementable, and the honest form of the same guarantee is to *address* the row instead of guessing which one the app would take.

Typing `Synthetic Work` with `Synthetic Work Stuff` also present:

```
scroll area @[375,147 273x82]
  [5]  AXUnknown desc=[Synthetic Work]                len=14  @[406,149 231x17]
  [11] AXUnknown desc=[Synthetic Work Stuff]          len=20  @[406,172 231x17]
  [17] AXUnknown desc=[New Project “Synthetic Work”]  len=28  @[406,205 231x17]
exact-title hits=1      new-project rows=1
```

The exact match sorts first, and a blind Return on that state landed **correctly**:

```
-- rows on offer at the moment of the Return --
  [5] [Synthetic Work]   [11] [Synthetic Work Stuff]   [17] [New Project “Synthetic Work”]
landed in: Synthetic Work        projects after=12 (before=12)
```

So the exact-prefix collision the parked entry feared is **not** a live corruption on 3.23. Note the New-Project row's description uses CURLY quotes (U+201C/U+201D), and reads `New Project "<typed text>"` — never the bare title, so an exact-title match cannot collide with it.

### §B4 — the real hazard: a destination the picker does not offer

The picker lists **open projects only**. A completed or canceled project resolves perfectly well in `TMTask` (`type=1 AND trashed=0`, which is what `classifyHeadingMoveToProject` used), and a destination passed by uuid skips the title resolver's `status = 0` filter — so the drive could type a name the picker had nothing to offer for, leaving the create-row as the sole offer. Driving the pre-fix shape at a completed destination:

```
dest 'Synthetic Archive' status=3
-- rows on offer --
  [5] [New Project “Synthetic Archive”]        <- the ONLY row
-- after a blind Return --
HXPC1-HEAD4  project=Q7e7N3Gb
landed in: Synthetic Archive (status=0)
projects after=15 (before=14)
title              uuid8     status  creationDate
Synthetic Archive  M2p7Wm1a  3       1783253753.7341     <- the real destination
Synthetic Archive  Q7e7N3Gb  0       1783253795.59957    <- the STRAY the drive created
```

A **canceled** destination behaves identically (`status=2` → `[New Project “Synthetic Canceled”]` alone). That is the corruption the parked entry predicted, with a concrete trigger: not a title collision, an *absent* destination.

### The fix

* the commit is a **click on the row whose description equals the destination title** (`click-picker-row` / `axPickerRowFrameScript`) — no Return is ever sent, so the New-Project row is unreachable by construction;
* the resolver first confirms the window's `AXIdentifier` begins `MovePopUpDialog-`, then requires **exactly one** matching row, then requires that row's centre to lie inside the picker's own scroll area (the CNCAC1 off-screen-frame hazard — a row past the fold still resolves a frame, and a click at it lands on the desktop);
* every miss fails closed **naming what the picker did offer**, so an operator sees the app's actual answer;
* the filter text rides a plain `keystroke` at the already-focused field (`type-text`) rather than the select-all + Tab `set-value` mechanic — which also removes candidate (4) from the [AX-beep](../up-next.md) list (Tab in a popover filter field has no next key view);
* pre-state refuses a **non-open destination** up front (`dest-not-open`), so the common case gets a sentence instead of a driven app.

**Pre-state widening decision — the exact-twin refusal stays, prefix collisions are NOT refused.** The runtime resolver addresses the row by exact title, so a project whose title merely *starts with* the destination's is a different row and cannot be clicked (§B3 measured, and cell (c) certifies it end to end). Refusing that shape would decline an operation the app expresses perfectly well. The exact-TWIN refusal (`dest-ambiguous`) stays, because two identically-titled projects give two identical rows and neither the picker nor the resolver can say which was meant — and the resolver's `>1 hit` branch is the runtime backstop for the same state.

---

## §C — certification cells (production CLI, `--dangerously-drive-gui`, guest SQLite oracle)

Fresh per-run fixtures; a landed move is not repeatable, so a re-run must never read the previous run's end state as its own.

**(b) clean match — PASS.** `project move-heading-to-project HXPC1-SRCB-025416 <heading> --to HXPC1-DEST`:

```
drove 6 step(s): reveal … → activate → open the heading's ellipsis menu ("More. HXPC1-HEADB-025416")
  → ellipsis menu ▸ Move… → narrow the Move… picker to "HXPC1-DEST"
  → commit the Move… picker on the "HXPC1-DEST" row
EXIT=0    after: MOVED-TO-DEST    child follows via heading FK: 1/1    project count: before=24 after=24
```

**(c) prefix collision, targeting the SHORTER title — PASS.** `--to "Synthetic Work"` with `Synthetic Work Stuff` in the list:

```
{"ok":true,…,"observed":{"project.uuid":"7ViVvWKDuS748BwcahDw4N"},"vector":"ui","tier":3,…}
  … → narrow the Move… picker to "Synthetic Work" → commit the Move… picker on the "Synthetic Work" row
EXIT=0    after: heading=CORRECT-Synthetic-Work    projects 25 → 25    rows 86 → 86
```

**(d) the §B4 hazard, post-fix — PASS (refused, zero mutation).**

```
dest HXPC1-DONE-025416=8cpCZspk status=3
{"ok":false,"error":{"code":"blocked:H-UNKNOWN-DESTINATION","message":"the destination project
 \"HXPC1-DONE-025416\" is completed — the Move… picker the drive uses lists open projects only, so
 there is no row to move the heading into; reopen the destination project first — …"}}
EXIT=4   heading project after: GV9GNtcR (source=GV9GNtcR)   projects 27 → 27   rows 89 → 89
```

**(a) the dialog primitive — PASS 9/9** (above). Totals: **16 assertions, 0 failures.**

One incidental confirmation of the design: the picker resolver's fail-closed branch caught a wiring mistake of ours mid-campaign (the commit step was handed the picker's scroll area rather than the picker window), reporting `the front dialog is not the Move… project picker (window id "")` and clicking nothing.

---

## §D — what remains open

* **On-device certification.** Everything here is `lab-certified`; the ui-vector's on-hardware confirmation is unchanged ([ui-certification-runbook](ui-certification-runbook.md)).
* **The long-title cells** of the parked GUI-text-addressing entry are untouched by this campaign — this one measured the *addressing shape*, not truncation. The heading `…` button's description is now known to carry the full title at least up to the lengths probed here.
* **`project.dissolve-heading`** inherits the §B0 fix and is therefore expected to work for the first time on 3.23, but it was NOT driven end to end in this campaign (no cell). Its next sitting should carry one — and with it the two residual `umd` cells ([reference/timestamps.md](../reference/timestamps.md) §2c), whose "headless rig could not resolve the More button" reading §B0 supersedes.
* **The AX-beep entry's other candidates** (⌘A before first responder, Tab with no next key view, `clearDialog`'s app-wide Escape) are untouched; candidate (4) is removed by the `type-text` switch and candidate (5) is falsified above.
