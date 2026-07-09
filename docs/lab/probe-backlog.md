# Probe backlog & in-flight validation plan

Durable plan (survives context compaction). Written 2026-07-09 after the L5 sitting; updated 2026-07-09 post-compaction after banking the first scf run. Tracks (A) the S-campaign follow-up probes, (B) the PR #42 ops validation, (C) parked work, and (D) release. Update the "STATUS" lines as each lands.

## ⟹ RESUME HERE (execution order)

1. ~~Bank §A round-1 results~~ — **DONE 2026-07-09** (PR #45): verdicts from `lab/artifacts/things-run-scf-20260709-041543/` folded into [s-campaign-results.md](s-campaign-results.md) (follow-ups table), capability-matrix, oddities (2e update + new 5k), gaps, o-suite-results.
2. **Validate PR #42** (§B): `npm run lab:regress` as a NO-REGRESSION check → merge on double-green. STATUS: pending.
3. ~~scf2 re-probe~~ — **RAN + BANKED 2026-07-09** (run `things-run-scf2-20260709-045454`; verdicts in [s-campaign-results.md](s-campaign-results.md) round 2): backdating = AppleScript-only for existing items + json at-creation import; reminder set via set-detail DEAD; set-detail Parent = DETACH footgun (oddity 5l); sidebar ordering exhaustively closed; Someday = new native reorder scope (P6h).
4. ~~P7/P8 lateral probes + operationalization~~ — **DONE 2026-07-09**: P7 (someday projects move; anytime moves loose to-dos; area detach/attach + when= round-trips FRONT-INSERT — Mike's bounce insight) and P8 (two-call someday protocol EXACT; inbox forward re-confirmed; 3-project when= bounce EXACT). Shipped: `todo.backdate`, `todo.add-logged`, reorder scopes `headings`/`someday`/`projects`. Evidence: [o-suite-results.md](o-suite-results.md) §P7/P8.
5. **npm publish** (§D). STATUS: pending (blocked on Mike's `npm login`; v0.4.0 tagged — the new ops warrant either re-tagging or a fast-follow 0.5.0).
6. Parked §C work.

## A. S-campaign follow-up probes

### Round 1 — `lab/scripts/research-scampaign-followups.sh` — RAN + BANKED (run `things-run-scf-20260709-041543`)

- **P1 — heading reorder via the private command.** STATUS: **WORKS** 🎉 — heading uuids accepted in a project specifier; children follow. Banked.
- **P2 — `set-detail` Parent = heading move.** STATUS: **SILENT NO-OP** — heading move dead on all surfaces. Banked. (To-do re-parent variant NOT attempted → P2b, round 2.)
- **P3a — `set-detail` Reminder Time "14:30" on a scheduled to-do.** STATUS: **NO-OP** (text→Date coercion suspect) → format experiments, round 2.
- **P3b — clear a DATED reminder via empty value.** STATUS: **WORKS** 🎉 — oddity-2e gap closed (Shortcuts-only, headless). Banked.
- **P4 — Completion/Creation Date backdating.** STATUS: **INVALID RUN** (two script bugs: completion via `things:///update` WITHOUT the auth token → fixture never completed; stale `--output-path` file aliased P4 output to P3b's). → redo, round 2.
- **P5 (NEEDS A HUMAN CLICK)** — delete a NON-empty heading: do children re-parent, orphan, or cascade? Delete-class consent re-prompts every run (oddity 5j). STATUS: parked.

### Round 2 — `lab/scripts/research-scf2.sh` — RAN + BANKED (run `things-run-scf2-20260709-045454`)

One clone, autonomous. Harness fixes learned from round 1: `proxy()` must `rm -f /tmp/scf-out.txt` before each run; completion must go through AppleScript (`set status of to do id X to completed`) or URL WITH the auth token (read it from the guest defaults/plist as phase21b did).

- **P4 redo — backdating.** Complete a fixture properly (verify `status=3`/stopDate in DB before proceeding), then: (a) Shortcuts `set-detail` Completion Date with several value shapes (ISO `2025-01-15`, locale `1/15/2025`, `January 15, 2025`); (b) AppleScript `set completion date of to do id X to date "..."`; (c) URL `things:///update?...&completion-date=...` (+auth token). Same trio for Creation Date. Check `stopDate`/`creationDate` deltas after each.
- **P3a redo — Reminder Time set formats.** On a `when=today` fixture: `set-detail` Reminder Time with `"2:30 PM"`, `"14:30"` re-check, full datetime strings. Expect `reminderTime = hour<<26 | minute<<20`.
- **P2b — `set-detail` Parent on a TO-DO** (re-parent between projects) — the heading variant no-op'd; does it work for to-dos?
- **P6 — sidebar order, remaining spellings** (Mike's insight: Anytime view order mirrors sidebar order — consistent with both reading the same `index`; the two probed spellings are dead: O13 `move area to before area` errors, P17 private reorder in `list "Anytime"` with top-level project uuids no-ops). Untried spellings to sweep: (a) AppleScript `move project id X to before project id Y` (location specifier on projects, never probed — O13 only tried areas); (b) `set index of project/area` (property write); (c) private reorder in `list "Anytime"` with AREA uuids; (d) private reorder in `list "Someday"`; (e) grep the full sdef dump for any other `_private_` commands we haven't inventoried. Evidence target: `TMTask."index"` (top-level projects) / `TMArea."index"` (areas).

## B. PR #42 validation (project tags/reminders, tag-shortcut clear, inbox reorder)

1. `npm run lab:regress` (7 suites + guest e2e, ~40 min) — no-regression check (exercises the reorder pipeline/guards/pre-state PR #42 touches). STATUS: pending.
2. On double-green → merge PR #42 (`mg/phase21b-ops`, OPEN). STATUS: pending.
3. Recurring suite probes encoding the A1–A6 deltas (e-suite: project tags URL+AS, project reminder, tag shortcut clear; o-suite: inbox reorder) — deliberately deferred; author later with an iteration budget. STATUS: deferred.

## C. Parked (bigger, not auto-runnable now)

- Lab runner/DSL **Shortcuts vector** support (guest input files + `shortcuts run --input-path`; interactive delete-class handling) so `s-suite.json` becomes a real recurring suite.
- **Distribution/onboarding**: signed / iCloud-shareable proxies from a network Mac with an Apple ID; a `things setup shortcuts` import + first-run-consent flow.
- **Headings doctrine decision** (gaps §0): flatten-only vs dual-mode — Mike's call. New input since: heading REORDER is native/AppleScript (scf P1), heading MOVE is dead everywhere (scf P2).
- **Availability layer** (Phase 21b remainder): advisory `availability(env)` per vector; doctor reads `uriSchemeEnabled`; correct the `feature-disabled` classifier to key on `uriSchemeEnabled`, not a null token.
- **Round-3 probe candidates**: ANYTIME list-scope convention (P7b vs P8d disagree under every candidate model — needs a systematic series); someday PROJECTS in the Someday scope (P7a vs P8c inconsistent — would extend the sidebar story to someday-project rows); set-detail Parent with an ENTITY-typed value — a `things-proxy-move-item` whose Parent field takes a second Find Items output (needs a golden sitting, human present); P5 non-empty heading delete (human click, delete-class consent).
- **e2e reorder coverage**: the guest e2e smoke has NO reorder steps — add scope smoke steps (inbox/someday/headings/projects) in the next lab-touching change so the shipped protocols get periodic live validation.

## D. Release — publish `things-api` to npm (Mike, 2026-07-09)

Unscoped name `things-api` confirmed available; LICENSE (MIT) landed; repo prepped in PR #38. Steps: merge PR #42 first → decide version → move CHANGELOG `## Unreleased` under the version heading → `npm run check` + `npm pack --dry-run` sanity → git tag `vX.Y.Z` → `npm publish` (Mike's npm auth/OTP likely needed). STATUS: pending.
