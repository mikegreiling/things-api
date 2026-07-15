# UIC2 — the project `…`-menu, repeating-PROJECT ops, and the stop-then-select CRASH

**Verdict (2026-07-15):** all four repeating-**project** repeat ops (`make-repeating`, `reschedule-repeat`, `pause-repeat`, `resume-repeat`) are **drivable and DB-verified** against **Things 3.22.11 / macOS 15.7.7 / DB v26**, but **only via a HYBRID path** — a synthetic **mouse** click to open Things' custom `…` menu / repeat-bar popover (those items expose `AXPress` but it is **inert** — AX-readable, not AX-actuatable), followed by **pure AX** to drive the Repeat **dialog sheet** (which is byte-identical to UIC1's to-do dialog and is fully AX-drivable, backgrounded, with no focus steal). The project **`…` button itself is not an AX node at all**. **CRASH1 is REPRODUCED and deterministic (2/2)**: stop-repeat on a project, then select the demoted project → `EXC_BREAKPOINT` (SIGTRAP) — but it is **transient** (gone after relaunch) with **no data loss**. `todo.stop-repeat` gains **no new surface** → **DROP** recommended.

Ran adaptively over SSH into ONE `--vnc-experimental` clone `things-run-uic2-20260715-131831` (golden `things-lab-golden-v1`, airgapped, clock-pinned 2026-07-05, Things 3.22.11 / macOS 15.7.7 / DB v26). Accessibility granted once via the AXVM1 user-path toggle (rung b, VNC-driven). Ground truth = guest Things-DB row deltas (read-only SQLite) + PID watch + `.ips` capture, corroborated by the VNC screenshot sequence under the run's artifacts dir (gitignored: `lab/artifacts/things-run-uic2-20260715-131831/`, `crash/` + `screens/`). Reproducible skeleton: [`lab/scripts/research-uic2.sh`](../../lab/scripts/research-uic2.sh). Companions: [ax-initiative.md](../design/ax-initiative.md) (the UIC2 brief), [uic1-certification.md](uic1-certification.md) (the to-do dialog field map + AX addressing catalog this extends), [axvm1-accessibility.md](axvm1-accessibility.md) (grant recipe + background/lock verdicts).

## AX-tree access gotchas (folded into the addressing method)

