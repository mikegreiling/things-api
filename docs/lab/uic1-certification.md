# UIC1 — in-VM certification of the ui vector + AX addressing catalog

**Verdict (2026-07-14):** the ui vector is now **certifiable in the VM lab**, and five of its seven ops are **lab-certified** against **Things 3.22.11 / macOS 15.7.7 / DB v26**. Two ops **failed** certification and stay uncertified, both for the same root cause: **Things exposes no Accessibility/URL handle to select an arbitrary list row**, so the AX-only vector cannot reach a to-do *card* (needs a mouse double-click) or select a *heading* (`things:///show` selects to-dos only). Certifying the recipes required real code fixes — the as-shipped recipes addressed `window 1` (a hidden 40×40 utility window) and set the frequency pop-up with `set value` (a silent no-op); without the fixes make/reschedule/convert would all have failed.

Run: [`lab/scripts/research-uic1.sh`](../../lab/scripts/research-uic1.sh). ONE `--vnc-experimental` clone `things-run-uic1-20260714-223212` (airgapped, clock-pinned 2026-07-05, Things 3.22.11 / macOS 15.7.7 / DB v26), Accessibility granted once via the AXVM1 user-path toggle (rung b), then everything driven over SSH through the **real shipped pipeline** (guest e2e bundle: node + dist + commander; `ui.enabled` set; each op with `--dangerously-drive-gui`). Ground truth = the guest Things DB row deltas (verified by the pipeline's own read-after-write + independent SQLite reads), corroborated by the AX-tree dumps and the grant screenshots (`11`–`13`) under the run's artifacts dir (gitignored).

Cross-linked from [ui-certification-runbook.md](ui-certification-runbook.md) and [ui-vector-research.md](ui-vector-research.md); probe row in the [reference README](../reference/README.md).

## Per-op certification verdicts (UIC1-a)

| Op | Verdict | DB delta observed | Recipe fix needed to pass |
|---|---|---|---|
| `todo.pause-repeat` | **lab-certified** ✅ | `rt1_instanceCreationPaused` 0→1, `rt1_nextInstanceStartDate` cleared to NULL; identity preserved | none (menu-only recipe) |
| `todo.resume-repeat` | **lab-certified** ✅ | paused 1→0, next date restored; round-trips pause | none (menu-only recipe) |
| `todo.make-repeating` | **lab-certified** ✅ | original uuid hard-deleted; NEW template (`fu`=256 weekly, default Sunday `wd`) + spawned instance; result returns new uuid | frequency pop-up `set value` → **select-popup**; interval field path (nested in the dialog group); `window 1` → main standard window |
| `todo.reschedule-repeat` | **lab-certified** ✅ | same uuid (identity preserved); rule `fu` 16→8 (daily→monthly); `rt1_nextInstanceStartDate` advanced | same dialog fixes as make-repeating |
| `todo.convert-to-project` | **lab-certified** ✅ | original to-do uuid gone; new `type=1` project, notes preserved; result returns new project uuid | confirm sheet on the main window (not `window 1`); confirm button upgraded to AXIdentifier `action-button-1` |
| `todo.stop-repeat` | **FAILED — uncertified** ❌ | none (refused fail-closed; item unchanged) | **blocked**: the Stop popover is card-only, and the card opens only via a mouse double-click — list rows are sparse `AXCell`s with no press/open action and no URL handle. AXPress on the cell, a second AXPress, `Return`, and `Get Info` all fail to open the card (an `entire contents` scan finds no repeat bar). No AX card-open path exists. |
| `heading.convert-to-project` | **FAILED — uncertified** ❌ | none (drive no-op'd; heading unchanged) | **blocked**: `things:///show?id=<heading>` does not select the heading (selection goes empty, window falls back to "Today", `Convert to Project…` is **disabled**). Headings, like all list rows, expose no AX selection handle. The op drove but the disabled menu item did nothing → the pipeline's verify reported a silent no-op. |

**The shared blocker.** Both failures reduce to the same limitation AXVM1 first noted: *Things list rows are not AX-addressable* (sparse custom rendering). A to-do is reachable because `things:///show?id=<uuid>` selects it (to-dos are "to dos" to the URL scheme); a **card** (needed for Stop) and a **heading** (needed for heading-convert) are not reachable because one needs a row double-click and the other needs a heading-row selection, neither of which the URL scheme nor System Events AX can produce. A compiled native-AXUIElement helper (the deferred follow-up in [ui-vector.md](../design/ui-vector.md)) could synthesize a double-click and might unblock both; recorded in [up-next.md](../up-next.md).

Every certified op also carried the expected result-envelope warnings (GUI-driven note + "this operation is lab-certified: … not confirmed on real hardware") and passed the pipeline's read-after-write verify.

### Gating + fail-closed (re-confirmed live)

- **Blocked** (exit 4, `H-UI-DRIVE`) when `--dangerously-drive-gui` is omitted. ✅
- **Unsupported** (exit 6, remediation names `ui-enabled`) when the config is off. ✅
- **stop-repeat fails closed**: the canary/wait can't resolve the card's repeat bar → clean refusal naming the missing element, nothing pressed, DB unchanged. ✅

## AX addressing catalog (UIC1-b)

Dumped with System Events (`role`, `AXSubrole`, `AXIdentifier`, `title`) for every surface the recipes touch. **Headline: AXIdentifier is only usable in two places** — the top-level menu-bar items and the alert/confirm-sheet buttons. Menu *items* and repeat-dialog controls give no stable identifier, so those steps stay title-pinned (English), which the canary already enforces (see locale probe).

| Surface | Element | role | AXIdentifier | Addressing decision |
|---|---|---|---|---|
| Menu bar | `Items` / `File` / `Edit` menu-bar items | AXMenuBarItem | `items` / `file` / `edit` (stable, lowercase name) | usable, but the leaf below isn't — marginal, left title-addressed |
| Items menu | `When…`, `Move…`, `Convert to Project…`, `Get Info…`, `Repeat…`, … | AXMenuItem | **`performCommand:` (shared by ALL actionable items)** | NOT usable — title-pinned required |
| Items ▸ Repeat submenu | `Reschedule…`, `Pause`↔`Resume`, `Show Latest` (only when a repeating item is selected) | AXMenuItem | `performCommand:` (shared) | title-pinned |
| Repeat dialog | sheet root | AXSheet on the **main standard window** | — | `sheet 1 of (first window whose subrole is "AXStandardWindow")` |
| Repeat dialog | frequency pop-up | AXPopUpButton | `_NS:116` | title-pinned + **select-popup** (`set value` is a no-op; see quirks). Options: `after completion` · (sep) · `daily` · `weekly` · `monthly` · `yearly` |
| Repeat dialog | interval field | AXTextField | `_NS:25` (daily) / `_NS:253` (weekly) — **regenerates per layout** | positional: `text field 1 of group 1 of sheet 1 of <mainwin>` (`set value` works) |
| Repeat dialog | OK / Cancel | AXButton | `_NS:164` / `_NS:157` (build-tied, not semantic) | title-pinned (`OK`/`Cancel`) |
| Repeat dialog | Ends pop-up | AXPopUpButton | `_NS:151` | future vocab. Options: `never` · `after` · `on date` |
| Repeat dialog | `Add reminders` / `Add deadlines` | AXCheckBox | `_NS:177` / `_NS:171` | future vocab |
| Convert / Stop / Get Info confirm sheet | primary / secondary button | AXButton | **`action-button-1` / `action-button-2` (semantic, locale-proof)** | **UPGRADED** to AXIdentifier |
| Main window | the real UI window | AXStandardWindow (window 2) | — | address by subrole — **`window 1` is a 40×40 `AXUnknown` utility window** |
| List rows | to-do / heading rows | AXRow → single empty AXCell | — | **NOT addressable** (no actions, no title) — the blocker above |

**AXIdentifier steps upgraded:** 2 — the convert-to-project and stop-repeat **confirm buttons** (`button "Convert"`/`button "Stop"` → `action-button-1`), the only semantically-stable, locale-proof identifiers Things exposes on the recipe path. All other steps remain title-pinned because no per-element identifier exists (menu items share `performCommand:`; dialog controls carry only volatile `_NS:` numbers that change with the dialog layout).

### Full Repeat-dialog field map (for the future rule-vocabulary op)

- **daily**: `Every [n] days`.
- **weekly**: `Every [n] weeks on [day-of-week pop-up: Sunday…Saturday]` + a "+" button (multi-day).
- **monthly**: `Every [n] months on the [mode] [ordinal]` — mode pop-up = `day` · (sep) · `Sunday…Saturday`; ordinal pop-up = `last` · (sep) · `1st…31st` (so "last day", "last Friday", "3rd Tuesday" are all expressible).
- **yearly**: `Every [n] years on the [Month] in [mode] [ordinal]` — month pop-up + the same mode/ordinal pair as monthly.
- **Ends**: `never` · `after [n]` · `on [date-picker]`. **Add reminders** and **Add deadlines** are checkboxes (the latter reveals a "start N days earlier" field when checked).

### Future-op surfaces (shallow scoping dumps)

- **File menu**: `New To-Do`, **`New Repeating To-Do`**, `New Heading`, `New Heading with Selection`, `New Project`, `New Area`, `New Things Window`, `Import`, … — there is **no "New Repeating Project"** item (a repeating project is made by creating a project then `Items ▸ Repeat…`).
- **Sidebar** (areas/top-level projects): an `AXTable` of sparse `AXCell` rows — same non-addressability as the main list, so a sidebar reorder / area op would hit the row-selection blocker.
- **Settings**: opens a separate window whose panes are toolbar buttons (`General`, …) — addressable for a future settings op.
- **Tag manager**: not separately dumped (tags managed via the tags view / Window menu — scope in the follow-up).

## Repeating-PROJECT parity note

A repeating **project** revealed via `things:///show?id=<project-uuid>` behaves like the heading case: it opens the project's list view rather than selecting the project *as an item*, so the Items menu shows **no Repeat submenu** and repeat-management is not reachable on that path. The repeat **dialog itself is almost certainly identical** (it is the same editor the to-do path opens), but the **selection/addressing differs** — a repeating project is a sidebar entity, not a URL-selectable to-do row. So repeating-project ops need a different reveal (sidebar selection), which faces the same row-addressability limitation. This is scoped in follow-up (1).

## Locale-hardening probe (UIC1-c)

**Verdict: the fail-closed canary already provides locale safety, and the per-app pin is the mechanism.**

- `defaults write com.culturedcode.ThingsMac AppleLanguages -array de` + relaunch → the menus **localize** (`Über Things`, `Einstellungen …`, `Things beenden`, …), the English anchor `menu item "Repeat" of menu "Items"` no longer resolves, and `pause-repeat` **refuses fail-closed** ("Items ▸ Repeat ▸ Pause did not resolve … the app may not be in English").
- `defaults write … AppleLanguages -array en` + relaunch → the anchor resolves again and the op works.

The driver's existing refusal message already names "the app may not be in English" as a cause, so the cheap protection is **already present** (title-pinned canary = fail-closed under locale drift). Doctrine: the closet-mini setup should pin `AppleLanguages -array en` for the Things app (add to setup.md); a dedicated explicit preflight locale assertion is an optional nicety recorded as a follow-up, not built, because the canary already refuses cleanly.

## Grant-recipe validation for the runbook (UIC1-d)

First end-to-end consumer of the AXVM1 grant recipe. It worked with **zero friction**: the disabled `kTCCServiceAccessibility | sshd-keygen-wrapper | 1 | 0` row auto-created on the first denied AX op; the Accessibility pane opened by URL showed the single toggle at the documented framebuffer coordinate (`1642 332`); the auth sheet took the password at (`1017 870`) and Modify Settings at (`1017 963`); `auth_value` flipped 0→2 and the menu-bar read returned `exit 0`, SIP still enabled. The one note for the runbook: the auth sheet's **username field is pre-filled** ("Managed via Tart", the account full name) so only the password is typed — the recipe already does this. No corrections needed to the AXVM1 recipe or the golden-runbook L3 layer; both are confirmed accurate.

**Operational finding (folded into the runbook):** heavy AX poking — repeatedly opening and cancelling dialogs, Get Info, etc. — can leave the Items menu in a degraded state where the `Repeat` submenu vanishes even with a repeating item selected. A **clean relaunch of Things restores it**. The certification suite relaunches Things before each op for menu health; the driver's `activate` step is not sufficient to recover a wedged menu. This is why the driver now runs its reveal/activate preamble **before** the canary (so the menu is populated for the selected target when the canary reads it) and settles ~1.5 s before resolving.

## Code changes this campaign (sanctioned)

- `src/write/vectors/types.ts` — new `select-popup` UI primitive.
- `src/write/vectors/ui.ts` — `axSelectPopupScript` (open pop-up + settle + click item), dispatch, and **reveal-before-canary** reorder with a post-reveal settle.
- `src/write/vectors/ui-recipes.ts` — `MAIN_WINDOW` (standard-window-by-subrole) replaces `window 1`; frequency step `set-value` → `select-popup`; interval field path corrected into the dialog group; convert/stop confirm buttons upgraded to `action-button-1`; stop recipe carries the card-open blocker note.
- `src/write/vectors/ui-certification.ts` — new `lab-certified` tier; 5 ops flipped to `lab-certified`, 2 kept `uncertified` with a `blocker`; profile records the Things build.
- `src/cli/commands/doctor.ts` — the ui certification line reports the lab-verified tier.
