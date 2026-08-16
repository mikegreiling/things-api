# ADR1 — add-repeating silently fails because the Repeat dialog never appears (issue #480)

**Probed under: `things-lab-golden-v2` · Things 3.22.12 (build 32212016) · macOS 15.7.7 · DB schema v26 · pinned clock 2026-07-05 12:00 (a Sunday).** ONE disposable clone `adr1-lab` of golden-v2 (golden untouched; every write inside the clone), airgapped (default route deleted, ping fails), clock pinned before Things launched. golden-v2 carries the baked L3-accessibility grant, so `todo add-repeating` (a ui-vector op) and the AX selection/menu probes drove over SSH via System Events — no VNC. Ground truth = read-only guest SQLite. Fixtures fully synthetic (`ADR1 *` titles; a synthetic `Synthetic Area` + `recurring` tag created in the clone). Driver [`lab/scripts/research-adr1.sh`](../../lab/scripts/research-adr1.sh); re-cert driver [`lab/scripts/research-adr1-recert.sh`](../../lab/scripts/research-adr1-recert.sh); artifacts (gitignored) `lab/artifacts/adr1-lab/` (`report.txt`, `drive/*.log`, `sel/*.txt`).

## The report (#480, from Things 3.22.14)

`todo add-repeating "<title>" --area … --tag … --when 2026-08-26 --reminder 18:00 --notes … --frequency weekly --interval 2 --weekdays wednesday --dangerously-drive-gui` completes the drive's "reveal the target → foreground Things → Items ▸ Repeat…" steps, then times out waiting for **the Repeat dialog**; exit `verify-failed:silent-noop`; the seeded to-do is left behind as residue; AND the reported source uuid was "not reachable through `todo delete`" (a second, distinct bug). Leading hypothesis: a **disabled-menu press masking a selection failure** — an AXPress on a DISABLED `Items ▸ Repeat…` "succeeds" as a no-op, so the dialog never opens; the item is disabled when the reveal did not leave an eligible row selected. The suspected trigger: seed variables our ANCH2 certification never combined (area + tag + when + reminder together).

## HEADLINE VERDICT — the silent no-op does NOT reproduce under the golden (3.22.12)

**On Things 3.22.12, `todo add-repeating` SUCCEEDS across the entire repro matrix — including the exact full issue combo.** Every cell created the repeating template, first occurrence 2026-08-26 (the ANCH2 Next-field drive landed). The `things:///show?id=` reveal selected the seed row on every surface tested and `Items ▸ Repeat…` was ENABLED. The #480 `verify-failed:silent-noop` is therefore **version-specific to Things 3.22.14** — the host is two point releases past the golden. This is the SAME split CHKT1/#479 found (checklist-on-template): 3.22.13/3.22.14 changed repeating-conversion behavior that the 3.22.12 golden cannot reproduce. Per the campaign STOP rule this is a **maintainer golden decision** — no root-cause reveal fix is shippable from a 3.22.12 clone (there is no golden bug to fix, and a change gated on a surface that works here would regress the golden's own `lab:regress`).