Two traps had to be solved before anything could be read (both extend UIC1's "window 1 is a hidden utility window" note):

- **`window 1` is the hidden 40×40 `AXUnknown` utility window** (0 children); the real UI is `first window whose subrole is "AXStandardWindow"`. When a `…` menu or repeat popover is open there are **three** windows (two `AXUnknown` + the standard one), so index-addressing is unreliable — always address by subrole.
- **`entire contents` returns 0 on Things' custom views** (the recursive traversal aborts silently on the sparse custom NSViews). You must walk `UI elements` **breadth-first** by hand. **And `AXEnhancedUserInterface = true` COLLAPSES the tree** (children → 0); it must be **false** (the default). Setting `AXManualAccessibility` errors −10006. This is a Things-automation gotcha worth remembering: do not "enhance" the AX interface — it hides everything.

## UIC2-a — the project `…` menu: discovery + drive

### `open -g` reveals + selects WITHOUT activating (background-inventory input)

`open -g "things:///show?id=<project-uuid>"` **reveals AND selects** the project (`Things3 → get name of selected to dos` returns the project title) **without activating Things** — `lsappinfo front` stayed **Finder** across the reveal. So the reveal step is background-safe (contrast the plain `open things:///…`, which activates). Note the URL scheme treats a project id as a selectable "to do" here (it opens the project's list view AND reports it as the selection).

### The `…` button is NOT an AX node

The project title lives in a **header `AXCell`** (row 1 of the content `AXTable` inside `scroll area 1` of the standard window). That cell holds: the **title `AXTextArea`** (actions: `AXShowMenu` only), a **notes `AXTextArea`**, and the **completion-circle `AXImage`**. **There is no `…` `AXButton`** — the ellipsis is drawn *inside the title text-area frame* (computed at AX≈540,108 for an 11-char title) with no discrete accessible element, no `AXIdentifier`, no press action. The three by-AX routes to a project menu all **fail**:

| Attempted AX route | Result |
|---|---|
| **Items menu bar** (project shown) | **No Repeat item.** Menu = When…/Move…/Tags…/Deadline…/Complete/Shortcuts/Get Info…/Convert to Project…/Remove From Project-Area/Remove From Contact/Show in Area/Log Completed. Confirms UIC1's parity note (a *shown* project ≠ a selected to-do). |
| **`AXShowMenu` on the title text area** | Opens the **text-edit** context menu (Look Up / Translate / Cut / Copy / Paste / Share… / Spelling…), not the project menu. |
| **Bottom-toolbar "More"** (`AXUnknown`, has `AXPress`) | **Inert** — it is a segmented stepper (`AXIncrement`/`AXDecrement`/`AXCancel`/`AXPress`); pressing does nothing. |

### The `…` menu opens only by synthetic mouse — but its items are AX-READABLE (not AX-actuatable)

A synthetic **mouse** click at the `…` position (framebuffer ≈1080,216 for an 11-char title; **the x-position is title-length-dependent**) opens the project menu. Once open it is a **separate `AXUnknown` window** (one `AXScrollArea` child) whose items are each an `AXUnknown` with a usable **`description`**, matching Mike's screenshots exactly:

> **Complete Project · When · Add Tags · Add Deadline · (sep) · Move · Repeat… · Duplicate Project · Delete Project · Share…**

**But `AXPress` on these items is INERT** — pressing "Repeat…" (and, separately, "Pause" in the repeat popover) does nothing; the menu stays open, no DB delta. The items are **AX-readable and their `AXPosition` resolves** (e.g. the repeat popover's "Stop" reports `AXPosition` ≈355,227 AX-pts), so a mouse-synthesis primitive can target an **AX-resolved** position (no guessed pixels) — but the actuation itself must be a synthetic click, never `AXPress`. This is the same custom-rendering wall UIC1 hit on list rows, one layer up: the menu is a custom-drawn popover, not an `NSMenu`.

### The Repeat DIALOG is a sheet and IS fully AX-drivable (byte-identical to the to-do dialog)

Clicking "Repeat…" opens the Repeat editor **as a sheet on the standard window** — the same editor the to-do path opens, with the **same** controls as UIC1's field map:

| Control | role | AXIdentifier | Notes |
|---|---|---|---|
| frequency pop-up | AXPopUpButton | `_NS:116` | options: `after completion` · (sep) · `daily` · `weekly` · `monthly` · `yearly`. **Default for a project = `after completion / 1 week`.** Drive via **select-popup** (AXPress → click menu item), not `set value`. |
| interval field | AXTextField | `_NS:41` | positional (`_NS` regenerates per layout) |
| unit pop-up (after-completion mode) | AXPopUpButton | `_NS:8` | day/week/month/year |
| Add reminders / Add deadlines | AXCheckBox | `_NS:177` / `_NS:171` | future vocab |
| OK / Cancel | AXButton | `_NS:164` / `_NS:157` | title-pinned `OK` / `Cancel` |

The sheet controls **are** AX-actuatable (unlike the menu popover). Select-popup + interval + OK all land via pure AX, and — verified with **Finder frontmost** — **backgrounded with NO focus steal** (the frequency select-popup and the OK press both actuated while Finder stayed frontmost). This confirms AXVM1's background verdict for this dialog.

### Certified: the four repeating-PROJECT ops (DB-verified, hybrid path)

Each op = synthetic-click to open the `…` menu / repeat-bar popover (item positions AX-resolved) + AX for the sheet. All DB-verified against `TMTask`:

| Op | Trigger surface | DB delta observed | Identity |
|---|---|---|---|
| **project.make-repeating** (weekly) | `…` ▸ Repeat… → sheet weekly → OK | original uuid **hard-deleted**; NEW template `rt1_recurrenceRule` `fu`=256 weekly, `of`=[{wd:0}] (Sun) + spawned instance (both `type=1`) | **identity replacement** (matches to-do make-repeating) |
| **project.reschedule-repeat** (weekly→monthly) | repeat bar ▸ **Change…** → sheet monthly → OK | **same uuid**; rule `fu` 256→8, `of` [{wd:0}]→[{dy:0}] | **identity preserved** |
| **project.pause-repeat** | repeat bar ▸ **Pause** | `rt1_instanceCreationPaused` 0→1, `rt1_nextInstanceStartDate` cleared to NULL | identity preserved |
| **project.resume-repeat** | repeat bar ▸ **Resume** | paused 1→0, next restored; round-trips pause | identity preserved |

Semantics are **identical to the to-do ops (UIC1-a)** — the repeat editor and the recurrence codec are shared.

### Repeat-management SURFACE differs: project = always-visible repeat bar (no card)

A key asymmetry vs. to-dos:

- A **repeating project's `…` menu is REDUCED** to When / Add Tags / Move / Delete Project / Share… — **no Repeat / Complete / Duplicate**.
- Reschedule / Pause / Resume / **Stop** all live in an **always-visible repeat bar** in the project view ("↻ Repeat every week on Sunday — Jul 12, Jul 19, Jul 26, …"). Clicking it opens a popover **[Change… · Pause↔Resume · Stop · Show Latest]** — the *project analog of the to-do card's repeat-bar popover (UI2-i)* — **but with NO card double-click**: the bar is right in the project view.
- The **repeat bar IS AX-resolvable** (it is `text area 2` of the header cell, AX≈343,136, action `AXShowMenu` only); the popover items are AX-readable + position-resolvable but, like the `…` items, **not AX-actuatable** (`AXPress` on "Pause" was inert).

### Background inventory (feeds ax-initiative.md)

| Step | Backgroundable? | Evidence |
|---|---|---|
| reveal `open -g things:///show?id=<project>` | **YES — no activation** | frontmost stayed Finder |
| open the `…` menu / repeat bar; pick a menu/popover item | **NO — synthetic MOUSE at a screen coordinate** (foreground/visible-bound; `AXPress` is inert) | AXPress inert on Repeat… and Pause; only VNC coordinate clicks actuated |
| drive the Repeat **dialog sheet** (select-popup, interval, OK) | **YES — no focus steal** | drove weekly + OK with Finder frontmost |
| **Stop** confirm-sheet button (`action-button-1`) | **YES — standard sheet button, AX-actuatable** | AX `click button "Stop"` landed |

**Net:** the project repeat ops are **not pure-AX** — they need a mouse-synthesis primitive (NATIVE1 / VNC) to open+navigate the custom `…` menu and repeat-bar popover, which is **foreground-bound**. The dialog half is pure AX and backgroundable. The menu/popover items' positions are AX-resolved (so synthesis can avoid guessed pixels), **except the `…` button itself, which has no AX node** — make-repeating on a *plain* project needs the `…` whose position is title-length-dependent (the reschedule/pause/resume/stop ops all use the AX-resolvable repeat bar instead, so they are cleaner to synthesize).

## UIC2-b — two-step create-repeating-project (validated)

`things:///add-project?title=UIC2-PROJ-A` (URL scheme, no auth token) created a plain `type=1` project; promoting it via UIC2-a's `…` ▸ Repeat… → weekly produced a repeating **template** (`fu`=256) + a spawned **instance**, original uuid gone. The composite works end-to-end. (There is no "New Repeating Project" — UIC1.)

## UIC2-c / CRASH1 — stop-then-select CRASH (REPRODUCED, deterministic 2/2)

**Sequence (Mike's report, now confirmed):** promote a project to repeating → open the repeat bar → **Stop** → confirm → then **select the demoted project** via `open "things:///show?id=<demoted-uuid>"` → **Things crashes**.

- **Stop is an identity-replacement un-repeat** (parallels UI2-i for to-dos): the template uuid is **hard-deleted** and replaced by a **NEW plain `type=1` project** (`rt1_recurrenceRule` NULL); the already-spawned instance survives. The confirm sheet reads **"Stop To-Do from Repeating / Are you sure you want to stop this to-do from repeating?"** — hardcoded **"to-do"** copy even for a project (minor app copy bug).
- **The crash is on SELECT, not on Stop:** PID stayed alive immediately after the Stop confirm; it died only on the subsequent `things:///show` of the demoted project.
- **Signature: `EXC_BREAKPOINT` (SIGTRAP, "Trace/BPT trap: 5")** — a Swift runtime trap, faulting thread 0, top frames in `ThingsModel` + `Things3` (symbols stripped). Same crash *family* as oddity §1 (URL `when=` on repeating items) and §7 C4. Two `.ips` captured, identical signature: `Things3-2026-07-05-124623.ips`, `Things3-2026-07-05-125703.ips` (banked under `lab/artifacts/things-run-uic2-20260715-131831/crash/`, gitignored).
- **TRANSIENT, not persistent:** after relaunch, **re-selecting the same demoted project does NOT crash** (PID stable, no new `.ips`). It is a one-time in-session crash — a stale in-memory reference to the just-deleted template, cleared by a fresh launch.
- **No data loss:** both demoted projects survived every crash untrashed (`trashed=0`, `status=0`, `rule=NULL`); the app relaunches to the default view fine and the demoted project is then fully selectable/usable.
- **Reproduced 2/2** on two independent projects (`A8J1SuV3rEuwX61adgb7Xf`, `3enMdoEmdbr6cguYNvmFkJ`). The AX-press-on-sidebar-row selection path is N/A (sidebar rows are not AX-addressable, UIC1); the repro uses `things:///show`.

Report-ready write-up: [things-app-oddities.md §7](../things-app-oddities.md) (crash catalog, new row C5).

**Consequence for ops:** this hardens Mike's ruling #3 lean-to-drop for the whole stop family. If a `project.stop-repeat` op is ever built it MUST NOT auto-select the demoted result in the same session (the crash is triggered by exactly that), and should return the new plain-project uuid via DB diff without a reveal.

## UIC2-d — `todo.stop-repeat` reachability re-check → DROP

No new surface. A repeating **to-do** selected via `things:///show` exposes **Items ▸ Repeat = Reschedule… / Pause / Show Latest** — **no Stop** (unchanged from UI2-i / UIC1). The project's always-visible repeat bar has **no to-do analog**: a to-do is a list row whose repeat bar lives only in the **card**, which opens only on a genuine mouse **double-click** (AX cannot synthesize it; list rows expose no press/open action — UIC1). So the to-do Stop remains card-double-click-only. **Recommendation: DROP `todo.stop-repeat`** (Mike's ruling #3). If ever pursued it would ride the NATIVE1 double-click primitive, not any surface found here.

## New oddities recorded (see things-app-oddities.md)

- **§7 C5** — the stop-then-select project crash (this doc).
- **§8j** — the Stop confirm sheet hardcodes "to-do" copy for projects; the repeating-project `…` menu drops Repeat/Complete/Duplicate and moves repeat-management to an always-visible repeat bar; Things' custom `…`/popover menu items expose `AXPress` but it is inert (AX-readable, not AX-actuatable); `AXEnhancedUserInterface=true` collapses Things' AX tree.

## Environment

Things **3.22.11** · macOS **15.7.7** · DB schema **v26** · golden `things-lab-golden-v1` (clock-pinned 2026-07-05). Accessibility granted via the AXVM1 user-path toggle (SIP on).
