# UIC8 — promote-via-clone compound certification (make/add-repeating + trash-both undo)

**Probed under: `things-lab-golden-v2` · Things 3.22.12 (build 32212016) · macOS 15.7.7 · DB schema v26 · pinned clock 2026-07-05 12:00, advanced in +1-day steps to 2026-07-07.** Ran in ONE disposable clone `uic8-lab` of golden-v2 (golden untouched; every write inside the clone), airgapped (default route deleted, ping fails), clock pinned before Things launched and advanced only in +1-day steps (RSIM-S deterministic-spawn technique; warm relaunch after each `sudo date`). golden-v2 carries the baked **L3-accessibility** grant (`auth_value=2`, reboot-verified), so the ui-vector promote drove via System Events over SSH — NO VNC grant step. Ground truth = read-only guest SQLite row deltas driven through the **production CLI** (guest e2e bundle: node 24.14.1 — the dist needs `node:sqlite` — + built `dist` + commander). Fixtures fully synthetic (`U8*` titles). Branch `mg/promote-clone-cert`; script [`lab/scripts/research-uic8.sh`](../../lab/scripts/research-uic8.sh); artifacts (gitignored) `lab/artifacts/uic8-lab/` (`report.txt`, `snaps/*.json`, `json/*`).

This certifies the **Phase 3 promote-via-clone compounds shipped in #464** ([`src/write/promote-clone.ts`](../../src/write/promote-clone.ts), design of record [design/promote-via-clone.md](../design/promote-via-clone.md)) end-to-end against a live Things app — the leg command-sequences + undo-record round-trips had only unit coverage before this (CI has no app). Everything is driven through the shipped CLI (`--dangerously-drive-gui`), asserting the full DB byte-effect **and** the JSON result envelope shape.

## HEADLINE VERDICTS

