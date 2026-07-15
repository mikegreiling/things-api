# UIC5 — the pure-AX build: `project.make-repeating` + the create-repeating composite

**Status (2026-07-15): BUILT, SHIPPED-UNCERTIFIED — the in-VM certification pass is PENDING.** `project.make-repeating` and the two-step `project.create-repeating` composite are built on the UIC4 pure-AX row-selection path and wired end-to-end through the production pipeline (CommandSpec + orchestrator + CLI + MCP + reversibility + guards + unit tests). The manifest entry (`src/write/vectors/ui-certification.ts`) is `uncertified` with the blocker "certification is the UIC5 in-VM pass". This doc records the shipped recipe, the taxonomy dispatch, and the **exact certification plan** (the 7 cases + DB assertions) so the pass is a mechanical follow-up — it is NOT a verdict record. No certification verdict is asserted here because the pass has not been run: the recipe's element paths (notably the DETACHED-window Repeat-editor field nesting) are provisional-pending-live-AX exactly as every ui-vector recipe shipped provisional and was corrected at its certification sitting (UIC1 for the to-do ops, UIC3-b for the project ops).

**Why not run here.** The UI-vector certification sitting is **human-present by nature** ([ui-certification-runbook.md](ui-certification-runbook.md) §Notes): it needs an unlocked GUI session, the AXVM1 rung-b Accessibility grant driven over **VNC** (`vncdotool` / `$VNCDO`), and an Accessibility-Inspector discovery pass to confirm/correct the live element paths. The build agent's environment lacks `vncdo`, and the detached-window field nesting is the kind of provisional path that needs a visual AX-tree read to confirm. Fabricating deltas would violate the lab's evidence discipline (every verdict is backed by an observed DB diff). The pass is therefore parked for a human-present sitting, reproducibly scripted per §4 below.

Companions: [uic4-project-selection.md](uic4-project-selection.md) (the pure-AX row-selection verdict this build rides), [uic3-build-certification.md](uic3-build-certification.md) (how the project reschedule/pause/resume ops certified — the pattern §4 follows), [ui-certification-runbook.md](ui-certification-runbook.md) (the sitting mechanics), [ax-initiative.md](../design/ax-initiative.md) (build brief), [ui-vector.md](../design/ui-vector.md).

## What shipped

### `project.make-repeating` (ui vector, pure-AX)

The op selects the project as a content-table ROW and drives `Items ▸ Repeat…` — the same dialog the to-do op uses. It is `uuid`-addressed with the `todo.make-repeating` rule vocabulary exactly: `frequency ∈ {daily,weekly,monthly,yearly}` + `interval 1..99`. Reversibility: **irreversible** (identity replacement — the original project uuid dies, a new template + spawned instance are born; area preserved, `start` normalized to Someday), the same class and undo posture as `todo.make-repeating`.

The recipe ([`src/write/vectors/ui-recipes.ts`](../../src/write/vectors/ui-recipes.ts) `projectMakeRepeatingRecipe`):

1. **reveal** the container — `things:///show?id=<area-uuid>` for an area project, `things:///show?id=someday` for an area-less someday project.
2. **activate** (fallback only — pure AX is background-capable, so this is dropped once background AX is re-confirmed).
3. **select-row** (new driver primitive) — walk the content table's rows, set each as the sole `AXSelectedRows` selection, and read back `Things3 → name of selected to dos`; the row whose readback equals the target title is LEFT selected, returning `OK` (else `NOMATCH` → fail-closed abort). The readback IS the selection-landed verification (UIC4-a). Coordinate-free, no focus steal.
4. **wait + press** `Items ▸ Repeat…` — dynamic (it materializes only once the row is selected, UIC1), so it is waited-for then pressed, NOT canaried up front.
5. **the Repeat editor**, addressed by BOTH forms via `pathCandidates` (new step field): the attached `AXSheet` of the standard window (frontmost) OR the DETACHED top-level `AXUnknown` window (backgrounded, UIC4-a). The driver dispatches each control against whichever shape resolves. Controls: frequency pop-up (select-popup), interval field (set-value), OK (press).

### Taxonomy dispatch + the Someday coercion (`runMakeRepeatingProject`)

`classifyProjectRepeat` ([`src/write/pre-state.ts`](../../src/write/pre-state.ts)) reads DB truth and dispatches:

| Taxonomy | Recipe | Orchestrator action |
|---|---|---|
| project in an **area** | reveal the area → select row | drive directly (no coercion) |
| area-less **someday** | reveal Someday → select row | drive directly |
| area-less **anytime** | (no selectable row — a header in Anytime, UIC4-d) | **coerce** via `project.update?when=someday` (url-scheme leg) → then the Someday drive; grouped as one txn + summary |