**What IS shipped** (defensive, evidence-led, regression-safe on the golden — see Phase A below): a positive selection/eligibility assertion that converts a future disabled-menu no-op into an early NAMED failure instead of an opaque dialog-wait timeout; a residual-cleanup contract (auto-trash the composite's own seed on promote failure, honest resolvable-uuid remediation) that fixes the #480 SECOND bug deterministically regardless of app version.

## Phase 0-pre — area/tag MISSING (the filer's environment is unknown)

`todo add-repeating … --area "Synthetic Area" --tag recurring …` with NEITHER pre-created → `blocked:H-UNKNOWN-TAG` at the **create leg**, exit 4, **no row created, no residue**. A missing destination is refused cleanly BEFORE anything is seeded — it is not a silent-noop and leaves nothing to clean up. (The issue's filer therefore had both the area and the tag already present.)

## Phase 0 — repro matrix (each cell = the production guest bundle, main HEAD pre-fix)

Common rule for every cell: `--frequency weekly --interval 2 --weekdays wednesday --when 2026-08-26 --dangerously-drive-gui`. The `bare` cell is `--when`-only (the known-good control); each subsequent cell adds one variable.

| Cell | added add-vocabulary | result | repeating template? |
|---|---|---|---|
| bare | (when only) | `ok` · todo.add-repeating · ui · exit 0 | **PASS** — template created, first occ 2026-08-26 |
| +area | `--area "Synthetic Area"` | `ok` · exit 0 | **PASS** |
| +tag | `--tag recurring` | `ok` · exit 0 | **PASS** |
| +area+tag | `--area … --tag recurring` | `ok` · exit 0 | **PASS** |
| +reminder | `--reminder 18:00` | `ok` · exit 0 | **PASS** |
| **full (issue combo)** | `--area … --tag recurring --reminder 18:00 --notes …` | `ok` · exit 0 | **PASS** — template created, first occ 2026-08-26 |

**Every cell passed.** No selection failure, no disabled menu, no dialog timeout on 3.22.12.

### Selection / menu-enabled probe (the disabled-menu hypothesis, directly measured)

For the reachable cells a plain seed with the same add-vocabulary was revealed via `things:///show?id=` and its selection + menu state read (`id`/`name of selected to dos`; `enabled of menu item "Repeat…" of menu "Items"`, read both directly AND with the Items menu opened so NSMenuValidation runs):

| Surface | selected `id` == seed? | window | `Repeat…` exists / enabled (closed) / enabled (opened) |
|---|---|---|---|
| Inbox (bare seed) | yes | Inbox | true / **true** / **true** |
| Area view (area seed) | yes | Synthetic Area | true / **true** / **true** |

Two findings that shaped the fix: (1) the reveal DID leave exactly the target row selected on both surfaces — the disabled-menu-masking failure does not occur on 3.22.12; (2) the direct `AXEnabled` read AGREES with the menu-opened read, so an eligibility assertion can read the menu item's enabled state directly (no need to open the menu). (The `--tag`/`--reminder`/full probe SEEDS did not capture — the diagnostic used `todo add`, whose flag is `--tags`, not the `--tag` accepted by `add-repeating`; this is a harness-arg quirk only, orthogonal to the verdicts, which come from the real `add-repeating` path and all passed.)

## Phase A — fixes shipped (code paths, regression-safe on the golden)

1. **Positive selection/eligibility assertion** (`assert-eligible` ui primitive + `axAssertEligibleScript`, wired into the to-do `makeRepeatingRecipe` before the `Items ▸ Repeat…` press). After the reveal it reads `id of selected to dos` (uuid-precise) and requires EXACTLY the target selected, then reads the menu item's `AXEnabled`; it returns `OK` only when both hold, else a NAMED diagnostic (`NOTSEL…`/`WRONGSEL…`/`DISABLED…`) the driver surfaces as an early fail-closed abort. A disabled-menu no-op can no longer surface downstream as an opaque "the Repeat dialog never appeared" timeout. Shared by `todo.make-repeating` and `todo.add-repeating` (the project promote already positively selects via `select-row`).
2. **No root-cause reveal fix** — the golden cannot reproduce a broken reveal/selection, so there is nothing to root-cause here (STOP rule). If a 3.22.14 golden later confirms the reveal-selection regression, the assertion added in (1) is exactly the diagnostic that will name it, and any reveal-surface change is then evidence-led on that golden.
3. **Residual-cleanup contract** (RATIFIED RULING 2026-08-15) in the shared `addRepeatingViaCreate` (covers `todo.add-repeating` AND `project.add-repeating`): when the promote leg fails, the composite AUTO-TRASHES its own seeded item inside the txn (the seed is our artifact, recreatable from the command args; the Trash is recoverable) and discloses it. If the auto-trash itself fails, the result carries the seed's REAL, resolvable uuid with a working `things <kind> delete <uuid>` remediation. This fixes the #480 SECOND bug — a residue whose reported uuid was not actionable — deterministically, because the composite holds the seed's discovered uuid at the source (never a buried `expected.probe.repeating.sourceUuid`).
4. **Regression tests**: `axAssertEligibleScript` shape + recipe placement (assertion precedes the press, is dynamic/uncanaried); driver-level (a non-OK verdict aborts early + named with nothing actuated afterward; an `OK` verdict proceeds to the press); and the failure-path cleanup (promote fails → seed auto-trashed + `restore` remediation; auto-trash also fails → resolvable uuid + `delete` remediation).

## Phase A re-cert (fixed build, golden-v2 / 3.22.12) — [`research-adr1-recert.sh`](../../lab/scripts/research-adr1-recert.sh)

**A. Happy path (no regression) — PASS.** The full issue combo (`--area "Synthetic Area" --tag recurring --reminder 18:00 --notes … --frequency weekly --interval 2 --weekdays wednesday --when 2026-08-26`) created the template WITH the new eligibility assertion inline. The drive now runs **12 steps** (was 10): `… → confirm the target to-do is selected and Items ▸ Repeat… is enabled → Items ▸ Repeat… → … → check Add reminders → reminder = 18:00 → press "OK"`. DB verification: `rt1_instanceCreationStartDate = 132812032` (**= 2026-08-26**, first occurrence honored) and template `reminderTime = 1207959552` (**= 18:00**, `hour<<26` — the reminder is committed onto the SERIES, closing requested behavior #3). No regression from the assertion.

**B. `assert-eligible` on real AX — PASS.** The shipped script's real behavior: revealing a properly-seeded to-do (`things:///show?id=`) → `id of selected to dos` matches + menu enabled → **`OK`**; a deselected list view → **`NOTSEL no to-do is selected after the reveal (expected <uuid>)`**. So the primary #480 protection (a disabled-menu no-op) is caught with a named diagnostic on real hardware.

**C. Forced failure → seed auto-trash — the leftover-modal sabotage over-blocks the CREATE leg (auto-trash is unit-certified instead).** Opening a Repeat dialog on a blocker to-do and leaving it open DID disable the menu bar (`leftover sheet open? true`), but it also made the subsequent `add-repeating`'s **create leg** (URL-scheme `todo.add`) silent-noop — the failure's `expected` delta is the create probe (`startDate`/`reminder`/`area` asserts, `observed: null`), so no seed was created (a leftover modal blocks the app from processing URL adds — a minor bonus finding). The command returned cleanly (`verify-failed:silent-noop`, exit 3) with **no residue** (nothing to auto-trash), which is itself safe, but it did not isolate a promote-ONLY failure. The auto-trash + honest-uuid contract is therefore certified by the deterministic unit tests (`test/engine/write-promote-clone.test.ts`): a promote failure auto-trashes the seed and discloses a `restore` remediation; a failing auto-trash surfaces the seed's resolvable uuid + a `things todo delete <uuid>` remediation.

## Conclusion & recommendation (maintainer golden decision)

1. **The #480 silent-noop is a suspected Things 3.22.14 regression** (repeating-conversion via the Repeat dialog), unreproducible under the golden — the same 3.22.14 split as #479/CHKT1. No golden root-cause fix is shippable.
2. **The shipped system already degrades safely on 3.22.14**: the fail-closed verify catches the no-op (no bad state, clear error). The new eligibility assertion adds an early, named diagnostic; the seed auto-trash + honest-uuid contract removes the residue-and-ambiguous-cleanup half of the report entirely.
3. **Decision needed:** advance the golden to the current release (3.22.14+) and re-run ADR1 + CHKT1. If the silent-noop confirms there, the eligibility assertion will name WHETHER it is a selection failure (the disabled-menu hypothesis) or a different dialog regression; the reveal-surface root-cause fix is then evidence-led on that golden.