1. **The rewired `todo`/`project make-repeating` (clone → trash(X) → native-promote) is byte-coherent and recoverable (C1, C2).** Across a bare / deadline / content-rich to-do and a plain-children / heading+completed-child / area'd project: the original **X lands in the Trash byte-intact** (title, notes, `creationDate` incl. a backdated `--created-at`, a checked checklist item, and an item reminder all unchanged — only `trashed 0→1` and a `userModificationDate` bump), a **template row is minted** (`rt1_recurrenceRule` set, X's title, trashed=0) and an **instance** points at it. The JSON result carries `uuid == repeating.templateUuid` plus `repeating{ templateUuid, instanceUuid, replacedUuid }` (`replacedUuid` = the disposable clone), and stderr discloses BOTH the trashed original ("moved to the Trash") and the placement note ("default position").
2. **The nested-repeater project refuses fail-closed (C2d).** A project holding a live nested repeating template refuses at the CLONE leg with `blocked:H-CLONE-SOURCE` (exit 4), the message NAMING the offending child, and **X is left completely untouched** (not trashed, `creationDate` and rule-absence unchanged) — the refusal surfaces coherently at the `project make-repeating` surface (no `--flatten`, ruling 2026-08-13).
3. **`things undo` is the ratified trash-both + restore (C3).** For a to-do and a project make-repeating: `undo --txn <token>` trashes BOTH the minted template (cursor CLEARED, `rt1_nextInstanceStartDate → NULL`) AND its current instance, and restores X live byte-intact (to-do to the Inbox, project in place). The **sanctioned-internal series-removal path fires ONLY via undo**: a direct `things todo/project delete <template>` still refuses with `blocked:H-REPEAT-SCHEDULE` (exit 4), leaving the template live. A **+2-day clock advance spawns ZERO** new instances from either undone series (cursor NULL ⇒ dead template — SERDEL S2).
4. **`todo`/`project add-repeating` mints a correctly-ruled series with the right spawn shape (C4).** Rule bytes (decoded `rt1_recurrenceRule`: `tp`/`fu`/`fa`) match the requested vocabulary. **After-completion** rules spawn exactly ONE instance immediately; **fixed** rules whose first occurrence is in the future materialize only the template + a cursor (0 instances) — the RSIM spawn law, and the result's `instanceUuid` is honestly `null`. No trashed-original disclosure (there is no original); undo removes the whole created series cleanly (trash-both, no restore leg).
5. **The §3 failure-rollback works (C5).** With the Accessibility precondition deliberately broken mid-compound (grant revoked so the promote's System Events drive fails after clone+trash), the compound fails honestly (`verify-failed:silent-noop`, exit 3) and **X is rolled OUT of the Trash** (trashed=0, content + `creationDate` intact, still a plain to-do). The error names the leftover disposable clone ("trash the clone and retry") — per design the un-promoted clone is NOT auto-cleaned, only X's trash is rolled back.
6. **[RESOLVED — PR mg/uic8-fixes, 2026-08-13; re-certified in the RE-CERT addendum below.]** **FINDING — `--preserve-modified` is silently ignored by the promote compounds (C6).** A `make-repeating --preserve-modified` then `undo` does NOT restore X's `userModificationDate`: no audit record carried `preModDates`, and X's `umd` was bumped by the (non-preserving) trash leg and again by the restore. The flag is a universal write flag but `legOptions` (promote-clone.ts) does not thread `preserveModified` onto the trash/restore legs and `appendPromoteSummary` records no `preModDates`, so neither the forward preservation nor the symmetric-undo restore (ratified 2026-08-13 §4) fires for a promote. Captured as an up-next item — a plumbing/design gap, not a make-repeating contract regression (X's content + `creationDate` restore correctly; only the `umd` is not neutralized).
7. **[RESOLVED — PR mg/uic8-fixes, 2026-08-13; re-certified in the RE-CERT addendum below.]** **FINDING (real bug) — `make-repeating` / `clone --preserve-created` fails on a to-do that carries a reminder (C1c).** For a source to-do with an item reminder on a dated/`today` `when`, the internal `clone(X, --preserve-created)` builds a base add carrying BOTH the reproduced `reminder` AND a backdated `createdAt` (`src/write/clone.ts` `todoAddParams`), which `src/write/commands.ts:325` forbids (`--reminder is not available with --created-at`). The compound aborts at the CLONE leg with `error code=unexpected` (exit 1) BEFORE trashing X, so **X is left completely untouched** (honest fail-safe) — but a reminder-bearing to-do cannot currently be made repeating or `--preserve-created`-cloned. The fix (sequence the reminder into a follow-up leg, or backdate creation via a `todo.set-dates` leg so the base add carries only one of the two) touches clone fidelity semantics and needs its own VM re-certification, so it is CAPTURED (up-next), not patched here. The content-rich HAPPY path is otherwise certified by C1c2 (notes/tags/checklist-with-a-checked-item/when=date/backdated `creationDate`).

## Method

One clone, ~20 min end to end. Each case: seed synthetic subjects via the shipped CLI / `things:///json` import, snapshot the guest DB (read-only, WAL-consistent) to host JSON, `warm` Things (quit → relaunch → 15 s → disable `AXEnhancedUserInterface`), drive the compound through the production CLI capturing the `--json` envelope (stdout) + warnings (stderr) + exit code, `settle` (quit), snapshot again, and assert observed DB row-state against the contract. Clock advances quit the app, `sudo date` (+1-day step), warm-relaunch (RSIM-S). `make-repeating`/`add-repeating` are ui-vector ops → `--dangerously-drive-gui`; `undo` and the direct-delete refusal probes are pure headless. Rule bytes decoded with the same plist reader UIC6/UIC7 used.

The certification asserts, per case, both axes the design promises: the **DB byte-effect** (X's fate + template/instance rows + rule bytes + cursor state) and the **JSON envelope** (`uuid`, `repeating{templateUuid,instanceUuid,replacedUuid}`, `undoToken`, warnings, exit code).

## C1 — `todo make-repeating` (fixed + after-completion)

| Case | Subject | Rule | Verdict |
|---|---|---|---|
| C1a | bare to-do | fixed weekly/1 | PASS — X trashed byte-intact; template (`tp=0 fu=256`) + today-instance minted; result contract + warnings exact |
| C1b | deadline to-do | after-completion weekly/1 | PASS — deadline preserved on the source-fate; X trashed byte-intact; `instanceUuid == replacedUuid` (the clone became the instance, RSIM-T preserve) |
| C1c | content-rich **with a reminder** (notes/tags/checklist-with-a-checked-item/reminder/when=today) | fixed daily/1 | **FINDING (bug)** — make-repeating aborts at the clone leg (`--reminder is not available with --created-at`, exit 1); **X left untouched** (reminder + checklist intact). See HEADLINE 7. |
| C1c2 | content-rich + **backdated `--created-at` 2026-06-01** / when=date / checklist-with-a-checked-item | fixed daily/1 | PASS — X's backdated `creationDate` byte-intact in the Trash; checklist (ck1 checked) intact; template + instance minted |

**Notes (CLI guards observed):** (i) `todo add` refuses `--reminder` together with `--created-at` (a backdated item cannot also carry a reminder). (ii) The SAME guard fires INSIDE the clone leg when the source has a reminder + `--preserve-created` — the C1c bug (HEADLINE 7). So the content-rich subject is split: C1c exercises the reminder dimension (and exposes the bug), C1c2 certifies the backdated-`creationDate` + checklist-checked happy path.

Every case asserts: `exit 0`; `result.uuid == repeating.templateUuid`; `templateUuid`/`instanceUuid`/`replacedUuid` present; X `trashed=1` with title/notes/`creationDate` byte-identical to the pre-snapshot; template `rt1_recurrenceRule` set + trashed=0 + title == X; instance `rt1_repeatingTemplate == template` + trashed=0; stderr warns of the trashed original + placement.

## C2 — `project make-repeating` (+ nested-repeater refusal)

| Case | Subject | Rule | Verdict |
|---|---|---|---|
| C2a | plain-children project | fixed weekly/1 | PASS — X trashed byte-intact; template minted with both children reproduced on the promoted subtree |
| C2b | heading + a completed child | after-completion weekly/1 | PASS — X trashed byte-intact; template carries the heading + children (the repeating template's children are the recurring OPEN set — the source's completed-child terminal state stays with X in the Trash, correct for a repeating series) |
| C2c | area'd project | fixed weekly/1 | PASS — **area preserved** on the clone-promote (template `area` FK == source area); X trashed byte-intact |
| C2d | project with a live nested repeating template | fixed weekly/1 | PASS (refusal) — `blocked:H-CLONE-SOURCE` exit 4, message names the nested child, **X untouched** (not trashed, no rule, `creationDate` unchanged) |

## C3 — undo round-trip (ratified trash-both + restore)

- **C3-todo:** make-repeating → a direct `todo delete <template>` refuses `blocked:H-REPEAT-SCHEDULE` (exit 4, template stays live) → `undo --txn <token>` trashes template (cursor → NULL) + instance, restores X live (Inbox) byte-intact (notes + `creationDate`). PASS.
- **C3-project:** same shape; X restored in place; template cursor cleared, instance trashed. PASS.
- **C3-advance:** +2-day clock roll (07-05 → 07-06 → 07-07) — **zero** new instances from either undone series (both cursors NULL). PASS.

This certifies the two honesty properties the design leans on: (i) the internal `internalSeriesRemoval` exemption is the ONLY headless way to trash a minted template (the public delete guard stays fully intact), and (ii) the undo genuinely kills generation (cursor cleared, no phantom spawns).

## C4 — `todo`/`project add-repeating` (fixed + after-completion)

| Case | Op | Rule | Spawn | Verdict |
|---|---|---|---|---|
| C4a | todo add-repeating | fixed weekly/1 | template + future cursor, **0 instances** (`instanceUuid` null) | PASS |
| C4b | todo add-repeating | after-completion daily/1 | **1 instance** immediately (`tp=1 fu=16`) | PASS |
| C4c | project add-repeating | fixed weekly/1 (`--todo` child) | template + child + future cursor, **0 instances** | PASS |
| C4d | project add-repeating | after-completion weekly/1 | **1 instance** immediately | PASS |

**Spawn-shape law (certified):** the one-instance-on-create shape is rule-type-dependent — an **after-completion** promote spawns its first instance immediately; a **fixed** promote whose first occurrence is in the future materializes only the template + cursor (0 instances), and the compound's `repeating.instanceUuid` is honestly `null`. Rule bytes decode to the requested vocabulary in every case. Undo removes the created series cleanly (no original to restore).

## C5 — failure rollback (Accessibility broken mid-compound)

Accessibility revoked (`tccutil reset Accessibility`, `auth_value → 0`) so the native-promote drive fails after clone+trash. Result: `verify-failed:silent-noop` (exit 3, "ui preflight refused: element for Items ▸ Repeat… did not resolve"). **X rolled OUT of the Trash** (trashed=0, notes + `creationDate` intact, no rule). One leftover disposable clone row persists (design: the un-promoted clone is not auto-cleaned; the error says "trash the clone and retry"). PASS — the §3 rollback restores the caller's item on a failed promote.

## C6 — symmetric umd-undo smoke (`--preserve-modified`)

`make-repeating --preserve-modified` then `undo`: X is restored live with content + `creationDate` intact, but its `userModificationDate` is NOT restored to the pre-write value (see HEADLINE 6). No audit record carried `preModDates`. **FINDING captured to up-next** — `--preserve-modified` is not threaded through the promote compound. Not a contract regression: the flag is best-effort and presence-keyed, and the make-repeating recover/restore contract is unaffected.

## Craft & oddities (recorded in the living docs)

- **Craft — the promote compound is honestly recoverable AND fail-safe.** On success the original survives in the Trash byte-intact and `undo` cleanly removes the series and restores it; on a mid-compound promote failure the original is rolled back OUT of the Trash and the error names the leftover clone. Both the happy path and the failure path leave the caller's item intact and recoverable.
- **Oddity (CLI guard) — `--reminder` and `--created-at` are mutually exclusive on `todo add`.** A backdated-creation to-do cannot also carry a reminder; the CLI refuses the combination at arg-validation ("--reminder is not available with --created-at").

## Manifest / register / matrix updates

- `src/write/vectors/ui-certification.ts`: UIC8 appended to `todo.make-repeating` / `project.make-repeating` evidence (now certified as the REWIRED clone→trash→promote compound, not only the native leg) and to the certification profile.
- `docs/reference/assumption-register.md`: RD-15 (SERDEL trash-both) + WG-8 *Confirmed under* updated with the UIC8 end-to-end certification of the compounds.
- `docs/capability-matrix.md`: the make/add-repeating + promote-via-clone rows note UIC8 lab-certification (golden-v2/3.22.12).
- `docs/design/promote-via-clone.md`: §3/§5 VM-certification "QUEUED" → certified (UIC8).

## RE-CERT addendum — HEADLINE 6 & 7 fixed (PR mg/uic8-fixes)

**Re-probed 2026-08-13 under the SAME golden — `things-lab-golden-v2` · Things 3.22.12 (build 32212016) · macOS 15.7.7 · DB schema v26 · pinned clock 2026-07-05 12:00.** ONE fresh disposable clone `uic8-lab` (golden untouched, torn down at teardown), airgapped, L3-accessibility baked, driven through the PRODUCTION CLI (guest e2e bundle). The two UIC8 findings (HEADLINE 6/7, C1c/C6 above — TRUE when captured, left intact) are now FIXED in the library; this addendum records the targeted re-run's verdicts. The original run's `C1c`/`C6` script cases were rewritten to assert the HAPPY path (the code they drove changed); every other case (C1/C2/C3/C4/C5) re-ran UNCHANGED and still passes. Full run: **PASS=191, FAIL=0.**

**The fix (both bugs, `src/write/{clone,promote-clone}.ts`):**
- **HEADLINE 7 / C1c — reminder+`createdAt` clone-leg collision.** `runCloneTodo` now detects a reproducible reminder on an OPEN dated/`today`/`evening` source when `--preserve-created` is active and SPLITS it: the base `todo.add` carries `createdAt` only (no reminder), and a follow-up `todo.update` leg re-supplies the source `when` together with the reminder (the R-suite-sanctioned when+reminder shape). Still one txn — undo trashes the whole minted clone. No split when `--preserve-created` is absent (the base add carries the reminder as before).
- **HEADLINE 6 / C6 — `--preserve-modified` silent no-op on the promote compounds.** `makeRepeatingViaClone` now threads `preserveModified` onto the trash-X leg (the ONLY leg touching a pre-existing row — the clone/promote legs mint fresh rows) so X's `umd` is preserved forward through the trash, and captures X's pre-write `umd` into the promote SUMMARY record's `preModDates` so the ratified symmetric-undo restore fires on the revived X. `add-repeating` touches no pre-existing rows → the flag stays a clean silent no-op there (unit-locked).

**C1c (RE-CERT) — reminder-bearing `todo make-repeating` (content-rich: notes/tags/checklist-with-a-checked-item/reminder `09:30`/when=today, FIXED daily/1).** Now **PASS** (was the exit-1 clone-leg abort): `exit 0`; X lands in the Trash **byte-intact** (title, notes, `creationDate`, `reminderTime = 635437056`, checklist `ck1:checked,ck2:open`); template + instance minted (`result.uuid == templateUuid`, `instanceUuid == replacedUuid` — the clone became the current instance); warnings disclose the trashed original + placement; and **the reminder is reproduced on the spawned instance** (`instance.reminderTime = 635437056`, identical to the source byte). The reminder-bearing source is now fully promotable and its reminder survives on both the trashed original and the live series.

**C6 (RE-CERT) — `todo make-repeating --preserve-modified` → `undo` (symmetric umd).** Now **PASS** (was the "umd not restored" finding): the audit SUMMARY record carries `preModDates`; **forward** — X's `umd` is preserved through the trash leg (`floor(umd1) == floor(umd0) = 1783425739`, X in the Trash off the `changes`/watch timeline); **undo** — X is restored live with `creationDate` intact AND its `umd` put back (`floor(umd2) == floor(umd0)`), so the reversal is symmetrically timeline-silent. (Comparison is on the floored second — the AppleScript `set modification date` restore lands on `floor(umd0)` per the 1-second floor.)
