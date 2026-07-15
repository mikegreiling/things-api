# The "ui" write vector — Accessibility-driven GUI mutations

The FOURTH write vector (after URL scheme / AppleScript / Shortcuts), and the **most-disruptive tier**. It exists for the handful of transforms Things exposes on **no headless surface at all** — making an item repeat, editing/pausing/resuming/stopping a repeat rule, and to-do/heading → project conversion — the operations the UI1/UI2/UI2-i lab campaigns proved are reachable ONLY by driving the real Things GUI ([ui-vector-research.md](../lab/ui-vector-research.md)).

This is the transform-loud half of the **hybrid create-quiet / transform-loud doctrine**: keep create and edit on the quiet vectors (tier 0, no focus steal), and reach for GUI driving ONLY for the transforms with no other spelling. Ratified by Mike 2026-07-14: **BUILD, Accessibility-API-only, closet-mini target.** The seven ops ship, but every one ships **UNCERTIFIED** (see [Certification-status machinery](#certification-status-machinery) below) pending a one-time real-hardware sitting ([ui-certification-runbook.md](../lab/ui-certification-runbook.md)).

## The AX-only ruling

The driver is the **macOS Accessibility API only** — the same AXUIElement tree a screen reader walks — reached through `osascript` talking to **System Events**. There are **NO coordinate clicks and NO screenshot interpretation** anywhere in production code.

Recipes are **semantic element paths**, e.g. `menu item "Pause" of menu 1 of menu item "Repeat" of menu "Items" of menu bar 1` or `button "Convert" of sheet 1 of window 1`, acted on via `AXPress`/`click`, never by moving a cursor to an (x, y). This is the whole point: an element path either resolves against the live tree or it does not, so the vector is **bulletproof = fail-closed**. Nothing is pressed on a guess. A coordinate click, by contrast, always "succeeds" mechanically and lands wherever the geometry happens to put it — there is no way for it to refuse.

### Why VNC stayed lab-only

The research heritage is VNC synthetic input (hardware-level HID to absolute screen coordinates). UI1, UI2, and UI2-i were all driven that way in disposable VMs — at the time we believed Accessibility was unusable there (UI1 saw `osascript` → System Events return −1719 in the golden). **AXVM1 (PR #136) later falsified that**: Accessibility IS grantable inside a Tart guest (SIP stays on; a one-time user-path TCC toggle, persists across reboot), and element presses by name steal no focus and work under a locked session. So VNC is no longer needed even in the lab. It stays lab-only in production anyway: coordinate-and-geometry-based input cannot fail closed (a moved control is silently mis-clicked), whereas semantic AX addressing resolves-or-refuses. VNC did its job as a *discovery* tool and its findings (identity semantics, confirmation sheets, the card-only Stop surface) transfer directly to the AX recipes.

But VNC does **not** appear in production code, and never will. It is coordinate-based and geometry-fragile: a click is aimed at a pixel derived from a specific framebuffer resolution and a specific menu layout, so any window move, resolution change, or Things UI reshuffle silently mis-clicks. It cannot fail closed — every click "works." AX semantic addressing is the opposite: it addresses controls by role/title/identifier, survives layout changes, and refuses cleanly when an element is missing. So the production vector is AX-only; VNC lives in `lab/` as the research substrate that got us here.

## The driver seam — primitives, one osascript shape each

The vector is built from a small set of **primitives**, each a single stable `osascript` + System Events command shape (the "one stable command shape" discipline the prod-read and doctor code already follow, so we never present macOS with a novel binary that re-triggers a TCC prompt):

| Primitive | Purpose | Shape (conceptual) |
|---|---|---|
| `resolve-element` | Preflight: does this semantic path exist in the live tree right now? | `exists <element-path>` → boolean |
| `press` | Actuate a resolved element | `AXPress` / `click <element-path>` |
| `set-field-value` | Type into a text field (repeat dialog interval) | `set value of <text field> to "<n>"` |
| `key` | Arrow-key dropdown selection + Escape/Cancel | `key code …` / `keystroke` into the frontmost element |
| `wait-for-element` | Poll for an async element (sheet/popover) with a timeout | loop `resolve-element` until present or deadline |
| `reveal` | Select the target so the menus/card address it | `things:///show?id=<uuid>` (URL scheme, NOT AX) |
| `activate-app` | Fallback: bring Things frontmost so the menu bar is Things' | `open -a Things3` / `tell app "Things3" to activate` |

Two seam notes for the code author:

- **`reveal` is a URL-scheme step, not an AX step.** Selection is done by bouncing `things:///show?id=<uuid>` (the same deep link the read layer already emits), which selects the row and, for the card-only Stop recipe, is followed by AX steps to open the card. This keeps target selection off the fragile "find and click the right row" path entirely.
- **`activate-app` is a *fallback*, gated on the open certification question.** The recipes include an activate-Things preamble, but it is **skipped if background AXPress proves out** during the sitting (see the open question below). We do not want to foreground Things if we do not have to.

The `key` primitive exists because the Repeat dialog's frequency **dropdown is picked with keyboard arrows** (`key down` ×N + return), never a second press — a press fires before the popup renders and lands on the control beneath (learned in UI2-i, folded into the recipe).

### Native AXUIElement bindings — DEFERRED follow-up

Driving AX through `osascript`/System Events is the v1 seam because it needs no compiled artifact and reuses the stable-command-shape discipline. A **compiled helper with native AXUIElement bindings** (direct `AXUIElementCopyAttributeValue`/`AXUIElementPerformAction`, no AppleScript hop) is an explicitly **deferred** follow-up: faster, less brittle around AppleScript's System Events quirks, and a cleaner home for background AXPress if it proves out — but it is a codesigned-binary distribution problem (mirrors the roadmap's "compiled `things` binary" TCC-stability item) and is out of scope for shipping the vector. The osascript seam is designed so the driver primitives are the abstraction boundary: swapping in native bindings later is a driver-internal change, not a recipe or op change.

## Recipes as data, provisional pending certification

Each op's recipe is **geometry-free DATA** — an ordered list of steps, each naming a primitive, a semantic element path, and its addressing mode — not imperative code. Recipes live as data so they can be re-verified and re-pinned during the certification sitting and any future Things-update recert (the same "matrix is data, not code" principle the other vectors follow). **Every recipe ships marked `provisional-pending-certification`**: the paths below are the *intended* addressing derived from the VNC discovery campaigns; the sitting confirms each path against the live AX tree and captures any AXIdentifiers.

The fail-closed machinery around the recipe data:

1. **Recipe canary preflight.** Before ANY driving, the driver resolves every **statically-reachable** element path the recipe touches — the menu-bar paths (Items ▸ Repeat ▸ …, Items ▸ Convert to Project…). Any unresolvable element = a **clean refusal that names the missing element**, with the likely cause spelled out (a Things update changed the menu, Accessibility not granted, or Things not running). **Nothing is pressed on a partial resolution.**
2. **Wait-for-element with timeout for async UI.** Elements that only exist after an action (confirmation **sheets**, the repeat **dialog**, the card **popover**) are marked `dynamic` in the recipe and cannot be canary-checked up front. The driver polls for each with a timeout; **on timeout it aborts via AX Escape/Cancel and reports partial state honestly** — which steps ran, which did not.
3. **Localization pinning.** Element titles are **pinned to English**; preflight spot-checks the app locale and refuses if it is not English (a title-addressed recipe against a localized menu would mis-resolve). Where Things exposes an **AXIdentifier** we prefer it over the title (stable across locales and copy changes); each recipe step records which addressing it uses.

### Recipe addressing table (intended — pending certification)

**UIC1 (2026-07-14) confirmed and CORRECTED this table** against the live AX tree ([uic1-certification.md](../lab/uic1-certification.md)); the source recipes ([ui-recipes.ts](../../src/write/vectors/ui-recipes.ts)) now carry the corrected addressing: sheets/dialogs are addressed on `(first window whose subrole is "AXStandardWindow")` (NOT `window 1`, a hidden 40×40 utility window); the Repeat-dialog frequency uses a `select-popup` step (open + click the item — `set value` is a silent no-op); the interval field is `text field 1 of group 1 of sheet 1 …` (nested in the dialog group); and the convert/stop **confirm buttons** are addressed by the stable `action-button-1` AXIdentifier. Menu items expose no per-item identifier (all share `performCommand:`), so menu steps stay title-pinned. The two rows below whose ops FAILED (`stop-repeat` card-open, `heading.convert-to-project` reveal) are unreachable via AX — see the failure notes in the certification doc. The rest of this table is the original intent, retained for context.

| Op | Step | Element path (intended) | Addressing | Canary / dynamic |
|---|---|---|---|---|
| `todo.pause-repeat` | reveal | `things:///show?id=<uuid>` | url-scheme | — |
| | press | `menu item "Pause" of menu 1 of menu item "Repeat" of menu "Items" of menu bar 1` | title-pinned (AXIdentifier preferred) | canary |
| `todo.resume-repeat` | reveal | `things:///show?id=<uuid>` | url-scheme | — |
| | press | `menu item "Resume" of menu 1 of menu item "Repeat" of menu "Items" of menu bar 1` | title-pinned (AXIdentifier preferred) | canary |
| `todo.stop-repeat` | reveal | `things:///show?id=<uuid>` | url-scheme | — |
| | press (open card) | double-click the selected row → card | title-pinned | dynamic |
| | press (repeat bar) | `button "↻ Repeat every …" of <card>` | title-pinned (AXIdentifier preferred) | dynamic |
| | press (popover) | `menu item "Stop" of <popover>` | title-pinned | dynamic |
| | press (confirm) | `button "Stop" of sheet 1 of window 1` ("Stop To-Do from Repeating") | title-pinned | dynamic |
| `todo.convert-to-project` | reveal | `things:///show?id=<uuid>` | url-scheme | — |
| | press | `menu item "Convert to Project…" of menu "Items" of menu bar 1` | title-pinned | canary |
| | press (confirm) | `button "Convert" of sheet 1 of window 1` | title-pinned | dynamic |
| `heading.convert-to-project` | reveal | `things:///show?id=<uuid>` | url-scheme | — |
| | press | `menu item "Convert to Project…" of menu "Items" of menu bar 1` | title-pinned | canary |
| | press (confirm) | `button "Convert" of sheet 1 of window 1` | title-pinned | dynamic |
| `todo.make-repeating` | reveal | `things:///show?id=<uuid>` | url-scheme | — |
| | press | `menu item "Repeat…" of menu "Items" of menu bar 1` | title-pinned | canary |
| | key (frequency) | frequency pop-up in the repeat dialog (arrow-key select) | title-pinned (AXIdentifier preferred) | dynamic |
| | set-field-value (interval) | interval text field in the repeat dialog | title-pinned (AXIdentifier preferred) | dynamic |
| | press (OK) | `button "OK" of sheet 1 of window 1` | title-pinned | dynamic |
| `todo.reschedule-repeat` | reveal | `things:///show?id=<uuid>` | url-scheme | — |
| | press | `menu item "Reschedule…" of menu 1 of menu item "Repeat" of menu "Items" of menu bar 1` | title-pinned | canary |
| | key (frequency) | frequency pop-up in the repeat dialog (arrow-key select) | title-pinned (AXIdentifier preferred) | dynamic |
| | set-field-value (interval) | interval text field in the repeat dialog | title-pinned (AXIdentifier preferred) | dynamic |
| | press (OK) | `button "OK" of sheet 1 of window 1` | title-pinned | dynamic |

Note the surface asymmetry that drives the two-recipe split for repeat management: **Stop is reachable ONLY from the open-card repeat-bar popover** — it is absent from the Items menu and the row context menu (UI2-i, oddities §8g). Pause/Resume/Reschedule live on the menu surface; Stop must open the card.

## The gating model — two keys, one hazard, the top tier

The vector is **fail-closed at two independent keys**:

- **Key 1 — config opt-in `ui.enabled`** (boolean; CLI `things config set ui-enabled true`). Unset or false ⇒ the vector is **unavailable** and every ui op reports **unsupported** (exit 6) with a remediation naming the config key and [docs/setup.md](../setup.md). The AX driver targets the **local machine** — the "closet mini" runs things-api itself and drives its own GUI (conceptually over `127.0.0.1`, i.e. locally); there is no remote-host knob.
- **Key 2 — per-call acknowledgment.** Every call must additionally pass `--dangerously-drive-gui` (CLI) / `dangerouslyDriveGui: true` (MCP/library/batch). Without it the op is **blocked** (exit 4) by a new hazard **`H-UI-DRIVE`**.

`H-UI-DRIVE` detail (plain language, so the consumer surfaces can quote it): *"drives the local Things app through the Accessibility API — it may briefly interact with the app's UI. On current evidence (AXVM1) element presses do NOT steal window focus and work even under a locked session, so the disruption is far milder than screen-driving would be; it is still gated because it drives the real GUI, and is intended for a dedicated machine."*

The ack also **lifts the disruption ceiling**: the ui vector is **DisruptionTier 3** (the existing enum's top — UI nav / modal risk), so it sits above `--allow-very-disruptive` and is reachable only through its own explicit key. On success, the result envelope carries a note that **the change was applied by driving the local Things app through the Accessibility API** (worded per surface-copy — see below).

**Surface-copy note.** Per [surface-copy.md](surface-copy.md), the consumer-facing MCP tool descriptions and CLI `--help` state the disruption **plainly and in behavior terms** — "drives the local Things app through its accessibility interface to make a change the app offers nowhere else; intended for a dedicated always-on Mac" — and must NOT leak internal vocabulary (`hazard`, `H-UI-DRIVE`, `vector`, disruption-tier numbers, probe ids) into those strings. The internal names in THIS doc are for the design/`docs` surface only.

### The locked-session question (LOCK1 → AXVM1)

VNC input hits the lock screen on a locked session (LOCK1-f, [headless-research.md](../lab/headless-research.md)) — that was a reason the VNC path needed the session unlocked. **AXVM1 falsified this for the AX path**: element presses by name worked under a locked session and stole no focus (a template was paused with Finder frontmost — Finder stayed frontmost). So the ui vector does **not** carry an inherent unlocked-session requirement, and `H-UI-DRIVE` is worded accordingly. The closet-mini setup still keeps the session unlocked as operational hygiene (so a human can watch/intervene, and so the row-selection `things:///show` handle behaves predictably); the open certification question is only whether the `activate-app` preamble step can be dropped entirely. A dedicated machine nobody else touches remains the right home regardless.

## The ops — tiers and the minimal rule vocabulary

Seven ops, all `vector = "ui"`, all shipped **UNCERTIFIED**.

**Tier 1 — clicks only** (menu/card presses, no data entry):

| Op | CLI | Reversibility | Recipe surface | Identity / result |
|---|---|---|---|---|
| `todo.pause-repeat` | `things todo pause-repeat <ref>` | **reversible** (undo = resume) | Items ▸ Repeat ▸ Pause | identity preserved; sets `rt1_instanceCreationPaused`, keeps the template + rule |
| `todo.resume-repeat` | `things todo resume-repeat <ref>` | **reversible** (undo = pause) | Items ▸ Repeat ▸ Resume | identity preserved |
| `todo.stop-repeat` | `things todo stop-repeat <ref>` | **IRREVERSIBLE, terminal** | open-card repeat-bar popover ONLY (+ confirm sheet) | **identity replacement**: template uuid hard-deleted, replaced by a new plain to-do with the rule cleared; the already-spawned instance survives independently. Result returns the **new uuid** (DB diff) |
| `todo.convert-to-project` | `things todo convert-to-project <ref>` | **IRREVERSIBLE** | Items ▸ Convert to Project… (+ confirm sheet) | **identity replacement**: original to-do uuid dies, new `type=1` project born with notes preserved. Result returns the **new project uuid** (DB diff) |
| `heading.convert-to-project` | `things heading convert-to-project <ref>` | **IRREVERSIBLE** | Items ▸ Convert to Project… (+ confirm sheet) | **identity replacement**: heading uuid dies, new project promoted into the parent project's **area**, former children reparented. Result returns the **new project uuid** (DB diff) |

**Tier 2 — dialog data entry** (the repeat dialog: frequency + interval):

| Op | CLI | Reversibility | Result |
|---|---|---|---|
| `todo.make-repeating` | `things todo make-repeating <ref> --frequency <daily\|weekly\|monthly\|yearly> --interval <1-99>` | **IRREVERSIBLE** | **identity replacement**: plain to-do becomes a NEW template row + a spawned instance; original uuid dies. Result returns the **new template uuid** (DB diff) |
| `todo.reschedule-repeat` | `things todo reschedule-repeat <ref> --frequency … --interval …` | **IRREVERSIBLE** | identity **preserved** (the rule bytes mutate in place), but classified irreversible because the minimal GUI vocabulary cannot faithfully restore an arbitrary prior recurrence rule — a prior weekday/monthly-offset rule would be lost. Reschedule again by hand to change it back |

The `reschedule-repeat` classification is worth spelling out for the reversibility matrix: it is the one op whose **identity is preserved** yet is still `irreversible`, because "undo" would mean reconstructing the exact prior rule, and the supported vocabulary (below) is a strict subset of what a rule can encode. We can set a new simple rule; we cannot promise to restore the old one.

### Minimal rule vocabulary (v1)

The supported recurrence subset for `make-repeating` and `reschedule-repeat`:

- **frequency** ∈ `{daily, weekly, monthly, yearly}`
- **interval** ∈ `1..99`

Explicitly **NOT supported in v1** (future increments): weekday pickers, ends-bounds (never / after N / on-date), reminders in the repeat dialog, and the "after completion" vs "fixed" type selection. The dialog defaults (after-completion type, no end bound, no reminder) stand for anything the vocabulary does not set. This is why `reschedule-repeat` is irreversible: an existing rule may use any of those unsupported dimensions, and we cannot round-trip them.

### MCP tools (4, per-intent)

Grouped by intent like the existing `set_project_status`, not one-tool-per-op:

| MCP tool | Dispatches to | Extra params |
|---|---|---|
| `make_repeating` | `todo.make-repeating` | `frequency`, `interval` |
| `reschedule_repeat` | `todo.reschedule-repeat` | `frequency`, `interval` |
| `set_repeat_state` | `todo.pause-repeat` / `resume-repeat` / `stop-repeat` | `state: pause \| resume \| stop` |
| `convert_to_project` | `todo.convert-to-project` / `heading.convert-to-project` (dispatches on whether the uuid is a to-do or a heading) | — |

Every ui MCP tool takes `dangerously_drive_gui` and `dry_run`; the two rule tools additionally take `frequency` + `interval`.

## Certification-status machinery

Every ui op ships with an explicit **per-op `uncertified` status** and a manifest that a certification run flips to `certified`. This axis is separate from the vector matrix's `validation` field: `validation: "validated"` means the recipe is wired and lab-derived (so the planner will select it); `certification` means the recipe's element paths have been confirmed against a live Accessibility tree end-to-end. We ship the code with everything `uncertified` and do not block the vector on a certification run.

**Certification is now a lab operation (AXVM1), and it has RUN (UIC1).** The original plan assumed AX was unprobeable in the VM lab (SIP), making a real-hardware sitting the *only* path. **AXVM1 (PR #136) falsified that**: Accessibility is grantable in a Tart guest, so the certification suite — the AXVM1 grant recipe plus the ops run against the seeded library through the real pipeline, asserting the expected DB deltas — is **runnable in a VM clone per Things version**. **UIC1 (2026-07-14, [uic1-certification.md](../lab/uic1-certification.md)) executed it** against Things 3.22.11: **five ops are `lab-certified`** (pause, resume, make-repeating, reschedule, `todo.convert-to-project`) and **two FAILED** (`stop-repeat`, `heading.convert-to-project`) because the AX-only vector has no way to select a specific list row (a card needs a mouse double-click; a heading is not `things:///show`-selectable). The real-hardware sitting ([ui-certification-runbook.md](../lab/ui-certification-runbook.md)) is now the **final `certified` confirmation on target hardware**, not the sole route.

- **Manifest:** `src/write/vectors/ui-certification.ts` records, per op, its `status` (`uncertified` | **`lab-certified`** | `certified`), the evidence ids (UI2-a/b/c/d/i + UIC1-a), and — for a failed op — a `blocker`. `lab-certified` = run end-to-end in a VM clone with the DB deltas asserted; `certified` = additionally confirmed on the deployment hardware. UIC1 flipped five entries to `lab-certified`; the two failures stay `uncertified` with the row-selection blocker recorded.
- **`things capabilities`** surfaces each ui op's certification status (the designated drill-down surface, per surface-copy — this is where "how sure are we" lives, not on the op's own description).
- **`doctor`** has a ui-vector section (below) that shows per-op certification status.
- **Result envelopes** of an uncertified op carry a **warning naming the status** — the op ran and (per the DB-diff verification) did what it claims, but the recipe has not been proven on real hardware, so the caller is told.

The [certification runbook](../lab/ui-certification-runbook.md) IS the deferred e2e: a one-time real-hardware sitting against a **scratch/test database, never a prod library**. A sibling probe **AXVM1** is testing whether Accessibility can be granted inside Tart guests; if it succeeds, VM-based certification becomes possible and upgrades the story — but the per-op uncertified machinery ships **regardless** of AXVM1's outcome.

### The open certification question

**Does AXPress work WITHOUT foregrounding Things (background driving)?** The recipes include an `activate-app` fallback that is **skipped if background press proves out**. The runbook must answer this during the sitting. If background AXPress works, the vector can drive without stealing focus even on a machine someone is using (softening the disruption story and possibly relaxing LOCK1); if it does not, the activate preamble stays and the foreground-steal / unlocked-session requirements stand as written.

### Doctor ui-vector section

Each line has a verdict + remediation:

- **config enabled?** — is `ui.enabled` true?
- **Things running?** — the driver needs a running app.
- **Accessibility granted?** — an **opt-in probe** following the existing `--probe-automation` precedent; the new flag is **`--probe-accessibility`**. It never triggers a surprise TCC prompt otherwise (checking Accessibility can itself summon the consent dialog, so it is gated behind the flag exactly like the Automation probe).
- **recipe canary** — resolve the statically-reachable menu-bar paths per op family.
- **per-op certification status** — from the manifest.

## Closet-mini setup sketch

The viable home for this vector is a **dedicated always-on Mac** ("closet mini") nobody looks at, kept unlocked, that runs things-api itself and drives its own GUI locally. Full provisioning steps live in [setup.md](../setup.md) ("Closet-mini / ui vector"); the shape:

- Enable remote access (Screen Sharing / SSH) as for any dedicated automation Mac.
- Keep the session **unlocked** (LOCK1) — disable screen lock and display/system sleep.
- `things config set ui-enabled true`.
- Grant **Accessibility** to the process running things-api (System Settings ▸ Privacy & Security ▸ Accessibility) — the grantee is the driving process, mirroring the existing Full Disk Access / Automation guidance (terminal app for interactive use, `sshd-keygen-wrapper` for SSH).
- `things doctor --probe-accessibility` to confirm the grant.
- Understand that the ops are **uncertified** until the sitting.

The dedicated-machine framing predates AXVM1, which showed the AX path is much milder than the VNC research suggested — element presses steal no focus and work under a locked session, so the "yanks Things forward and grabs keyboard focus mid-work" disruption belonged to the *VNC* path, not this one. The two-key gate and dedicated-machine framing remain because the vector still drives the real GUI (and the row-selection `things:///show` handle does bring Things forward), and because certification is still pending — not because a mid-work focus-steal is inherent.

## Cross-links

- Lab evidence: [ui-vector-research.md](../lab/ui-vector-research.md) (UI1 / UI2 / UI2-i verdicts, disruption profile, cessation model).
- Certification: [ui-certification-runbook.md](../lab/ui-certification-runbook.md) (the deferred e2e on real hardware).
- Locked-session constraint: [headless-research.md](../lab/headless-research.md) (LOCK1).
- Consumer copy rules: [surface-copy.md](surface-copy.md).
- App quirks: [things-app-oddities.md](../things-app-oddities.md) §8f (make-repeat / convert identity replacement) and §8g (Stop reachable only from the card popover).
</content>
</invoke>
