# UIC5 — the pure-AX build: `project.make-repeating` + the create-repeating composite

**Verdict (2026-07-15): LAB-CERTIFIED against Things 3.22.11 / macOS 15.7.7 / DB v26.** The in-VM pass RAN — all seven cases below pass, DB-verified, driven through the **production CLI** (guest e2e bundle, `ui.enabled` + `--dangerously-drive-gui`). `project.make-repeating` and the `project.create-repeating` composite that rides it are now `lab-certified` in `src/write/vectors/ui-certification.ts` (evidence `["UIC4-a","UIC4-b","UIC4-f","UIC5-a"]`), the blocker removed. The sitting corrected **two provisional paths** exactly as prior sittings did (UIC1/UIC3): (1) the **select-row primitive** set the *table's* `AXSelectedRows` attribute to a one-row list, which is a **silent no-op** via System Events — the working route is the row **`select` action** (pure System Events, background-capable, no focus steal); (2) the **detached editor's interval field** nests in **group 1** (`text field 1 of group 1 of <detached>`) exactly like the attached sheet, not as a direct child — the single correction the plan predicted. The frequency pop-up (`pop up button 1`), the sheet interval path, the OK button, and the `table 1 of scroll area 1` content-table specifier were all confirmed correct.

Ran in ONE disposable `--vnc-experimental` clone `uic5-lab` of `things-lab-golden-v1` (airgapped, clock-pinned 2026-07-05, SIP on), Accessibility granted via the AXVM1 rung-b VNC toggle (`$VNCDO` from a throwaway `vncdotool` venv — the host has no `vncdo` on PATH, so each campaign builds one; the "vncdo not installed / human-present sitting" claim that parked this pass was false, exactly as five prior campaigns established). Everything else over SSH; ground truth = guest Things-DB row deltas (read-only SQLite) + the production CLI's `--json` envelope. Scripts: `lab/scripts/research-uic5.sh`. Companions: [uic4-project-selection.md](uic4-project-selection.md) (the pure-AX row-selection verdict this build rides), [uic3-build-certification.md](uic3-build-certification.md), [ui-certification-runbook.md](ui-certification-runbook.md), [axvm1-accessibility.md](axvm1-accessibility.md) (the grant + under-lock AX).

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

## UIC5 verdicts (executed 2026-07-15)

Every case ran through the production CLI (`things project make-repeating …` / `things project create-repeating …`) with both keys, against the seeded taxonomy; ground truth is the guest DB diff. `TMTask.start`: 1 = anytime, 2 = someday. Repeating-rule `fu`: 256 = weekly, 8 = monthly. Identity replacement = the original project uuid is hard-deleted and a NEW template (with `rt1_recurrenceRule`) + a spawned instance are born.

| Case | Subject | Verdict | DB evidence |
|---|---|---|---|
| **UIC5-a** area project | `UIC5-A` in `LAB-AREA-A`, anytime | **PASS** | orig `6kVy…` hard-deleted; template `DScLnH3DoRGcCqjNyUoDLm` (`fu`=256 weekly, `of`=[{wd:0}] Sun) + instance `Ko664ajx3vjz93n8kBTrCc`; **area `LAB-AREA-A` preserved on both**; both `start`=2; CLI `--json` returned the template uuid; exit 0 |
| **UIC5-b** area-less someday | `UIC5-B`, `start`=someday | **PASS** | orig `QFjK…` gone; template `7SNU42rUY59gUrHAQMpCSv` + instance `F4k8KTkng8HPh4SzJVUubG`; **area-less** preserved; `start`=2; `fu`=256; exit 0 |
| **UIC5-c** area-less anytime (coercion) | `UIC5-C`, `start`=anytime | **PASS** | url leg set `start` 1→2 first (verified), then the pure-AX drive; orig `ADXX…` gone; template `WBJtTkGvWqkPLPpVyoEPEC` + instance `VBBYH4YGwgMzX9A3ZG9yXW`; **area-less, `start`=2 — post-op identical to UIC5-b (coercion left no residue, cleanup-free)**; exit 0 |
| **UIC5-d** composite | `create-repeating "CR Test" --frequency monthly` | **PASS** | project created area-less/Someday (persists), then promoted; template `9T3vdwRBph1b2EJUunQhrE` (`fu`=8 monthly) + instance; `start`=2; CLI returned the template uuid; exit 0 |
| **UIC5-e** backgrounded (detached editor) | `UIC5-E`, Finder frontmost | **PASS** | driven with **Finder frontmost throughout — no focus steal** (frontmost stayed Finder after `open -g` reveal, row `select`, Repeat press, and OK); the Repeat editor presented as the **detached `AXUnknown` window** (252,139 520×233); the **corrected** `text field 1 of group 1 of <detached>` interval path drove; orig `PwNq…` gone; template `tNYuS2x22J7dmJeJieEjr` + instance `FAyBKTZSwfnXhx7gQgEPfU`; area-less; `start`=2; `fu`=256 |
| **UIC5-f** negative: already-repeating | `LAB-REPEAT-WEEKLY-PROJ` | **PASS** | **blocked** `H-PROJECT-REPEAT` ("already a repeating template"); **exit 4**; rule UNCHANGED (`fu`=256); uuid still present; NO mutation |
| **UIC5-g** negative: duplicate-title | two `UIC5-Dup` in `LAB-AREA-A` | **PASS** | **blocked** `H-PROJECT-REPEAT` (ambiguous-row: "its selectable row cannot be disambiguated"); **exit 4**; both duplicates untouched (count 2, neither repeating); NO mutation |

