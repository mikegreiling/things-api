# UIC3 — the mouse-hybrid build: repeating-PROJECT ops certified, make-repeating ruling-blocked, stop family dropped

**Verdict (2026-07-15):** the three repeating-**project** ops built on the mouse-synthesis driver — `project.reschedule-repeat`, `project.pause-repeat`, `project.resume-repeat` — are **LAB-CERTIFIED** end-to-end through the **production code path** (the shipped CLI with `--dangerously-drive-gui`) against **Things 3.22.11 / macOS 15.7.7 / DB v26**. The driver opens the project view's always-visible **repeat bar** (AX-resolved `text area 2` of the header cell) with a synthetic HID mouse click, then clicks the **AX-resolved popover item** (Change… / Pause / Resume), then drives the Repeat sheet with pure AX — every click targets a frame read from the live AX tree, never a guessed pixel. ~~**UIC3-a micro-probe verdict: NO** — selecting a project as a *row* does not surface **Repeat…** in the Items menu, so `project.make-repeating` + the two-step create composite stay **blocked-on-ruling** (the only remaining opener is the AX-nodeless `…` button).~~ **CORRECTED by UIC4 (2026-07-15, [uic4-project-selection.md](uic4-project-selection.md)):** projects **DO** render as selectable content rows in the area/Someday views, `AXSelectedRows` is **settable via pure AX**, and with a project so selected **Items ▸ Repeat… is present and enabled** — `project.make-repeating` is **unblocked with a pure-AX path** (see the strikethrough correction in §UIC3-a below). The **stop family was dropped** (build item 4): `todo.stop-repeat` removed, no `project.stop-repeat` built (CRASH1).

Ran in ONE disposable `--vnc-experimental` clone of `things-lab-golden-v1` (airgapped, clock-pinned 2026-07-05, SIP on), Accessibility granted via the AXVM1 rung-b user-path toggle (VNC), everything else over SSH. Ground truth = guest Things-DB row deltas (read-only SQLite) + the production CLI's own `--json` result envelope. Reproducible: [`lab/scripts/research-uic3.sh`](../../lab/scripts/research-uic3.sh) (probe + certification) and [`lab/scripts/research-uic3-disc.sh`](../../lab/scripts/research-uic3-disc.sh) (the AX discovery pass). Companions: [ax-initiative.md](../design/ax-initiative.md) (the build brief), [uic2-project-menu.md](uic2-project-menu.md) (the hybrid path + CRASH1), [native1-spike.md](native1-spike.md) (the JXA/HID primitive), [ui-vector.md](../design/ui-vector.md).

## UIC3-a — does row-selecting a project surface Repeat… in the Items menu? → ~~NO~~ **YES (corrected by UIC4)**

> **CORRECTION (2026-07-15, UIC4 — [uic4-project-selection.md](uic4-project-selection.md)):** the finding below is **wrong**, as Mike's screenshots said. In an **area's** list view (and the **Someday** view) a nested project **does** render as a **selectable content row** at the top of the content `AXTable` (below the area header) — the probe that reached this conclusion had clicked the *area-header* / a loose row, not the project row. Moreover `AXSelectedRows` on the content table is **settable by pure AX** (`AXUIElementIsAttributeSettable` → YES; a set returns `kAXErrorSuccess` and the selection lands), and with a project selected as a row **`Items ▸ Repeat…` is present and ENABLED**. So `project.make-repeating` has a **doctrine-clean, PURE-AX opener** (no `…` button, no guessed pixels) and is **background-capable with no focus steal**. The strikethrough text is retained for the record.

~~UIC2 found a project revealed via `things:///show` reports itself *selected* yet its Items menu has **no Repeat** (a shown project ≠ a selected to-do). The one unprobed route: select the project **as a row** (single HID click at its AX-resolved row center) inside its parent area, then read the Items menu.~~

~~**Finding:** the premise has no surface. In an area's list view the content `AXTable` rows are the area header + loose to-dos only — **a nested project does not render as a selectable content row** (it is a **sidebar** entry, `AXScrollArea` 2 / width 240, `d="LAB-REPEAT-WEEKLY-PROJ."`). The only row-handle a project has is its **sidebar row**, and clicking that *navigates to* (shows) the project — the exact state UIC2 already tested. Driving the probe confirmed it: after the click, `Things3 → get name of selected to dos` returned empty and the Items menu enumerated **When… / Move… / Tags… / Deadline… / Complete / Shortcuts / Get Info… / Convert to Project… / Remove From Parent / Remove From Contact / Reveal in List / Share… / Log Completed** — **no Repeat…** (`exists menu item "Repeat…" of menu "Items"` = **false**).~~ *(UIC4: this was the wrong row — a project row, when correctly targeted, selects and the Items menu **does** carry an enabled Repeat….)*

~~**Consequence:** `project.make-repeating` has **no doctrine-clean opener**. Reschedule/pause/resume/stop all live in the AX-resolvable repeat bar (only present once a project already repeats); *making a plain project repeat* is reachable only through the title-adjacent **`…` menu**, whose button is **not an AX node** (drawn inside the title text-area frame; its x is title-length-dependent — UIC2). A synthetic click there would need a **guessed offset**, which the vector's no-guessed-pixels doctrine forbids. So `project.make-repeating` and the two-step `project.add`→promote composite are **listed blocked-on-ruling** (back to Mike) — not built.~~ **Superseded:** `project.make-repeating` is now path-identified (pure-AX row-select → Items ▸ Repeat… → sheet). The two-step create composite is unblocked with it. See UIC4 for the recipe per taxonomy case (the area-less *anytime* case renders as a header in the Anytime view → right-click NSMenu, or a cleanup-free Someday coercion, then the pure-AX path).

