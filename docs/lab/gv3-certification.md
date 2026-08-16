# GV3 — golden advance + certification to Things 3.22.14 (golden-v3)

**Probed under: `things-lab-golden-v3` · Things 3.22.14 (build 32214000) · macOS 15.7.7 · DB schema v26 · pinned clock 2026-07-05 12:00 (a Sunday).** golden-v3 was built by the drift-runbook DRIFT-1 in-place path: an APFS-COW clone of `things-lab-golden-v2` (3.22.12) with `/Applications/Things3.app` swapped 3.22.12 → 3.22.14 (via `ditto -xk` of the pristine Cultured Code direct-download zip — preserves framework symlinks), a warm-up launch, then fingerprint + sdef re-verify. All v2 human-seeded layers (seed dataset, TCC AppleEvents/FDA/Screen-Recording/Accessibility, disruption-monitor LaunchAgent, six Shortcuts proxies, the AXVM1 L3-accessibility grant) inherited byte-for-byte. Metadata: [golden-v3-metadata.json](golden-v3-metadata.json). Build artifacts (gitignored): `lab/artifacts/gv3-build/`. Fixtures fully synthetic.

This campaign advances the golden to characterize the two reported 3.22.14 field regressions (#479 CHKT1, #480 ADR1) whose fixes were gated on it. **Headline: neither regression reproduces in a clean airgapped 3.22.14 lab clone.** 3.22.14 is a BEHAVIORAL-only update relative to 3.22.12: zero schema/sdef delta, zero regress flips, byte-identical repeat-rule format.

## Staged app

Cultured Code direct download (`static.culturedcode.com/things/Things3.zip`, last-modified 2026-08-14) served exactly **3.22.14 / CFBundleVersion 32214000** — the version to certify (reachability gate PASSED; had a newer-only build been served with no 3.22.14 archive reachable, this would have STOPPED per the runbook). zip sha256 `e37f927900a517e21fae1883a889a41d25402bdfa8c64b88705b3aa8812b7e1e`. Signature: notarized Developer ID "Cultured Code GmbH & Co. KG (JLMPQHK86H)", `codesign --verify --deep --strict` OK. `LSMinimumSystemVersion 10.15.0` (runs on the golden's macOS 15.7.7 despite the macOS-26 build SDK). Stashed at the PRIMARY checkout `lab/apps/Things3-3.22.14.app` (durable, gitignored). The direct-download channel build (32214000) differs from the maintainer's MAS channel build number, as with v1/v2 — the same-marketing-version, different-build-number parity noted in `vendor/manifest.json`.

## Structural gates (fingerprint / sdef) — PASS, byte-identical to v2

| Gate | 3.22.12 (v2) | 3.22.14 (v3) | verdict |
|---|---|---|---|
| `databaseVersion` (Meta) | 26 | 26 | unchanged |
| schema fingerprint | `sha256:784bd2f6533e6f85e053b0ec68958083d4ebca11c152ad1d2935178240d4c52b` | `sha256:784bd2f6…` (host `doctor --db --json`, `fingerprint.status=ok`) | **byte-identical** |
| sdef sha256 | `1b6752334207f68cdcb7e71dfc34a21407095bd239afe5df6b3cdd8e2c70cde0` | `1b675233…` | **byte-identical** — still declares `_private_experimental_ reorder to dos in` (reorder canary intact) |

No drift-runbook baseline needed; no schema-chain / simulator / bench re-model needed (the `SIMULATED_DATABASE_VERSION` fence is unmoved at v26). Extra columns are all recognized warn-only (excluded from the hash), same set as v2.

## Full behavioral regress (`lab:regress`, golden-v3) — GREEN, zero flips

Every suite ran GREEN against fresh v3 clones (bootstrap fingerprint assertion passed each run); the write-layer e2e ran 132/132 after a harness fix (below):

| Suite | probes | result |
|---|---|---|
| u | 23 | GREEN (U12 `when=` on a repeating template STILL crashes — expected; guard stays) |
| a | 40 | GREEN |
| x | 3 | GREEN |
| o | 39 | GREEN |
| r | 21 | GREEN (R09 schedule-write on a repeating template STILL crashes — expected) |
| e | 19 | GREEN (E13 duplicate-on-template still dead, tier-3) |
| p | 30 | GREEN |
| s | 4 (+2 interactive skipped) | GREEN — Shortcuts proxies + `set-detail` clear all work under 3.22.14 |
| e2e write smoke | 132 steps | GREEN, 0 failures |

**No verdict/tier/crash flip vs the v2 (3.22.12) baseline on any probe.** The crash catalog is unchanged: the schedule-class template crashes (U12, R09) still reproduce on 3.22.14, so the `H-REPEAT-SCHEDULE` write guards stay in place (the crash is NOT fixed in 3.22.14).

### e2e harness fix (pre-existing staleness, NOT a golden flip)

The first e2e run showed 2 failures — steps [88] `todo backdate` and [89] `todo add-logged`, both `unknown option '--completed-on'` (exit 1). This is a **CLI-parse error that fires before any app interaction**, so it fails identically on any golden — pre-existing rot in the guest driver `lab/guest/e2e-write-smoke.sh`, not a 3.22.14 behavior change. The bespoke `todo backdate` / `todo add-logged` commands were removed in an earlier CLI refactor (see `src/cli/commands/writes.ts` NB); the guest driver still used them. Fixed to the current vocabulary (`todo update --created-at/--completed-at` for rewriting timestamps; `todo add --created-at/--completed-at` for a born-logged import). Re-run: 132/132 GREEN.

## #479 (CHKT1) — checklist writes on a repeating TEMPLATE — DOES NOT REPRODUCE on 3.22.14

Re-ran `lab/scripts/research-chkt1.sh` with `GOLDEN=things-lab-golden-v3`. The exact #479 repro against a repeating to-do template:

- Phase 0: `todo checklist <template> --item "Synthetic room A".."D"` → **`ok`** · `todo.replace-checklist` · url-scheme · exit 0. All four items landed on the template row (`TMChecklistItem` verified). No silent no-op.
- Phase A: URL `checklist-items=` (replace) and `append-checklist-items=` (append) both WORK on the template; Shortcuts `set-detail Checklist` is a silent no-op (can't set — unchanged); AppleScript has no checklist class (A30 — unchanged).
- Phase A5: clock-advance +1 day spawned a fresh instance that **inherited all four template checklist items, each reset to open** — propagation works.

**Verdict:** identical to 3.22.12. The `H-REPEAT-SCHEDULE` allow-list copy ("checklist replacement remain allowed on templates") is CONFIRMED truthful on 3.22.14. The reported `verify-failed:silent-noop` is NOT a reproducible-in-lab 3.22.14 version regression. **No branch-3 refusal shipped** — a refusal would break a working, verified feature and fail `lab:regress`. Per the campaign gate ("if 3.22.14-in-lab does NOT show the drop, report the anomaly — do not guess"), this is reported, not guessed at. See the anomaly note below.

## #480 (ADR1) — add-repeating Repeat-dialog — DOES NOT REPRODUCE on 3.22.14

Re-ran `lab/scripts/research-adr1.sh` with `GOLDEN=things-lab-golden-v3` (current shipped code, post-#483). The full repro matrix:

| Cell | added vocabulary | result | first occurrence |
|---|---|---|---|
| bare | (when only) | `ok` · todo.add-repeating · ui · exit 0 | 2026-08-26 (`rt1_instanceCreationStartDate=132812032`) |
| +area | `--area "Synthetic Area"` | `ok` | 2026-08-26 |
| +tag | `--tag recurring` | `ok` | 2026-08-26 |
| +area+tag | both | `ok` | 2026-08-26 |
| +reminder | `--reminder 18:00` | `ok` | 2026-08-26 |
| **full (issue combo)** | `--area … --tag recurring --reminder 18:00 --notes …` | `ok` | 2026-08-26 |

**Every cell PASSED**, including the exact full issue combo. The `things:///show?id=` reveal selected the seed row on every surface and `Items ▸ Repeat…` was ENABLED (`exists=true enabledClosed=true enabledOpen=true`). The Repeat dialog appeared and the recipe drove all 10–12 steps every time. The disabled-menu-masking failure hypothesized in #480 does NOT occur on 3.22.14 in-lab.

**Verdict:** identical to 3.22.12. No root-cause reveal fix is shippable — there is no golden bug to fix. The #483 defensive fixes (eligibility assertion + seed auto-trash) stand and were re-certified (below).

### ADR1 re-cert (fixed build, golden-v3) — `research-adr1-recert.sh` — PASS

- **A. Happy path (full issue combo) — PASS.** Template created with the eligibility assertion inline (drove 12 steps incl. "confirm the target is selected and Items ▸ Repeat… is enabled → … → Next (first occurrence) = 2026-08-26 → check Add reminders → reminder = 18:00 → OK"). DB: `rt1_instanceCreationStartDate=132812032` (= 2026-08-26, Next honored) and template `reminderTime=1207959552` (= 18:00, `hour<<26`, reminder committed onto the SERIES). No regression from the assertion.
- **B. assert-eligible on real 3.22.14 AX — PASS.** Properly-selected reveal → `OK`; a deselected list view → `NOTSEL no to-do is selected after the reveal (expected <uuid>)`. The primary #480 protection names a disabled-menu no-op with a real diagnostic on 3.22.14 hardware.
- **C. Forced-failure path — same as 3.22.12.** The leftover-open-Repeat-dialog sabotage over-blocks the CREATE leg (URL-scheme `todo.add` silent-noops while a modal is open), so no seed is created and there is nothing to auto-trash (`verify-failed:silent-noop`, exit 3, no residue — itself safe). The auto-trash + honest-uuid contract stays certified by the deterministic unit tests (`test/engine/write-promote-clone.test.ts`). Identical to the v2 re-cert — no flip.

## Repeat-rule deep-check (blob corpus · rrv · dialog) — byte-identical to 3.22.12

Seeded representative templates via the production `add-repeating` on golden-v3 and decoded every `rt1_recurrenceRule` (`lab/scripts` deep-check; artifacts `lab/artifacts/gv3-repeat-deepcheck/`):

| Template | decoded rule (3.22.14) | matches 3.22.12? |
|---|---|---|
| daily/1, when 08-26 | `rrv=4 tp=0 fu=16 fa=1 of=[{dy=0}] ia=sr=next=icStart=2026-08-26` | yes |
| weekly/2/wed, when 08-26 | `rrv=4 fu=256 fa=2 of=[{wd=3}] ia=sr=next=icStart=2026-08-26` | yes (= ANCH2 RC1) |
| monthly/2, when 09-15 | `rrv=4 fu=8 fa=2 of=[{dy=0}] icStart=sr=2026-09-15 ia=next=2026-10-01` | yes (= ANCH2 RC3) |
| yearly/2, when 2028-03-10 | `rrv=4 fu=4 fa=2 of=[{dy=0,mo=0}] icStart=sr=2028-03-10 ia=next=2029-01-01` | yes (= ANCH2 cell c) |
| weekly/1/wed + ends-on 12-30 | `rrv=4 fu=256 fa=1 of=[{wd=3}] ed=2026-12-30 ia=sr=next=icStart=2026-08-26` | yes — `ed` distinct from Next, **no §8v collapse** (= ANCH2 RC4) |

- **`rrv=4` on every rule** — the rule version is UNCHANGED (no bump). The step-9 tripwire "rrv bump with undecodable rules" is NOT triggered. `doctor` repeats canary reports no undecodable templates.
- Identical plist key set (`['ed','fa','fu','ia','of','rc','rrv','sr','tp','ts']`). The repeat-rule storage format is byte-for-byte the same as 3.22.12 — 3.22.14 did not change repeat handling at the format level.
- **Repeat dialog:** the "Next:" first-occurrence control is present and drivable — proven functionally by the Next-field values landing exactly across the entire corpus and by the ADR1 re-cert's 12-step drive committing Next + reminder deterministically. (A bare isolated AX-inventory dump — a menu-click census WITHOUT the recipe's reveal/foreground/eligibility sequence — did not leave the sheet open at dump time and returned an empty inventory; that is a census-mechanism limitation, superseded by the conclusive functional drivability. Control targeting is unchanged: had the AXDateTimeArea indices shifted, the deterministic `set-datetime` targeting would have written into the wrong field and the decoded bytes would be wrong — they are exactly right.)

This structural + functional identity of the Repeat dialog is precisely WHY #480 does not reproduce.

## Surface re-sweeps

- **sdef diff:** byte-identical (above) — no new verbs/classes; reorder canary intact.
- **T/U-suite + historically-dead shapes:** covered by the green u/o/e/p regress (heading-create-via-URL still dead U09; `when=` on template still crashes U12; duplicate-on-template still dead E13) — no historically-dead shape flipped to working.
- **Shortcuts proxies (s-suite):** all output-class proxies + `set-detail` clear run green on 3.22.14 — the six golden-resident proxies inherited via COW still execute. (A full L5 Card-5 action-catalog re-enumeration — "did Cultured Code add new Things Shortcuts actions or repeat-rule parameters in 3.22.14?" — is a Shortcuts.app inspection not driven here; the proxy round-trip working is the load-bearing check for our shipped surface. Queued as a follow-up if the repeating-items capability gap is revisited.)
- **Crash catalog:** the schedule-class template crashes (U12, R09) STILL reproduce on 3.22.14 — guards kept, fix version not yet reached.

## The anomaly (report, not a guess)

Both #479 and #480 were filed "from Things 3.22.14" on the maintainer's host, yet NEITHER reproduces in a clean, airgapped 3.22.14 lab clone running the identical build family, with schema/sdef/repeat-format all byte-identical to 3.22.12. The version tuple (3.22.14) is therefore NOT sufficient to explain the reports; the differentiator is something the lab does not replicate. Candidate factors (unprobed here — the sync lab account was deliberately untouched):

1. **Active Things Cloud sync** on the host (the lab is airgapped, account-less) — checklist writes / repeating-conversion racing with a sync round-trip, or a synced template with server-side state.
2. **Production DB scale/state** (the lab seed is small + synthetic) — a specific repeating template, a large Logbook, or stale window state (cf. the RESID1 `⌘,` stale-window flake — the recipe's own quit+relaunch hygiene may sidestep a transient state the field report hit).
3. **MAS build channel** (host 3222145xx MAS vs lab 32214000 direct download) — unlikely for these behaviors, but not excluded.

Because the drop does not reproduce, it is NOT logged as a confirmed app oddity, and NO version-gated refusal or reveal fix is shipped. The system already degrades SAFELY on the host regardless: the fail-closed read-after-write verify catches any silent no-op (`verify-failed:silent-noop`, clear error, no bad state), and the #483 eligibility assertion + auto-trash remove the #480 residue/ambiguity half deterministically. Recommended next step if the reports persist on the host: re-file with a `things doctor --json` capture + the exact template's decoded rule, and probe the sync-active axis on the durable lab account.

## Certification status

golden-v3 (Things 3.22.14) is CERTIFIED as the active golden: structural gates byte-identical to v2, `lab:regress` green with zero flips, repeat-rule format + dialog identical, the shipped #476/#480/#483 defenses re-certified. `lab/runner/run.ts` `GOLDEN`, `docs/lab/golden-v3-metadata.json`, `lab/scripts/regress.sh` + `e2e-write-smoke.sh` now target v3; `things-lab-golden-v2` is retained as the certified fallback (deletion is the maintainer's call). Follow-ups for the maintainer: `things config set certified-app-version 3.22.14` on the host (silences the passive doctor drift notice); one confirmatory second `lab:regress` pass for the two-run acceptance gate.
