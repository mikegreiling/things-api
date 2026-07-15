# UIC4 — project row-selection: `project.make-repeating` is PURE-AX (UIC3-a corrected)

**Verdict (2026-07-15):** `project.make-repeating` is **unblocked and has a doctrine-clean, PURE-AX production path** against **Things 3.22.11 / macOS 15.7.7 / DB v26**. **UIC3-a was WRONG** (as Mike's 2026-07-15 screenshots said): a nested project **does** render as a **selectable content row** in its area's list view and in the Someday view, and **`AXSelectedRows` is SETTABLE purely via AX** (`AXUIElementIsAttributeSettable` → YES; a set returns `kAXErrorSuccess` and selection lands) — so a project can be selected as a row **with zero mouse input**, and with it selected **Items ▸ Repeat… is present and ENABLED**. Driving `select-row (AX) → Items ▸ Repeat… (AX) → Repeat sheet (AX)` makes `project.make-repeating` **100% pure-AX and background-capable with no focus steal** — strictly better than the mouse-synthesis `…`-menu hybrid the other project ops use. The one taxonomy gap: an **area-less _anytime_ project renders as a group HEADER in the Anytime view (no selectable row)** — reachable either by a **right-click on that header** (a real NSMenu, keyboard-driven) or by a **cleanup-free coercion to Someday** (quiet URL vector) then the pure-AX row path.

Ran in ONE disposable clone `uic4-lab` of `things-lab-golden-v1` (airgapped, clock-pinned 2026-07-05, SIP on), Accessibility granted via the AXVM1 rung-b VNC toggle, everything else over SSH. Ground truth = guest Things-DB row deltas (read-only SQLite) + `Things3 → get name of selected to dos` + live AX-tree reads (NATIVE1 JXA ObjC bridge). Reproducible: [`lab/scripts/research-uic4.sh`](../../lab/scripts/research-uic4.sh). Companions: [uic3-build-certification.md](uic3-build-certification.md) (the corrected UIC3-a), [uic2-project-menu.md](uic2-project-menu.md) (the `…`-menu hybrid + repeat-sheet field map), [native1-spike.md](native1-spike.md) (JXA bridge + HID synthesis), [axvm1-accessibility.md](axvm1-accessibility.md) (AX grant + background/lock verdicts).

## Seed taxonomy (URL scheme)

Three area-less/area × anytime/someday projects, each with two to-dos, plus the golden's spare `LAB-AREA-B`:

| Project | uuid (original) | placement | `start` |
|---|---|---|---|
| **P1** | `9TanMNTBcZgQaCP38dRc62` | in `LAB-AREA-A` | 1 (anytime) |
| **P2** | `8buQy4iYjkN5vzoKkBQ5Vi` | area-less | 2 (someday) |
| **P3** | `WVsaL9tTK13bZifMAGi7Lh` | area-less | 1 (anytime) |
| **P4** | `MuJ8khSCv2ZFGeHeu3dQ8C` | area-less | 1 (anytime) — added for the header case |

(`TMTask.start`: 1 = anytime, 2 = someday — confirmed against seeds `LAB-ANYTIME-1`=1, `LAB-SOMEDAY-1`=2.) The three golden area-A projects (`LAB-PROJ-PLAIN`, `LAB-PROJ-HEADINGS`) doubled as extra subjects.

## UIC4-a — is `AXSelectedRows` SETTABLE purely via AX? → **YES** (the biggest prize)

Reveal the area (`open things:///show?id=<area>` + activate; **no** click), resolve the content `AXTable` (the wide `AXScrollArea`'s table), and probe its `AXSelectedRows`:

- `AXUIElementIsAttributeSettable(table, "AXSelectedRows")` → **YES**. `AXSelected` on the row element itself is also reported settable=YES.
- `AXUIElementSetAttributeValue(table, "AXSelectedRows", NSArray[projectRow])` → **returns `0` (`kAXErrorSuccess`)** and the selection **lands**: `Things3 → get name of selected to dos` returns the project's title, and `AXSelectedRows.count` → 1 with the row's frame.
- With the project thus selected **by pure AX**, `menu item "Repeat…" of menu "Items" of menu bar 1` **exists AND is `enabled=true`**, and the view does **not** navigate into the project (content header stays the area; `selname` stays the project).

This is a genuine new capability: NATIVE1/AXVM1 proved `AXSelectedRows` only **reads**; UIC4 proves it also **writes**. It removes the need for any mouse click to select a project. (`AXSelected := kCFBooleanTrue` on the row returned `-25201` from the JXA bridge — a bridging-argument wart, not a settability limit; the table-level `AXSelectedRows` array-set is the working route.)

**Background:** setting `AXSelectedRows` with **Finder frontmost** (project revealed via `open -g`) lands the selection and **frontmost stays Finder** — no focus steal.

## UIC4-b — click-to-select in the AREA view (UIC3-a re-probe) → projects ARE rows

In `LAB-AREA-A`'s list view the content `AXTable` is: **row 0 = area header** (83 pt tall, title `AXTextArea`), row 1 = a blank spacer, **rows 2…n = the nested PROJECTS**, each a 28 pt `AXRow` → `AXCell` bearing only `AXImage`s (completion circle @x≈319, a 20×20 progress-pie @x≈343) — **no title text is AX-exposed on the row** (identical to loose-to-do rows; identification is positional/by-selection, not by descendant `AXStaticText`). Mapping by AX-select: row 2 = UIC4-P1, row 3 = LAB-PROJ-HEADINGS, row 4 = LAB-PROJ-PLAIN. **So the UIC3-a premise — "a nested project does not render as a selectable content row" — is false.**

**Pure-AX make-repeating (foreground), DB-verified on P1:** reveal area → `AXSelectedRows := [P1 row]` → `click menu item "Repeat…" of menu "Items"` → drive the sheet (frequency select-popup `after completion → weekly`, OK). Result: original `9Tan…` **hard-deleted**; new **template** `59zEizyqqGDe78hFx1HB6o` (`rt1_recurrenceRule` `fu`=256 weekly, `of`=[{wd:0}] Sun, `tp`=0) + spawned **instance** `FP3NYt6EZJWpxbKwMcS8s1`; **area `LAB-AREA-A` preserved on both**; both `start`=2. Semantics match UIC2-a exactly — but reached with **zero mouse input**.

**The literal click path (Mike's screenshots), confirmed on LAB-PROJ-HEADINGS:** a synthetic HID single-click (NATIVE1) at the AX-resolved row center (631,242) → row **highlights** (`AXSelectedRows.count`=1 at that frame, `selname`=LAB-PROJ-HEADINGS), the app does **NOT** navigate (content header stays `LAB-AREA-A`), and **Items ▸ Repeat… appears**. Exactly the screenshot behavior. **Foreground-bound:** repeating the HID click with **Finder frontmost** (a project pre-selected) **did not move the selection** — it only **raised Things to frontmost** (focus steal), per NATIVE1-e. So the click path is strictly more disruptive than UIC4-a's pure-AX select.

**Background pure-AX make-repeating, DB-verified on LAB-PROJ-PLAIN:** the *entire* path — `AXSelectedRows :=` + `Items ▸ Repeat…` press + sheet drive — actuated with **Finder frontmost throughout (no focus steal)**, producing a repeating template (`fu`=256) + instance, area preserved. **Wrinkle (oddity):** when Things is backgrounded the Repeat editor presents as a **detached top-level `AXUnknown` window** (System Events `window 1`; frame ≈252,139 520×233), **not** an attached `AXSheet` on the standard window — so the driver must address it by shape (`first window whose subrole is "AXUnknown" and size is not {40, 40}`; controls are direct children: `pop up button 1 of window 1` = the frequency mode) instead of `sheet 1 of <standard window>`. Foreground it is a normal attached `AXSheet`.

## UIC4-c — SOMEDAY view + the someday question → someday is MOOT

In the Someday view P2 renders as an **ordinary selectable content row** (row 2, below the "Someday" header). AX-select → Repeat… enabled → drive weekly → OK: original `8buQy…` deleted, template `YQZb42RA9xJfHXyowqGVSx` (`fu`=256) + instance `No4GoYxEbUAsLibTTfXUfZ`, **both area-less preserved**.

**The three questions, answered by the DB:**

1. **Does "someday" survive on the TEMPLATE, or is it wiped?** — **Neither — the question is moot.** `make-repeating` **normalizes every project to `start`=2** (the standard repeating bucket) **regardless of prior state**: P1/LAB-PROJ-PLAIN/LAB-PROJ-HEADINGS were all **anytime** yet their templates+instances are `start`=2, exactly like P2 (someday origin) and the golden's app-made `LAB-REPEAT-WEEKLY-PROJ` (also `start`=2). So the prior anytime/someday `start` is **replaced** by the repeating-standard bucket; there is no "survives vs. wiped" fork.
2. **Where does the spawned INSTANCE land?** — `start`=2 **with a `startDate`** (e.g. 132805248 = the next Sunday, "Jul 12" for a weekly-Sunday rule), i.e. **scheduled → it appears in Upcoming** (confirmed on-screen). The template carries `start`=2 with `startDate` NULL (lives in the recurrence machinery).
3. **Is area/area-less preserved through conversion?** — **YES.** P2 stayed **area-less** on both template and instance; the area-A projects kept `area=LAB-AREA-A`. Area is the one placement attribute preserved; `start` is not.

**Verdict:** temporary someday-coercion for an area-less project is **CLEANUP-FREE** — because `make-repeating` discards the prior `start` and writes `start`=2 anyway, a coerced-to-someday project ends **identical** to one made repeating directly.

## UIC4-d — the area-less ANYTIME project (P3), coercion end-to-end

**P3 has no selectable project row in the Anytime view.** Scanning every Anytime content row by AX-select found no row that selects as UIC4-P3; the view renders an area-less anytime project as a **group HEADER** (bold title + progress circle) with its to-dos beneath (the "Image 22" pattern). So the row-select path can't reach it there.

**Coercion (quiet URL vector, the repo's canonical spelling):** `things:///update-project?id=<P3>&when=someday&auth-token=<TMSettings.uriSchemeAuthenticationToken>` → P3 `start` 1→2, now visible in Someday. Then the UIC4-c pure-AX path: select P3's Someday row → Repeat… → weekly → OK → template `Rsgrh8tKUGb33869u5uM1s` + instance `9m6sLaQiqiMNnjJQ2LYxVu`, both area-less, both `start`=2. **Identical to a directly-made repeating project → the someday state left NO residue → cleanup-free.**

**Are repeating templates "harder to edit" (Mike's question)? — YES, confirmed:**

| Cleanup attempt on the template | Result |
|---|---|
| `things:///update-project?id=<template>&when=anytime&auth-token=…` | **silent no-op** — template `start` stayed 2 |
| AppleScript `move (to do id "<template>") to list "Anytime"` | **error 301** ("Cannot move to-do") |

A repeating template **refuses** quiet-vector schedule/list moves. This is **moot for the coercion** (nothing needs restoring — the conversion already normalized `start`=2). It only bites if you want to *re-home a template's schedule after the fact*, for which the quiet vectors are dead ends (the in-app When…/repeat-bar UI would be needed).

**But coercion is unnecessary** — see UIC4-e: an area-less anytime project can be made repeating **in place** in the Anytime view via the right-click header, with no move at all.

## UIC4-e — right-click context menu → REAL NSMenu, but AX-opaque

A synthetic **right-click** (NATIVE1 HID, button=right) opens a context menu in two places, each a **genuine native `NSMenu`** (system styling, a `Services ▸` submenu) that **contains `Repeat…`**:

- **on a project ROW in the AREA view** (LAB-PROJ-HEADINGS): `Open · Open in New Window · When… · Move… · Tags… · Deadline… · Complete▸ · Shortcuts▸ · Repeat… · Get Info… · Duplicate Project · Delete Project · Remove From Area · Show in Area · Share… · Log Completed · Services▸`.
- **on the area-less project HEADER in the ANYTIME view** (P4, the Image-22 case): the same menu, with **`Remove From Project/Area` and `Show in Area` disabled** (area-less).

**Is it AX-drivable? NO.** While the menu is open its **modal tracking loop blocks synchronous AppleScript AX traversal** (`entire contents of <window>` hangs — the tell that first hung the driver), and the menu is **not published to the AX tree**: a JXA walk of the app's children while it is open shows only the utility window, the standard window, and the menu bar — **no `AXMenu`/`AXMenuItem` node** (`menu 1 of window 1` → `-1728`). So there is **nothing to `AXPress`**, and item frames can't be AX-resolved to click. It **is** drivable by **keyboard typeahead** (post `keystroke "repeat"` + Return via System Events, which the tracking loop consumes) — coordinate-free but **English-title-pinned** and **foreground-bound** (HID right-click + NSMenu are both foreground/visible-only).

**Driven end-to-end (evidence, both surfaces):** right-click → typeahead `repeat` + Return → sheet → weekly → OK.
- Area-row path on **LAB-PROJ-HEADINGS**: `Dwr1M…` deleted → template `S3zq8hJUBBvZ2aLiXw2DHu` + instance, area preserved.
- Anytime-header path on **P4**: `MuJ8k…` deleted → template `UsQJQotpzJLGVm29LGvrhF` + instance `GWVHRMy7ZUXaQAdQek49gf`, area-less preserved.

The right-click header path is the clean, in-place opener for the area-less-anytime case (no coercion), at the cost of being foreground-bound and keyboard-title-pinned.

## UIC4-f — recommended production recipes for `project.make-repeating`

Ranked by the doctrine (**pure AX > one AX-resolved click + AX menu > right-click NSMenu > coercion**). All four resolve to the same Repeat sheet (UIC2 field map: frequency `after completion`→`weekly` via **select-popup**, interval field, `OK`); identity-replacement semantics + DB-diff to resolve the new template uuid are unchanged from UIC1/UIC2.

| Taxonomy case | Recommended recipe | Rank / notes |
|---|---|---|
| **Project in an AREA** (P1) | **PURE AX:** reveal area (`open -g things:///show?id=<area>`) → `AXSelectedRows := [project row]` → `Items ▸ Repeat…` (AX press) → drive sheet (AX). | **#1. Background-capable, no focus steal.** Detached-window wrinkle when backgrounded (address the dialog by `subrole AXUnknown, size ≠ {40,40}`). |
| **Area-less SOMEDAY project** (P2) | **PURE AX**, same as above but reveal the **Someday** view. | **#1. Background-capable.** |
| **Area-less ANYTIME project** (P3) — no row in Anytime | **(a)** foreground: **right-click the Anytime header** → typeahead `Repeat…` → drive sheet. **(b)** headless/background: **coerce to Someday** (`update-project?when=someday&auth-token`) → pure-AX Someday path → done (**cleanup-free**; the temp someday state is consumed by the conversion). | **(a) #3** foreground/keyboard-pinned; **(b) #1-equivalent** for a background host. Avoid the "temp area" variant — a template resists area-removal via quiet vectors. |
| **Two-step create composite** (`things:///add-project`) | `add-project` yields an **area-less anytime** project → apply the **P3** case. (Create with `&when=someday`, or `&area(-id)=…`, to land directly in the P2/P1 case and skip the header problem.) | Prefer seeding `when=someday` at create time → then the pure-AX path applies with no coercion or right-click. |

**Background-capability summary:** the pure-AX select+menu+sheet chain (cases A/B and C-b) actuates **backgrounded with no focus steal** (set-selection, AX menu press, and sheet drive all confirmed with Finder frontmost). The HID click-select and the right-click NSMenu (case C-a) are **foreground-bound and focus-stealing** (NATIVE1). `make-repeating` therefore joins pause/resume in the **least-disruptive (pure-AX, backgroundable)** tier for the area/someday cases — a better profile than the reschedule/pause/resume ops, which still ride the mouse-synthesis `…`/repeat-bar popover.

**Status change:** `project.make-repeating` moves from **blocked-on-ruling** to **path-identified (pure-AX)** — buildable, and cleaner than the shipped project repeat ops. Not built here (probe-only).

## New oddities (see [things-app-oddities.md](../things-app-oddities.md))

- Repeat editor **detaches to a floating top-level `AXUnknown` window** when the app is backgrounded (vs. an attached `AXSheet` when frontmost).
- The project **right-click context menu is a real `NSMenu` but is NOT exposed to the AX tree** (no `AXMenu` node; `entire contents` blocks in its tracking loop) — AX cannot drive it; keyboard/mouse only. (Contrast UIC2's custom `…` menu, which *is* AX-readable but inert to `AXPress`.)
- Repeating **project templates refuse quiet-vector schedule edits** — `things:///update-project?when=…` is a silent no-op on the template's `start`; AppleScript `move … to list` → **error 301**.
- `make-repeating` **normalizes `start` to 2** (template + scheduled instance), discarding the project's prior anytime/someday bucket — **area is preserved, `start` is not**.

## Environment

Things **3.22.11** · macOS **15.7.7** · DB schema **v26** · golden `things-lab-golden-v1` (clock-pinned 2026-07-05). Accessibility granted via the AXVM1 rung-b user-path toggle (SIP on). One disposable clone `uic4-lab`, stopped + deleted at teardown.
