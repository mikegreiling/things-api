# Probe backlog & in-flight validation plan

Durable plan (survives context compaction). Written 2026-07-09 after the L5 sitting; updated 2026-07-09 post-compaction after banking the first scf run. Tracks (A) the S-campaign follow-up probes, (B) the PR #42 ops validation, (C) parked work, and (D) release. Update the "STATUS" lines as each lands.

## ⟹ RESUME HERE (execution order)

1. ~~Bank §A round-1 results~~ — **DONE 2026-07-09** (PR #45): verdicts from `lab/artifacts/things-run-scf-20260709-041543/` folded into [s-campaign-results.md](s-campaign-results.md) (follow-ups table), capability-matrix, oddities (2e update + new 5k), gaps, o-suite-results.
2. **Validate PR #42** (§B): `npm run lab:regress` as a NO-REGRESSION check → merge on double-green. STATUS: pending.
3. ~~scf2 re-probe~~ — **RAN + BANKED 2026-07-09** (run `things-run-scf2-20260709-045454`; verdicts in [s-campaign-results.md](s-campaign-results.md) round 2): backdating = AppleScript-only for existing items + json at-creation import; reminder set via set-detail DEAD; set-detail Parent = DETACH footgun (oddity 5l); sidebar ordering exhaustively closed; Someday = new native reorder scope (P6h).
4. ~~P7/P8 lateral probes + operationalization~~ — **DONE 2026-07-09**: P7 (someday projects move; anytime moves loose to-dos; area detach/attach + when= round-trips FRONT-INSERT — Mike's bounce insight) and P8 (two-call someday protocol EXACT; inbox forward re-confirmed; 3-project when= bounce EXACT). Shipped: `todo.backdate`, `todo.add-logged`, reorder scopes `headings`/`someday`/`projects`. Evidence: [o-suite-results.md](o-suite-results.md) §P7/P8.
5. ~~npm publish~~ — **DONE 2026-07-09**: v0.6.0 tagged + published (`latest`), npx smoke green.
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

- **Deadline-less FIXED repeat encoding** (2026-07-11): every fixed rule in the live corpus deadlines its occurrences at the event date (deadline = start − ts, ts=0 included — all fixed-ts=0 templates are birthday-style and spawn deadline = start). Unknown: can the GUI even create a fixed repeat with NO deadline, and if so does it encode differently (the ts=0 plists for "deadline on the day" vs a hypothetical "no deadline" would otherwise collide)? Probe: create both shapes in a clone's GUI, diff `rt1_recurrenceRule`, observe spawned instances. Until then upcoming/projections assume fixed ⇒ deadlined (src/read/views.ts, src/model/occurrences.ts).
- **`TMSettings.logInterval` enum verification** (2026-07-10): the log-move boundary model (src/read/log-boundary.ts) has `1 = daily` VERIFIED live (Mike's DB: fresh completions absent from the GUI Logbook until the daily sweep); `0 = immediately`, `2 = weekly`, `3 = monthly`, and the manual-mode value are ASSUMED by analogy. Probe: flip the preference in a clone's GUI, diff TMSettings after each setting, and complete+observe an item across each boundary. Also confirm whether a mid-interval "log now" click updates `manualLogDate` (the boundary max()s it in).

- Lab runner/DSL **Shortcuts vector** support (guest input files + `shortcuts run --input-path`; interactive delete-class handling) so `s-suite.json` becomes a real recurring suite.
- **Distribution/onboarding** — IN PROGRESS 2026-07-09, new plan: the six proxies were EXTRACTED from the golden's `Shortcuts.sqlite` (`ZSHORTCUTACTIONS.ZDATA` action blobs, SX2/SX3), reconstructed as old-format plists, and host-signed with `shortcuts sign --mode anyone` → repo-distributable signed `.shortcut` files in `lab/shortcuts/` (no iCloud links, no manual rebuild). Import+run validation: SX4. Still open: shipping location + `things setup shortcuts` flow. Gotcha: the signer can't write to `/Volumes/*` — sign to /tmp, then move.
- ~~Headings doctrine decision~~ — **DECIDED 2026-07-09** (roadmap §E / gaps §0): first-class always, NO flatten/dual mode. The HX sweep closed every non-Shortcuts heading-create/move escape hatch (heading-research.md).
- **Availability layer** (Phase 21b remainder): advisory `availability(env)` per vector; doctor reads `uriSchemeEnabled`; correct the `feature-disabled` classifier to key on `uriSchemeEnabled`, not a null token.
- ~~someday PROJECTS characterization~~ — **LOCKED + SHIPPED 2026-07-09** (P9e: descending anchor-stack; inverted two-call protocol exact ×2 + predicted-failure control; someday scope now takes area-less someday projects).
- ~~heading archive surfaces (P10/P10b)~~ — **DONE 2026-07-09**, consolidated in [heading-research.md](heading-research.md): AS by-id rename + archive/un-archive WORK (no Shortcuts); URL/Shortcuts status writes no-op; AS delete −1728; move dead on 4 surfaces; SUSPECTED schedule-on-heading crash (oddities §6) → todo ops hard-block non-to-do targets. Area tag clear via empty set WORKS (P10e).
- ~~heading.rename / heading.archive / heading.unarchive~~ — **SHIPPED 2026-07-09** with children policies (complete/cancel/reparent) + transactional undo; P11 locked the design inputs (someday survives round-trips; cancel-cascade quirk 6a; pre-resolved children untouched).
- ~~Crash verification~~ — **CONFIRMED** (P11e process death; oddities §6). A captured .ips remains nice-to-have for the Cultured Code report.
- **Short-uuid prefix resolution** (Mike, 2026-07-09): accept uuid prefixes (≥6 chars) on every uuid parameter — indexed range scan (`uuid >= p AND uuid < p+1`), ambiguity → error listing matches; prod check: 21–22-char ids over ~21k rows make 6-char prefixes ~99.7% unique. Phase 2: render shortened ids in list views (per-list minimal unique length). Design agreed; implementation queued.
- ~~ANYTIME list-scope convention~~ — **CLOSED 2026-07-09 (P13)**: the reorder write is non-deterministic (identical inputs → different orders; Anytime is a computed aggregate). Will not ship.
- ~~incoherent-mutation crash sweep~~ — **DONE (P14)**: crash family = schedule-class on unschedulable rows (repeating to-do/project via URL when=; heading via AS schedule); everything else is graceful. Two fresh `.ips` captured; catalog in oddities §7. Novel find: AS `schedule` works on projects.
- **Round-3 (remaining)**: ~~ANYTIME convention~~ (done) (P7b vs P8d disagree under every candidate model — needs a systematic series); the hidden lists discovered in P9a (`list "Later Projects"`, `list "Tomorrow"`) as reorder specifiers; area'd someday projects in the someday scope; set-detail Parent with an ENTITY-typed value — a `things-proxy-move-item` whose Parent field takes a second Find Items output (needs a golden sitting, human present); P5 non-empty heading delete (human click, delete-class consent).
- ~~P12 interactive delete-class batch~~ — **DONE 2026-07-09** (Mike present): heading delete cascades (Trash: row vanishes + children reparented-then-trashed; permanent: subtree hard-deleted), project delete is shallow, areas have no Shortcuts delete surface. Banked in heading-research + s-campaign-results + matrix.
- **e2e reorder coverage**: the guest e2e smoke has NO reorder steps — add scope smoke steps (inbox/someday/headings/projects) in the next lab-touching change so the shipped protocols get periodic live validation.

## D. Release — publish `things-api` to npm (Mike, 2026-07-09)

Unscoped name `things-api` confirmed available; LICENSE (MIT) landed; repo prepped in PR #38. Steps: merge PR #42 first → decide version → move CHANGELOG `## Unreleased` under the version heading → `npm run check` + `npm pack --dry-run` sanity → git tag `vX.Y.Z` → `npm publish` (Mike's npm auth/OTP likely needed). STATUS: pending.
