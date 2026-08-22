# RDLG1 — AX census of the Things 3.23 redesigned repeat surface

**Version stamp:** `things-lab-golden-v4` · Things **3.23** (CFBundleVersion **32300036**, direct-download channel) · macOS **15.7.7 (24G720)** · databaseVersion **27** · guest clock pinned **2026-07-05 12:00** (Sunday) · airgapped clone, AXVM1 accessibility grant baked. Immutable snapshot per the [harness](harness.md) version-stamping policy.

Drivers: [`lab/scripts/research-rdlg1.sh`](../../lab/scripts/research-rdlg1.sh) (breadth pass — menus, both dialog shells, row AX, list routes) and [`lab/scripts/research-rdlg1b.sh`](../../lab/scripts/research-rdlg1b.sh) (depth pass — per-frequency control layout, pop-up vocabularies, the new chooser, a live production-recipe drive). Fixtures are fully synthetic (`RDLG1-*` / `RDLGB-*` plus the golden's own `LAB-*` seed).

**Scope note.** This is a CENSUS. It changes no recipe, no suite expectation, no assumption-register row and no oddities entry. The reconciliation is the maintainer's.

---

## 0. Why this campaign exists

Things 3.23 shipped a redesigned repeating-to-do dialog plus a set of GUI-only additions, and the **scripting dictionary did not move**: the golden's `Things.sdef` is `sha256:1b6752334207f68cdcb7e71dfc34a21407095bd239afe5df6b3cdd8e2c70cde0`, byte-identical to 3.22.11 / 3.22.12 / 3.22.14. Every 3.23 repeat feature is therefore reachable **only** through the AX (System Events) vector — the one surface whose recipes are hand-indexed against a dialog that just changed.

---

## 1. Headline: what the ui-vector must change

Mapped against `src/write/vectors/ui-recipes.ts` as shipped (UIC1/UIC5/UIC6-certified for 3.22.x).

| Recipe / constant | 3.22.x | 3.23 | Verdict |
|---|---|---|---|
| `ITEMS_MENU ▸ "Repeat…"` (plain to-do) | present, enabled once a row is selected | **unchanged** — `Repeat…` present + enabled | **OK** |
| `ITEMS_MENU ▸ "Repeat" ▸ "Reschedule…"` (template) | `Reschedule…` | **RENAMED → `Edit Rule…`** | **BROKEN** — the shipped path raises `-1728 Can't get menu item "Reschedule…"`. `rescheduleRepeatRecipe` cannot run. |
| `ITEMS_MENU ▸ "Repeat" ▸ "Pause"` | present | present | **OK** |
| `ITEMS_MENU ▸ "Repeat" ▸ "Resume"` | present when paused | not offered on an unpaused template (Pause/Resume swap, as before) — **unverified under 3.23 on a paused template** | **UNVERIFIED** |
| `ITEMS_MENU ▸ "Repeat" ▸ "Stop"` | present | present | OK (no recipe ships for it) |
| `REPEAT_SHEET` = `sheet 1 of (first window whose subrole is "AXStandardWindow")` | attached `AXSheet` | **unchanged** — still an `AXSheet` child of the standard window | **OK** |
| `REPEAT_DETACHED` = `(first window whose subrole is "AXUnknown" and size is not {40, 40})` | detached dialog when Things is backgrounded | **unchanged** — still a top-level `AXUnknown` window, `545 × 233` in the after-completion mode | **OK** |
| `DIALOG_FREQUENCY` = `pop up button 1` (sheet-level) | frequency pop-up | **unchanged** — still the sheet's ONLY direct-child pop-up | **OK** |
| `DIALOG_INTERVAL` = `text field 1 of group 1` | interval field | **unchanged** — the cadence group still carries exactly one text field in every mode (with Ends = `never`) | **OK** |
| `DIALOG_OK` / `DIALOG_ADD_REMINDERS` / `DIALOG_ADD_DEADLINES` | `button "OK"` / `checkbox "Add reminders"` / `checkbox "Add deadlines"`, sheet-level | **unchanged** (sheet-level: 1 pop-up, 2 checkboxes, 2 buttons in every mode) | **OK** |
| `DIALOG_ENDS` = `pop up button 1 of group 1` | Ends bound | **unchanged** — Ends is still the FIRST group pop-up | **OK** |
| `DIALOG_AC_UNIT` = `pop up button 1 of group 1` (after-completion mode) | cadence unit | **unchanged** — in after-completion mode the unit pop-up is the group's only pop-up | **OK** |
| `DIALOG_ADD_WEEKDAY` = `button 1 of group 1` | weekly "+" | **unchanged** — the group carries exactly one title-less `AXButton` in weekly/monthly/yearly, none in daily/after-completion | **OK** |
| `DIALOG_WEEKDAY` = `pop up button 2 of group 1` | weekday | **now pop up button 3** | **BROKEN (+1 shift)** |
| `DIALOG_MONTH_MODE` = `pop up button 2` / `DIALOG_MONTH_ORDINAL` = `3` | monthly anchor | **now 3 / 4** | **BROKEN (+1 shift)** |
| `DIALOG_YEAR_MONTH` = `2` / `DIALOG_YEAR_MODE` = `3` / `DIALOG_YEAR_ORDINAL` = `4` | yearly anchor | **now 3 / 4 / 5** | **BROKEN (+1 shift)** |
| `setDateTime(target: "next")` — the top midnight `AXDateTimeArea` (ANCH2) | first-occurrence date picker | **REPLACED by an `AXPopUpButton`** (`Next:`) offering `Today` + the next 14 on-rule occurrences + `More…` | **BROKEN (control class changed)** |
| `DIALOG_ENDS_COUNT` = `text field 1 of group 1` | Ends-after count | not re-censused (needs Ends = `after`) | **UNVERIFIED** |
| `setDateTime(target: "ends")` — bottom midnight date area | Ends-on-date bound | not re-censused (needs Ends = `on date`) | **UNVERIFIED** |
| `setDateTime(target: "reminder")` | reminder time area | not re-censused (needs Add reminders checked) | **UNVERIFIED** |

**The single cause of the +1 shift is the new `Next:` pop-up**, which sits between Ends and every per-frequency control in `AXChildren` order.

### 1.1 The live drive still works for the simple path

`todo make-repeating <uuid> --frequency daily --interval 1 --dangerously-drive-gui --json`, run from the production bundle inside a 3.23 clone, **succeeded**: all 8 recipe steps executed (`reveal → activate → assert-eligible → Items ▸ Repeat… → wait for the dialog → frequency = daily → interval = 1 → OK`), the template and its instance were created, verify-per-write passed, `ok: true`, `dbVersion: 27`, `fingerprint: ok`. That is the exact subset of the dialog that did not move. Anything touching a weekday/monthly/yearly anchor, an explicit first occurrence, or `Edit Rule…` is broken — see §1's table.

---

## 2. The dialog, control by control

### 2.1 Shell

Unchanged in both forms. Frontmost → `AXSheet` attached to the `AXStandardWindow`; backgrounded → a detached top-level `AXWindow` with `AXSubrole = AXUnknown` (the 40×40 utility stub is displaced, so the `size is not {40, 40}` discriminator still selects correctly). Controls sit at the same container depth in both, exactly as UIC5-e found for 3.22.

Sheet children, in `AXChildren` order, in every mode:

```
[1] AXCheckBox  ttl="Add reminders"   id=_NS:135
[2] AXCheckBox  ttl="Add deadlines"   id=_NS:129
[3] AXGroup                            id=_NS:60     <- the cadence group ("group 1")
[4] AXStaticText val="Repeat"          id=_NS:120
[5] AXPopUpButton  <frequency>         id=_NS:29     <- "pop up button 1" of the sheet
[6] AXButton    ttl="OK"               id=_NS:115
[7] AXButton    ttl="Cancel"           id=_NS:86
[8] AXImage     desc="Repeating Circle Fill FullColo"  id=_NS:93
```

The `AXImage` and the `Repeat` static text are new decoration; neither is addressable state.

### 2.2 Frequency pop-up (`pop up button 1` of the sheet, `_NS:29`)

Menu items, in order: `after completion`, *(separator)*, `daily`, `weekly`, `monthly`, `yearly`.

**The dialog's DEFAULT mode on a fresh to-do is now `after completion`** (3.22 opened on a calendar frequency). The shipped recipe always selects the frequency explicitly, so this does not break `makeRepeatingRecipe` — but any code that assumed the initial state is a calendar rule is now wrong, and a *pre-populated* dialog (`Edit Rule…`) opens on the template's own mode.

### 2.3 Cadence group (`group 1`, `_NS:60`) — pop-up index map

Measured by driving the frequency pop-up through every mode on a fresh to-do (Ends left at `never`):

| mode | group pop-up 1 | 2 | 3 | 4 | 5 | text fields | buttons |
|---|---|---|---|---|---|---|---|
| `after completion` | unit (`week`) | — | — | — | — | 1 (interval) | 0 |
| `daily` | **Ends** (`never`) | **Next** (`Today`) | — | — | — | 1 (interval) | 0 |
| `weekly` | **Ends** (`never`) | **Next** (`Today`) | weekday (`Sunday`) | — | — | 1 (interval) | 1 ("+") |
| `monthly` | **Ends** (`never`) | **Next** (`Today`) | month-mode (`day`) | ordinal (`5th`) | — | 1 (interval) | 1 |
| `yearly` | **Ends** (`never`) | **Next** (`Today`) | month (`July`) | month-mode (`day`) | ordinal (`5th`) | 1 (interval) | 1 |

Sheet level is constant across modes: `pop up buttons = 1`, `text fields = 0`, `checkboxes = 2`, `buttons = 2`.

Raw child order for **weekly** (the shape that shows every element class):

```
AXGroup _NS:60
  [1]  AXStaticText   val=",  7/12/26,  7/19/26,  7/26/26,  8/2/26, …"  id=_NS:183   <- NEW occurrence preview
  [2]  AXPopUpButton  val="never"     id=_NS:175   <- Ends            (group pop-up 1)
  [3]  AXStaticText   val="Ends:"     id=_NS:171
  [4]  AXStaticText   val="Next:"     id=_NS:138
  [5]  AXStaticText   (empty)         id=_NS:132
  [6]  AXPopUpButton  val="Today"     id=_NS:144   <- Next            (group pop-up 2)  ** NEW **
  [7]  AXButton       (title-less)    id=_NS:276   <- weekday "+"     (group button 1)
  [8]  AXPopUpButton  val="Sunday"    id=_NS:259   <- weekday         (group pop-up 3)
  [9]  AXStaticText   val="weeks"     id=_NS:255
  [10] AXTextField    val="1"         id=_NS:248   <- interval        (group text field 1)
  [11] AXStaticText   val="Every"     id=_NS:246
  [12] AXStaticText   val="on"        id=_NS:242
```

and for **yearly**:

```
  [1]  AXStaticText   val=",  7/5/27,  7/5/28,  7/5/29,  7/5/30, …"  id=_NS:183
  [2]  AXPopUpButton  val="never"   id=_NS:175  <- Ends       (1)
  [6]  AXPopUpButton  val="Today"   id=_NS:144  <- Next       (2)
  [8]  AXPopUpButton  val="July"    id=_NS:364  <- month      (3)
  [10] AXPopUpButton  val="day"     id=_NS:348  <- month-mode (4)
  [12] AXPopUpButton  val="5th"     id=_NS:326  <- ordinal    (5)
  [11] AXButton       (title-less)  id=_NS:342
  [14] AXTextField    val="1"       id=_NS:315  <- interval
```

`_NS:` identifiers are NOT stable addressing (they already differ per mode — the weekday pop-up is `_NS:259`, the yearly month pop-up `_NS:364`) and must stay unused, exactly as UIC6 ruled. Structural index + role remain the only sound handle.

### 2.4 The NEW `Next:` pop-up (`group pop-up 2`, `_NS:144`)

This is the blog's "easier to pick the date for the next copy", and it is the most consequential change for us: **the first-occurrence anchor is no longer a date field, it is a bounded pop-up menu.** In weekly mode on a Sunday-pinned clock its items are:

```
Today
Sun, Jul 12, 2026
Sun, Jul 19, 2026
Sun, Jul 26, 2026
Sun, Aug 2, 2026
… (14 on-rule occurrences total) …
Sun, Oct 11, 2026
(separator)
More…
```

Consequences:

- `Today` plus the next 14 **on-rule** occurrences are selectable by title.
- Anything else — every **off-rule** first occurrence, and any on-rule date beyond the 14th — must go through **`More…`**, which is presumably a date-picker affordance. `More…` was NOT opened in this pass: **that is the single most important open cell for the recipe rewrite** (ANCH2 / YANCH1 / RSPA1 / DACON1 all depend on driving an arbitrary Next date, and the entire "off-rule first occurrence" vocabulary rides on it).
- The item titles are **locale- and format-dependent** (`Sun, Jul 12, 2026`), so title-pinned selection of a specific date is fail-closed-under-locale in exactly the way UIC6 documented for weekday/month names.

### 2.5 Occurrence preview (`AXStaticText _NS:183`)

New: the dialog renders the upcoming occurrence list as a static text (`",  7/12/26,  7/19/26, …"`). It is a free, in-dialog **read-back oracle** for the rule the dialog currently encodes — worth wiring into the drive as a pre-OK assertion.

---

## 3. `Items ▸ Repeat` — the restructured submenu

With a repeating TEMPLATE selected (3.23):

```
Items ▸ Repeat ▸
  Edit Rule…
  (separator)
  Show Previous Copy
  Create Next Copy
  (separator)
  Pause
  Stop
```

- **`Edit Rule…`** replaces `Reschedule…`. Same dialog, pre-populated.
- **`Create Next Copy`** — the new command named in the release notes. Addressed as
  `menu item "Create Next Copy" of menu 1 of menu item "Repeat" of menu "Items" of menu bar 1`.
- **`Show Previous Copy`** — a second new item, NOT in the release-note summary we worked from.
- `Pause` / `Stop` as before (`Resume` swaps in for `Pause` on a paused template — unverified under 3.23).

The full `Items` menu with a template selected also shows a new **`Share…`** item (enabled) that 3.22's census does not record; with nothing selected the whole menu is disabled and the `Repeat` submenu is absent, exactly as UIC1 found.

With a repeating INSTANCE selected, `Items` offers only `When…` and `Shortcuts` as enabled — there is **no `Repeat` submenu on an instance** (unchanged).

---

## 4. Instance rows — the checkbox change

Today-list row subtree for a repeating instance (`LAB-REPEAT-DAILY`) under 3.23:

```
AXRow ▸ AXCell
  AXUnknown  desc="‎<title>"                       <- title (note the leading U+200E)
  AXUnknown  desc="Checkbox"                        <- the completion control
    AXImage  desc="Checkbox Regular"
  AXImage    desc="Task NewForToday Template"
  AXImage    desc="Repeating Circle Fill FullColo"  @ 2×2  (collapsed)
```

The instance row now carries the **same `Checkbox Regular` image as a plain to-do** — the release notes' "complete a repeating to-do early by ticking its checkbox". The `Repeating Circle Fill FullColo` image is present on **every** row (repeating or not) at a collapsed 2×2 frame, so it is NOT a usable discriminator: an AX consumer cannot tell a repeating instance from a plain to-do by row glyph. Row structure is otherwise identical to a plain row.

---

## 5. The "Repeating" list — and `File ▸ New Repeating To-Do`

Reached through the menu bar, not a URL route:

```
View ▸ Go To ▸ Inbox ⌘1 · Today ⌘2 · Upcoming ⌘3 · Anytime ⌘4 · Someday ⌘5 · Logbook ⌘6
              (separator)
              All Projects · Deadlines · Repeating          <- no command key on these three
```

Driving `menu item "Repeating" of menu 1 of menu item "Go To" of menu "View" of menu bar 1` navigates: afterwards `tell application "Things3" to get name of front window` returns **`Repeating`** (System Events reports an empty window name — use the Things dictionary, not AX, to confirm the list). On the golden's seed the list showed **8 rows**.

`things:///show?id=repeating` (and `…?id=Repeating`) returns exit 0 from `open` but produced no observable navigation — **no evidence the URL scheme gained a `repeating` list route.** The menu item is the addressable handle.

**Also new: `File ▸ New Repeating To-Do`**, sitting between `New To-Do` and `New Heading`. This is not in the release-note summary we worked from and is potentially significant beyond the census: it is a *direct* create-a-repeating-to-do affordance, where our `add-repeating` today has to mint a plain to-do and promote it via clone. Worth a campaign of its own.

The full 3.23 `File` menu, for the record: `New To-Do`, **`New Repeating To-Do`**, `New Heading`, `New Heading with Selection`, `New Project`, `New Area`, (sep), (sep), `New Things Window`, `Close`, `Close All`, (sep), `Import`, (sep), `Page Setup…`, `Print…`.

---

## 6. The Make Exception / Update Rule chooser — NOT REPRODUCED

Two gestures were driven against an open, fixed-schedule instance of the seeded daily template. **Neither produced a chooser**, and this is reported as a negative result, not a capture.

### 6.1 `Items ▸ When…` → type a date → Return

The When picker is a **detached `AXWindow` with `AXSubrole = AXUnknown` and `AXIdentifier = WhenPopUpDialog-<UUID>`** — a stable-prefix handle worth keeping (`(first window whose value of attribute "AXIdentifier" starts with "WhenPopUpDialog-")`). Its structure:

```
AXWindow id=WhenPopUpDialog-<UUID>  341×396
  [1] AXScrollArea                       <- the option list
        AXUnknown desc="Today"
        AXUnknown desc="This Evening"
        [15] AXScrollArea                <- the CALENDAR GRID: exposes NO AXChildren (AX-opaque)
        AXUnknown desc="Someday"
        AXUnknown desc="Add Reminder"
  [3] AXUnknown ▸ [1] AXTextField        <- the natural-language search field
  [4] AXUnknown ▸ AXImage desc="Dialog Search Cancel Template"
  [5] AXUnknown desc="When"
  [6] AXUnknown desc="Clear"
```

The filter works and is a usable drive: typing `tomorrow` collapses the window to `341×173` and leaves a single row `AXUnknown desc="Tomorrow"` + `AXUnknown desc="Jul 6"`, with the typed text readable back from the `AXTextField` (`val="tomorrow"`). But pressing Return then **dismissed the picker with no chooser and no date change** (`startDate` still the pinned day). Typing `7/20/2026` in the breadth pass behaved the same way and also did not parse.

So either Return is not the commit gesture for this picker (the filtered row probably needs an explicit press/click), or the commit needs the row selected first. **That is the open mechanic**, and it gates the chooser.

### 6.2 `Items ▸ Shortcuts ▸ Someday`

This one *did* move the instance — `startDate` → NULL, `start` → 2, `rt1_repeatingTemplate` still set — and **no chooser appeared**. Useful as a bound: a fixed-schedule instance can be pushed to Someday through the menu with no exception/rule prompt at all.

### 6.3 Status

**OPEN, and now the campaign's second priority** (after `Next: ▸ More…`). What is still needed: the gesture that actually re-dates a fixed-schedule instance (press the filtered row rather than Return; or an Upcoming-list drag), then the chooser's shell, button titles and `AXIdentifier`s. Note the calendar grid is AX-opaque, so an arbitrary-date move may only be expressible through the typed filter field — the same constraint the `Next: ▸ More…` path probably imposes.

Caveat on this section's rigour: the depth pass's selection assertion was itself broken (it read `selected to dos of window 1`; `selected to do` is an element of the **application**, not of a window — `-1728`). The gestures still landed (the Someday move is proof), but the cells were driven without a confirmed selection. The assertion is fixed in the committed script; a re-run should treat §6 as unverified-by-construction.

---

## 7. Open cells (for whoever picks this up)

1. **`Next: ▸ More…`** — what it opens, and how an arbitrary/off-rule first occurrence is driven. Blocks every off-rule anchoring law (ANCH2, YANCH1, RSPA1, DACON1, the #508 oracle).
2. **The Make Exception / Update Rule chooser** — reachable gesture, shell, buttons.
3. **`Ends = after` / `Ends = on date`** — does `text field 1 of group 1` still collide with the interval field (the standing up-next item), and is the Ends date still an `AXDateTimeArea`?
4. **`Add reminders` / `Add deadlines` reveal** — the `start N days earlier` field and the reminder `AXDateTimeArea`.
5. **`Resume`** on a paused template; **`Create Next Copy`** and **`Show Previous Copy`** DB semantics.
6. **Bulk pause/resume/stop** (multi-selection) — untouched by this census.
7. **A repeating PROJECT** — `projectMakeRepeatingRecipe` drives the same dialog through a different reveal; the dialog findings should carry, the reveal path was not re-certified.
