# UI-vector certification runbook — in-VM suite + real-hardware confirmation

The ui vector ([design/ui-vector.md](../design/ui-vector.md)) ships with every op marked **UNCERTIFIED** in `src/write/vectors/ui-certification.ts`. This runbook confirms each recipe against a live Accessibility tree and **flips those entries to `certified`**.

**Two ways to run it, thanks to AXVM1.** The original plan assumed AX could only be exercised on real hardware (UI1 saw `osascript` → System Events return −1719 in the golden, and we read that as SIP blocking AX in the guest). **AXVM1 (PR #136) falsified that**: Accessibility IS grantable in a Tart guest (SIP on; a one-time user-path TCC toggle, persists reboot), element presses steal no focus and work under a locked session. So:

- **In-VM certification (primary, per Things version).** Clone the golden, apply the AXVM1 grant recipe, enable `ui.enabled`, and run the ops against the seeded library asserting the DB deltas. This is foldable into `lab:regress` and is the immediate follow-up (up-next §2). It certifies the recipes for the Things build in the golden.
- **Real-hardware sitting (final confirmation).** Run once on the target closet-mini against a **throwaway database** to confirm the recipes on the actual deployment hardware/build and to capture AXIdentifiers. This is a confirmation step, no longer the only path.

Both drive a **scratch/test Things database**, never a prod library.

**Safety rail — NEVER a prod library.** Every step drives a **scratch/test Things database**, never a real one. Do not run the certification suite against the machine's live library. See [Point at a throwaway database](#0-point-at-a-throwaway-database) first.

## What the sitting produces

- A confirmed, real-hardware element path for every step of all seven recipes (or a corrected path where the intended one was wrong).
- Captured **AXIdentifiers** wherever Things exposes one, so title-pinned steps can be upgraded to identifier-addressed (locale-proof).
- An answer to the **open question**: does AXPress work without foregrounding Things?
- The manifest (`ui-certification.ts`) flipped op-by-op to `certified`, each with the real-hardware evidence id appended.

## 0. Point at a throwaway database

The ui ops verify by DB diff, and three of them are irreversible identity replacements — they MUST run against disposable data.

- Create a fresh, empty Things library on the certification Mac (a dedicated user account, or a machine with no real data), OR
- Point things-api at a scratch DB copy via `--db <path>` for every command in this sitting, and confirm with `things doctor --db <path>` that it resolved the scratch file before any write.
- Seed a handful of subjects by hand or via the quiet vectors: a plain to-do (for `make-repeating`, `convert-to-project`), an already-repeating to-do built via the app's repeat editor (for `reschedule`, `pause`, `resume`, `stop`), and a heading inside a project (for `heading.convert-to-project`).

Confirm you are NOT on the prod library before proceeding.

## 1. Grant Accessibility (the TCC ladder)

Follow the setup.md hardening / TCC ladder ([setup.md](../setup.md) "Hardening against consent prompts" and "Closet-mini / ui vector"). The Accessibility grant attaches to the **driving process**, exactly like the Full Disk Access and Automation grants:

- Interactive: grant Accessibility to your terminal host (System Settings ▸ Privacy & Security ▸ Accessibility).
- SSH-driven: the grantee is `sshd-keygen-wrapper`; approve via Screen Sharing in a GUI session (Accessibility prompts cannot render headless).
- Confirm with `things doctor --probe-accessibility` — the opt-in probe that actively tests the grant (and will summon the consent dialog on an ungranted machine, which is its onboarding use, mirroring `--probe-automation`).

Keep the session **unlocked** for the whole sitting (LOCK1): a locked session presents only the lock screen.

## 2. Accessibility Inspector discovery pass

Before driving anything, walk each recipe's element paths in **Accessibility Inspector** (Xcode ▸ Open Developer Tool ▸ Accessibility Inspector) with Things frontmost and a subject selected. For each step in the [recipe addressing table](../design/ui-vector.md#recipe-addressing-table-intended--pending-certification):

1. Navigate to the element the recipe names and confirm the semantic path resolves (role, title, container chain).
2. **Record the AXIdentifier if one exists** — prefer it over the title in the recipe (locale-proof, copy-change-proof). Note which steps have one and which stay title-pinned.
3. Confirm the English titles match exactly (the recipes are English-pinned; note the exact `…` ellipsis characters and any trailing spaces).
4. For the `dynamic` steps (confirmation sheets, the repeat dialog, the card popover), trigger the action by hand and inspect the transient element — capture its path and identifier, and confirm the wait-for-element target is the right node.

Pay special attention to the **card-only Stop surface** (UI2-i): double-click the row → the card → the "↻ Repeat every …" bar → the popover (Change… / Pause / **Stop** / Show Latest) → the "Stop To-Do from Repeating" confirmation sheet. Confirm Stop is absent from the Items menu and the row context menu (asymmetry per oddities §8g), so the card recipe is the only path.

## 3. Answer the open question — background vs foreground AXPress

For at least one Tier-1 press recipe (pause is the cleanest — reversible), test **whether AXPress actuates the control without Things being frontmost**:

- Put another app frontmost, then run the pause recipe with the `activate-app` step disabled.
- Observe: did the menu path resolve and the press land while Things was in the background? Or did it require Things frontmost?

AXVM1 already answered this in the affirmative in a Tart guest (element presses stole no focus, worked under a locked session). Re-confirm it on the target build/hardware. If **background AXPress works** (expected): drop the `activate-app` preamble from the recipes entirely. If it **does not** on this build: keep the activate preamble and note the regression. Either way, capture the evidence.

## 4. Run the certification suite

For each op, against the scratch DB, run the real CLI command with both keys (`ui.enabled` set and `--dangerously-drive-gui`) and verify the DB-diff result matches the design doc's stated semantics:

| Op | Command (scratch subject) | Confirm |
|---|---|---|
| `todo.pause-repeat` | `things todo pause-repeat <ref> --dangerously-drive-gui` | `rt1_instanceCreationPaused` → 1, `rt1_nextInstanceStartDate` cleared, identity preserved, submenu now reads Resume |
| `todo.resume-repeat` | `things todo resume-repeat <ref> --dangerously-drive-gui` | pause flag → 0, identity preserved (round-trips step 1) |
| `todo.stop-repeat` | `things todo stop-repeat <ref> --dangerously-drive-gui` | confirmation sheet appeared; template uuid hard-deleted; NEW plain to-do with rule cleared; spawned instance survives; result returns the new uuid; card now shows no repeat bar (terminal) |
| `todo.convert-to-project` | `things todo convert-to-project <ref> --dangerously-drive-gui` | confirm sheet; original to-do uuid gone; new `type=1` project, notes preserved; result returns new project uuid |
| `heading.convert-to-project` | `things heading convert-to-project <ref> --dangerously-drive-gui` | confirm sheet; heading uuid gone; new project promoted into the parent project's area; former children reparented; result returns new project uuid |
| `todo.make-repeating` | `things todo make-repeating <ref> --frequency weekly --interval 1 --dangerously-drive-gui` | original uuid gone; NEW template (`rt1_recurrenceRule` weekly fu=256) + spawned instance; result returns new template uuid |
| `todo.reschedule-repeat` | `things todo reschedule-repeat <ref> --frequency monthly --interval 1 --dangerously-drive-gui` | same template uuid (identity preserved); rule bytes mutated (fu 256→8); `rt1_nextInstanceStartDate` advanced |

For each: confirm the **recipe canary preflight** passed (statically-reachable paths resolved) and that the **wait-for-element** steps found their dynamic elements within timeout. Deliberately test one **failure path** — e.g. rename/hide nothing but time out a sheet, or run with Accessibility revoked — to confirm the vector refuses cleanly and reports partial state honestly rather than pressing on a guess.

Also confirm the gating: the op is **unsupported** (exit 6) with `ui.enabled` unset, and **blocked** (exit 4, `H-UI-DRIVE`) when `--dangerously-drive-gui` is omitted.

## 5. Flip the manifest to certified

For each op that passed, edit `src/write/vectors/ui-certification.ts`: set `status: "certified"` and append the real-hardware evidence id (and the captured AXIdentifier notes / any corrected element paths) alongside the existing lab evidence id (UI2-a/b/c/d/i). Update the recipe data with any corrected paths and the captured AXIdentifiers (upgrading title-pinned steps where an identifier was found). Then:

- `things capabilities` should now report the op as certified.
- `things doctor --probe-accessibility` per-op certification lines should reflect it.
- Certified ops no longer carry the uncertified warning in their result envelope.

Record the sitting in the design doc's cross-links and note the certified Things version (mirroring the [things-update-runbook](things-update-runbook.md) certified-version discipline) — a future Things update re-opens certification for any recipe whose menu/paths changed.

## Notes

- This sitting is **human-present** by nature (Accessibility grant, unlocked GUI session, Inspector work) — it belongs alongside the other "needs a human present" short sittings, not in the autonomous VM lab.
- If AXVM1 later proves Accessibility can be granted in a Tart guest, port the step-4 suite into a `lab:regress` arm so recertification after a Things update becomes automated; keep this real-hardware runbook as the fallback and the identifier-discovery pass.
</content>
</invoke>
