# Probe backlog & in-flight validation plan

Durable plan (survives context compaction). Written 2026-07-09 after the L5 sitting. Tracks (A) the autonomous S-campaign follow-up probes, (B) the PR #42 ops validation, and (C) parked work. Update the "STATUS" lines as each lands.

## ⟹ RESUME HERE (post-compaction execution order)

Mike compacts the context, THEN this runs. Nothing is running now (no VMs). Do, in order:

1. **Bank §A results.** The probe run in `lab/scripts/research-scampaign-followups.sh` ALREADY RAN — raw evidence is on disk at `lab/artifacts/things-run-scf-20260709-041543/report.txt` (+ `final.sqlite`). NOT yet analyzed or banked. Read it, extract the P1–P4 verdicts (heading reorder / set-detail Parent / Reminder on scheduled + dated-clear / Completion+Creation backdating), and fold them into `docs/lab/s-campaign-results.md`, `docs/capability-matrix.md`, and `docs/things-app-oddities.md` (per the CLAUDE.md living-doc contract). Commit on a branch → PR → merge.
2. **Validate PR #42** (§B). Decided approach: run `npm run lab:regress` as a NO-REGRESSION check (it exercises the reorder pipeline/guards/pre-state I changed + the guest e2e). Hand-authoring new recurring suite probes was deferred — unattended, a malformed ordering-assertion would block the merge on 40-min iterations, and the four ops are already validated by the A1–A6 real-app probes + 382 unit/engine tests. If regress is double-green → merge PR #42 (`mg/phase21b-ops`, currently OPEN). If it fails, diagnose (that's the check working).
3. Optionally then author careful recurring suite probes (§B step 1) with an iteration budget, and pick up §C.

Everything below is the detailed spec. `git log` on `main`: #40/#41/#43 merged; #42 open (ops, awaiting this regress).

## A. S-campaign autonomous follow-up probes — `lab/scripts/research-scampaign-followups.sh`

Run in ONE disposable clone (golden `things-lab-golden-v1`, stopped/frozen 2026-07-09; clones inherit the Shortcuts output-class Always-Allow grants, so `set-detail`/`find-items`/`create-heading` run headless — deadline-wrap every `shortcuts run` so a consent-didn't-transfer surprise can't wedge). All four are autonomous (no human click). Evidence → `docs/lab/s-campaign-results.md` + capability-matrix/oddities.

- **P1 — heading reorder via the private command (Mike's sharp question).** The `_private_experimental_ reorder to dos in project id <P>` command is misleadingly named — it accepts PROJECT uuids in an area scope (O14, class inheritance). Untested: does it accept HEADING uuids (type=2) as project children? Use seed `LAB-PROJ-HEADINGS` (Dwr1MiANqMFvAWddgGgzVX) with headings Alpha (5saDdJcodvWARN9Ct2nQsT) + Beta (M7QEqPbk6v9jZZ6CBiyaP3). Reorder `with ids "<Beta>,<Alpha>"`; compare the headings' `"index"` before/after. Outcome ∈ {reorders them (heading ordering UNLOCKS — correct the "unautomatable" claim), errors (heading ∉ `to do` class), no-op}. STATUS: pending.
- **P2 — `set-detail` Parent = move a heading to another project.** create-heading (headless) makes a heading in project A; `set-detail {id:<heading>, detail:"Parent", value:<project B uuid>}`; check `TMTask.project` of the heading. Also try it on a to-do (re-parent between projects). STATUS: pending.
- **P3 — `set-detail` Reminder Time on a SCHEDULED item + clear a DATED reminder.** (a) to-do `when=today`, set-detail Reminder Time "14:30" → expect `reminderTime=970981376`. (b) to-do with a DATED reminder (`when=2026-07-10@09:00` via URL), then set-detail Reminder Time to ""/clear → does it CLEAR? (the sticky-dated-reminder gap, oddity 2e — the one thing URL can't do). STATUS: pending.
- **P4 — Completion Date / Creation Date backdating.** Complete a to-do, `set-detail {detail:"Completion Date", value:<past ISO>}` → check `stopDate`. `set-detail {detail:"Creation Date", value:<past ISO>}` → check `creationDate`. No other surface writes these (GTD migration use case). STATUS: pending.
- **P5 (NEEDS A HUMAN CLICK — not in this script)** — delete a NON-empty heading: do the children re-parent to the project root (expected), orphan, or cascade-delete? Delete-class consent re-prompts every run (oddity 5j), so this waits for a human. STATUS: parked.

## B. PR #42 validation (project tags/reminders, tag-shortcut clear, inbox reorder)

1. Recurring regression probes added to the suites (encode the A1–A6 deltas): e-suite (project tags URL+AS, project reminder, tag shortcut CLEAR) + o-suite (inbox reorder). STATUS: pending.
2. `npm run lab:regress` (7 suites + guest e2e, ~40 min) — proves no regression AND the new probes pass. STATUS: pending.
3. On double-green → merge PR #42. STATUS: pending.

## C. Parked (bigger, not auto-runnable now) — task #7

- Lab runner/DSL **Shortcuts vector** support (write JSON input to a guest file + `shortcuts run --input-path`; interactive delete-class handling) so `s-suite.json` becomes a real recurring suite.
- **Distribution/onboarding**: produce signed / iCloud-shareable proxies from a network Mac with an Apple ID; a `things setup shortcuts` import + first-run-consent flow. (Golden is airgapped + Apple-ID-less, so it can only make unsigned copies.)
- **Headings doctrine decision** (gaps §0): flatten-only vs dual-mode, now that Shortcuts delivers the lifecycle.
- **Availability layer** (Phase 21b remainder): advisory `availability(env)` per vector; doctor reads `uriSchemeEnabled`; correct the `feature-disabled` classifier to key on `uriSchemeEnabled`, not a null token.