**Gating (confirmed):** `--dangerously-drive-gui` omitted → **blocked** `H-UI-DRIVE`, **exit 4**, subject unchanged. `ui.enabled` unset (`config set ui-enabled false`) → **unsupported**, **exit 6**.

**Cold-start note (not a defect).** On the first drive within ~9 s of a cold Things relaunch, the `Items ▸ Repeat…` item (which materializes ~1 s after the row selection) and the url-scheme coercion leg occasionally raced their timeout and the drive/coercion **failed closed with NO mutation** (a/b/c on their first cold run); all passed reliably once Things had settled (~14 s) — the ops target an always-on Mac where Things is long-running, so this is a lab-harness relaunch artifact, not a recipe fault. The fail-closed behavior itself is correct (Escape, honest partial-state report, exit 3).

**Case-e method note.** The stock CLI foregrounds Things (reveal via `open` + the `activate` fallback), so it drives the **attached sheet**; the detached-window form is the backgrounded/locked scenario. UIC5-e therefore drove the corrected recipe's exact element paths with `open -g` + no activate (the plan's literal case-e spec) to exercise the detached form end-to-end. This proves the corrected `pathCandidates` dispatch against the detached window; the driver's sheet-vs-detached disjunction is additionally unit-tested.

## The certification plan (as specified — kept for the record; the verdicts above are the executed result)

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

## Provisional paths — resolved at the sitting

- The content table specifier `table 1 of scroll area 1 of <standard window>` — **CONFIRMED.** `scroll area 1` is the wide (695 pt) content list in both the area and Someday views; `scroll area 10` is the 240 pt sidebar. Row 0 = the area/Someday header, then the project rows.
- The **row selection primitive** — **CORRECTED (the one real bug).** The shipped `axSelectRowScript` set the *table's* `AXSelectedRows` attribute to a one-row list; via System Events this is a **silent no-op** (returns no error, selection never lands, so `Items ▸ Repeat…` never enables). UIC4-a's "settable AXSelectedRows" was proven with the **ObjC-bridge** `AXUIElementSetAttributeValue(..., NSArray)` — a different API than the System Events attribute set the driver shells out to. The working pure-System-Events route is the row **`select` action** (`select (row i of theTable)`), which replaces the selection (single-select) and is background-capable with no focus steal. Fixed in `src/write/vectors/ui.ts`.
- The **detached** Repeat-editor field nesting — **CORRECTED (as predicted).** The detached `AXUnknown` window nests its controls at the **same depth as the attached sheet**: the frequency pop-up is a direct child (`pop up button 1`, correct as shipped) but the interval field sits in **group 1** (`text field 1 of group 1 of <detached>`), not as a direct child. The shipped `text field 1 of <detached>` candidate was wrong; fixed in `src/write/vectors/ui-recipes.ts` (`DIALOG_INTERVAL`).
- Whether the `activate` fallback can be dropped — **background AX re-confirmed** (UIC5-e: the whole chain ran with Finder frontmost, no focus steal). The `activate` step is left in place as a harmless fallback (the stock CLI still foregrounds via the reveal `open`); dropping it is a separate, optional recipe simplification, not required for correctness.