## UIC3-b — the repeat-bar popover: AX discovery (corrected the provisional recipe)

The build shipped provisional element paths; the certification pass discovered the live structure and corrected one. Revealing the seeded repeating project `LAB-REPEAT-WEEKLY-PROJ` and dumping the standard window's AX subtree (JXA ObjC bridge, breadth-first — `entire contents` still aborts on Things' custom views) gives the header cell:

```
w2/0/0/0/0/0 AXTextArea v="LAB-REPEAT-WEEKLY-PROJ"          (title)       @372,94  531x27
w2/0/0/0/0/1 AXImage    d="TaskDetails RepeatSmall"                        @346,138 16x16
w2/0/0/0/0/2 AXTextArea v="Repeat every week on Sunday — …" (repeat bar)   @343,136 400x18
w2/0/0/0/0/3 AXTextArea                                     (notes)        @342,167 577x59
```

So the repeat bar = **`text area 2` of the header cell** (2nd `AXTextArea`; title is 1st, notes 3rd) — as UIC2 said. A synthetic HID click at its frame center opens the popover.

**The correction:** the popover is **NOT** `pop over 1` of the standard window. Dumping the window list right after the click shows a **new separate top-level `AXUnknown` window** (the same custom-window shape UIC2 found for the `…` menu):

```
== window 0 AXUnknown  @0,728  40x40      (hidden utility window)
== window 1 AXUnknown  @289,109 215x220   (the repeat popover)
     w1/0  AXScrollArea @345,164 103x110
     w1/0/3  AXUnknown d="Change…"     @355,171 82x18
     w1/0/8  AXUnknown d="Pause"       @355,204 82x18
     w1/0/13 AXUnknown d="Stop"        @355,227 82x18
     w1/0/18 AXUnknown d="Show Latest" @355,250 82x18
== window 2 AXStandardWindow @44,25 935x684
```

Two `AXUnknown` windows are open while the popover shows (the popover + the 40×40 utility window), so index-addressing is unreliable (UIC2). The recipe now addresses the popover by subrole **and** by *not* being the 40×40 utility window — `(first window whose subrole is "AXUnknown" and size is not {40, 40})` — and its items as `first UI element of scroll area 1 of <that window> whose description is "<Change…|Pause|Resume>"`. The as-shipped provisional `pop over 1 of MAIN_WINDOW` had failed the driver's post-click assertion (which correctly aborted fail-closed, dismissing the popover with Escape and mutating nothing) — the fix resolves it.

## UIC3-b — certification: the three ops through the production CLI

Each op run as the real shipped command (`node dist/cli/main.js project <verb> … --dangerously-drive-gui --json`) against the guest's Things, with the DB delta asserted read-only. All returned `ok: true` (`kind: "mutation-result"`) and matched UIC2-a's semantics:

| Op | Command | DB delta observed | Identity |
|---|---|---|---|
| **project.pause-repeat** | `project pause-repeat <p> --dangerously-drive-gui` | `rt1_instanceCreationPaused` 0→1, `rt1_nextInstanceStartDate` → NULL | preserved |
| **project.resume-repeat** | `project resume-repeat <p> …` | `rt1_instanceCreationPaused` 1→0, next restored (round-trips pause) | preserved |
| **project.reschedule-repeat** (weekly→monthly) | `project reschedule-repeat <p> --frequency monthly --interval 1 …` | same uuid; rule `fu` **256→8**, `of` `[{wd:0}]`→`[{dy:0}]` | preserved |

Semantics are identical to the to-do ops (shared recurrence codec + Repeat editor). `reschedule` preserves identity but is classified **irreversible** (the minimal frequency+interval vocabulary cannot restore an arbitrary prior rule); `pause`↔`resume` is the **reversible** pair.

**Negative / fail-closed test (once):** `project pause-repeat` on a **non-repeating** project (no repeat bar) returned `ok: false` (`kind: "error"`) and the project's `rt1_instanceCreationPaused` stayed `0` — the driver canaried the missing repeat bar and refused before any click, no mutation. Combined with the pre-fix run (where the wrong popover address aborted cleanly via Escape with no DB change), the vector's fail-closed contract holds at both the canary and the post-click assertion.

## Stop family (build item 4) — dropped

- **`todo.stop-repeat` removed** from the operation catalog / CLI (`things todo stop-repeat`) / MCP (`set_repeat_state` now `pause | resume` only) / certification manifest / reversibility + undo tables. It shipped blocked-uncertified in #137 and never worked: its Stop popover lives only on the open to-do **card**, reachable only by a mouse double-click, and UIC2-d re-confirmed no menu/AX surface exposes it.
- **No `project.stop-repeat` built.** The project Stop *works* (repeat bar ▸ Stop, an identity-replacement un-repeat), but **stopping then selecting the demoted project crashes Things** (CRASH1, reproduced 2/2 in UIC2-c → oddities §7 C5). Any future implementation must never auto-reveal the demoted result; it is parked, not shipped.

## Environment

Things **3.22.11** · macOS **15.7.7** · DB schema **v26** · golden `things-lab-golden-v1` (clock-pinned 2026-07-05). Accessibility granted via the AXVM1 rung-b user-path toggle (SIP on). CGEvent HID posting authorized by the Accessibility grant alone (NATIVE1-g).