The coercion is **cleanup-free** (UIC4-c/d: make-repeating normalizes `start`=2 regardless of origin, so the temp Someday state is consumed by the conversion) and is surfaced in `--dry-run` / verbose. Refusals (fail-closed, `H-PROJECT-REPEAT`): already-repeating, trashed, logged/resolved, duplicate-title **row ambiguity** (two same-titled projects in the container expose no AX handle to disambiguate — UIC4-b — so the drive refuses rather than guess), and a direct dispatch on an anytime project (routed to the orchestrator). A non-project target is `H-UNKNOWN-DESTINATION`.

### `project.create-repeating` composite (`runCreateRepeatingProject`)

The roadmap two-step (ruling #2): `project.add` (url-scheme, seeded `when=someday` when no area is given, or into the target area — UIC4-f, so the promote lands directly on a pure-AX path) THEN promote via `runMakeRepeatingProject`. **Non-atomic**: the created project persists even if the promote refuses. Reversibility: **irreversible** (the promote destroys the created uuid). Exposed as CLI `things project create-repeating <title> …` and MCP `create_repeating_project`.

## The certification plan (the pending in-VM pass)

Reproduce the UIC3/UIC4 harness: ONE disposable `--vnc-experimental` clone of `things-lab-golden-v1` (airgapped, clock-pinned 2026-07-05, SIP on), Accessibility granted via the AXVM1 rung-b VNC toggle (`$VNCDO`, single-client RFB — ONE `vncdo` per step with timeouts, `AXEnhancedUserInterface` stays false), everything else over SSH; ground truth = guest Things-DB row deltas (read-only SQLite) + the production CLI's own `--json` envelope. Build this branch's `dist` into the guest and run each case through the **production CLI** with both keys (`ui.enabled` + `--dangerously-drive-gui`). Seed subjects via the quiet vectors: an area project, an area-less someday project, an area-less anytime project, and two same-titled projects in one area (the ambiguity negative).

| Case | Subject | Command | DB assertion |
|---|---|---|---|
| **UIC5-a** area project | project in `LAB-AREA-A`, anytime | `things project make-repeating <ref> --frequency weekly --interval 1 --dangerously-drive-gui` | original uuid hard-deleted; NEW template (`rt1_recurrenceRule` fu=256 weekly) + spawned instance; **area preserved**; both `start`=2; result returns the new template uuid |
| **UIC5-b** area-less someday | area-less, `start`=someday | same | original gone; template + instance, area-less preserved, `start`=2 |
| **UIC5-c** area-less anytime (coercion) | area-less, `start`=anytime | same | url leg sets `start`=2 first (verified); then template + instance identical to the direct path (**post-op state matches UIC5-b** — coercion left no residue); summary + 2 leg audit records |
| **UIC5-d** composite | — | `things project create-repeating "CR Test" --frequency monthly --interval 1 --dangerously-drive-gui` | project created (persists); then promoted → template + instance; result returns the template uuid |
| **UIC5-e** backgrounded (detached editor) | case a or b, Finder frontmost throughout | same, with Finder raised via `open -g` reveal + no activate | drive lands with frontmost staying Finder; **exercises the DETACHED `AXUnknown` editor form** — CONFIRM the frequency/interval/OK `pathCandidates` resolve against the detached window (correct the field nesting if the interval field is not `text field 1 of window 1`) |
| **UIC5-f** negative: already-repeating | a repeating project | `things project make-repeating <template> …` | **blocked** `H-PROJECT-REPEAT`, exit 4, NO mutation |
| **UIC5-g** negative: duplicate-title ambiguity | two projects titled `Dup` in one area | `things project make-repeating <one> …` | **blocked** `H-PROJECT-REPEAT` (ambiguous-row), NO mutation |

Also confirm the gating (unsupported with `ui.enabled` unset; blocked `H-UI-DRIVE` without `--dangerously-drive-gui`) and one deliberate failure path (time out a dialog / revoke Accessibility → clean fail-closed + honest partial-state report). On success, flip `project.make-repeating` in the manifest to `lab-certified` with evidence `["UIC4-a","UIC4-b","UIC4-f","UIC5-a"]` (and correct any element paths / capture AXIdentifiers the discovery pass finds), update the capability-matrix + ax-initiative + CHANGELOG certification wording, and add the UIC5 verdicts above this planning section.

## Provisional paths to confirm/correct at the sitting

- The content table specifier `table 1 of scroll area 1 of <standard window>` — confirm it is the wide content list in both the area and Someday views (UIC4 named "the wide AXScrollArea's table").
- The **detached** Repeat-editor field nesting — UIC4 documented the frequency pop-up as a direct child (`pop up button 1 of window 1`) but did not map the interval field; the recipe's detached candidate assumes `text field 1 of <detached>` (a direct child, vs `text field 1 of group 1 of <sheet>` on the sheet form). This is the single most-likely path to need correction (UIC5-e).
- Whether the `activate` fallback can be dropped entirely (background AX re-confirmed).
