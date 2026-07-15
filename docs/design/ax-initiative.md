# The AX initiative — Accessibility-driven ops: state, evidence, and the forward plan

Status: **ACTIVE ROADMAP** (written 2026-07-15, pre-compaction — this document is the durable plan; a fresh agent picks up HERE). Companions: [ui-vector.md](ui-vector.md) (shipped architecture), [../lab/uic1-certification.md](../lab/uic1-certification.md) (certification verdicts + the AX addressing catalog + the full Repeat-dialog field map), [../lab/axvm1-accessibility.md](../lab/axvm1-accessibility.md) (the VM grant recipe + background/lock verdicts), [../lab/ui-certification-runbook.md](../lab/ui-certification-runbook.md).

## Where things stand (2026-07-15)

Seven ui-vector ops shipped (PR #137), certified in-VM by UIC1 (PR #140): **lab-certified** — `todo.make-repeating`, `todo.reschedule-repeat`, `todo.pause-repeat`, `todo.resume-repeat`, `todo.convert-to-project`. **Blocked/uncertified** — `todo.stop-repeat` (the Stop popover is card-only; the card opens ONLY via mouse double-click; AXPress/Return fail) and `heading.convert-to-project` (`things:///show?id=<heading>` does not select headings). Both refuse fail-closed. Rule vocabulary is deliberately minimal (frequency + interval); the FULL dialog field map (day-of-week, monthly `last`/nth-weekday, yearly month, after-completion, Ends bounds, reminders, deadline/start-earlier) is captured in uic1-certification.md and ready to build against.

## Mike's rulings (2026-07-15)

1. **The project-view `…` menu is the expected unblocker for repeating-PROJECT ops** (his screenshots): `things:///show?id=<project>` opens the project view, whose title-adjacent `…` button opens a menu carrying **Repeat…** (plus Complete/When/Tags/Deadline/Move/Duplicate/Delete/Share). No sidebar row selection needed. Probe it (UIC2) before building.
2. **Create-repeating-project = a two-step emulation**: create a plain project via the quiet vectors, then promote it via `…` ▸ Repeat…. (There is no File ▸ New Repeating Project — UIC1.) Low usage expected; build for completeness.
3. **`stop-repeat` may simply be DROPPED** rather than fought for — especially given the crash below. Decide after UIC2.
4. **CRASH REPORT (Mike, live GUI, 2026-07-15 — unconfirmed, probe it)**: promote a project to repeating via `…` ▸ Repeat…, then `…` ▸ (repeat bar?) Stop + confirm, then attempt to SELECT the demoted project → **Things crashes**. Reproduce in a VM, capture the `.ips` from DiagnosticReports, characterize (crash on selection only? does the demoted project survive relaunch? data loss?), and file in oddities §7 (crash catalog) for the CC report.
5. **Sidebar AREA reorder is the next AX target** (project sidebar order already shipped via the bounce protocol; area order has NO automation spelling — P6/O13). Edge case to harden: a long sidebar SCROLLS — probe how scrolling interacts with drag simulation (AXScrollToVisible before drag; auto-scroll when the drop target is beyond the viewport).

## Inventory: locale reliance (UIC1 evidence)

Nearly ALL leaf actions are **title-pinned English** today: every menu item (Items menu, Repeat submenu, context menus, presumably the `…` menu) shares the generic `performCommand:` identifier; Repeat-dialog controls carry only volatile `_NS:NNN` numbers (the interval field's id even changes with the frequency). Locale-INDEPENDENT: the confirm-sheet buttons (`action-button-1` — the only semantic AXIdentifiers found), structural addressing (roles, `window 1`/`sheet 1`, index-in-parent), and the menu-bar top-level ids (`items`/`file`/`edit` — but not their leaves). Doctrine: **pin the app to English on the deployment machine** (`defaults write com.culturedcode.ThingsMac AppleLanguages -array en`) + the recipe canary's proven fail-closed refusal under locale drift (German negative test, UIC1-c). Optional follow-up: an explicit preflight locale check in the driver.

## Inventory: background operation (what works while Things is NOT frontmost)

| Tier | Mechanism | Evidence |
|---|---|---|
| **Proven background + under-lock** | menu-bar AX presses | AXVM1-d: pressed with Finder frontmost (focus stayed on Finder) and under a real `sysadminctl` lock |
| **Likely (same mechanism), unproven** | `…`-button press, popover items, dialog `set value`/press | probe in UIC2; wrinkle: the reveal step `open things:///…` ACTIVATES the app by default — probe `open -g` (reveal without activation) |
| **Foreground-bound today** | anything needing synthetic MOUSE: card double-click (todo.stop), drag-reorder (areas/tags) | the native helper may change this tier: `CGEventPostToPid` posts to the process, not to focus — background plausible, under-lock unknown (NATIVE1) |

## The plan — three probe campaigns, then builds

### UIC2 (VM campaign; ready to launch)
(a) **Project `…`-menu discovery + drive**: reveal a project via `open -g things:///show?id=<project>`; dump the `…` button's AX addressing (role/identifier/title) + its menu; drive `…` ▸ Repeat… end-to-end → certify `project.make-repeating` / `project.reschedule-repeat` / `project.pause-repeat` / `project.resume-repeat` if the recipes hold (same dialog per UIC1). Also record whether the `…` press works BACKGROUNDED and whether `open -g` avoids activation (feeds the background inventory).
(b) **Two-step create-repeating-project**: `project.add` (URL) then promote via (a) — validate as a composite.
(c) **CRASH1**: reproduce Mike's stop-then-select crash (ruling #4 above), capture `.ips`, characterize persistence/data-loss, file oddities §7. Verdict feeds ruling #3 (drop stop-repeat ops entirely?).
(d) Re-check `todo.stop-repeat` reachability via any newly-discovered surface; if none, recommend DROP per ruling #3.

### AXDRAG1 (VM campaign; after or parallel to UIC2)
Sidebar AREA reorder feasibility: dump the sidebar outline's AX tree (rows' roles, AXSelected settability, `AXScrollToVisible` support); attempt reorder via pure AX first (no drag action exists in standard AX — confirm); then the mouse-synthesis path (see NATIVE1) with the SCROLLED-sidebar edge cases: target row off-viewport (scroll-to-visible first), drop position beyond viewport (auto-scroll mid-drag), DB verification via the area index/order columns. Same mechanics scoped for TAG reorder (the Tags window; completes the canonical-tag-order story, PR #132). Reversibility: reorder ops are reversible via pre-rank capture (existing reorder undo pattern).

### NATIVE1 (spike; gates AXDRAG1's drag path and todo.stop)
The row-selection/mouse-synthesis primitive. Try in order: (1) **JXA ObjC bridge** (`osascript -l JavaScript` calling `AXUIElementPerformAction`/`CGEventPostToPid` — a "helper without a helper", no compiled binary, fits the v1 constraint); (2) a small compiled Swift helper if the bridge falls short. Probe: double-click synthesis on a list row (opens the card → unblocks todo.stop-repeat IF we keep it), drag synthesis (mouse-down/move/up to Things' pid), **backgrounded** behavior (does PostToPid avoid focus steal?), **under-lock** behavior, and TCC implications (CGEvent posting needs Accessibility — same grant, verify no second consent class).

### Builds (after probes; each rides the existing pipeline/gating/certification machinery)
1. **Repeating-project ops** (post-UIC2): the four manageable ops + the two-step create composite; certification in the same campaign pattern.
2. **Full rule vocabulary** for make/reschedule (to-do AND project): build directly against the UIC1 dialog field map — day-of-week toggles, monthly `last`/nth-weekday, yearly month, after-completion mode, Ends bounds, reminders checkbox, deadline/start-earlier offset. Extend the op params + reversibility notes (a richer vocabulary makes reschedule-undo *more* faithful — revisit its irreversible classification).
3. **`area.reorder-sidebar` + `tag.reorder`** (post-AXDRAG1/NATIVE1).
4. **Drop-or-keep decision on `todo.stop-repeat`/`project.stop-repeat`** per CRASH1 (Mike leans drop).

## Standing constraints (unchanged)
Two-key gating (`ui.enabled` + `--dangerously-drive-gui`), fail-closed everywhere (canary preflight, wait-for-element, no coordinates in production code — mouse synthesis via NATIVE1 targets AX-RESOLVED element positions, never guessed pixels), certification manifest discipline, VM lab per the AXVM1 grant recipe, English locale pin on targets, prod DB untouchable.
