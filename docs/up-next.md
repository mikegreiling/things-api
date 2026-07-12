# Up-next queue (parked 2026-07-12, post-v0.8.0)

The working queue for the next session(s). Everything here was triaged with Mike on 2026-07-12 after the v0.8.0 release (PRs #73–#85: Shortcuts write vector + live validation, reversible/guarded undo, checklist intent undo, reversibility matrix, trash-cascade fix, the `things projects` sidebar mirror, upcoming window, hidden-item hints, `--when` validation, capabilities undo column). Read `docs/roadmap.md` for the long-lived doctrine; THIS file is the short-horizon pick list. Remove items as they land.

## 1. Decisions Mike needs to make (blocked on him, near-zero effort)

- **Hide `── Repeating To-Dos ──` behind a flag in `upcoming`?** The dateless resting-template section (~15 rows in his library) always renders and survives every `--until` bound (a date bound can't apply to dateless rows — deliberate, PR #77). If maximum brevity wins, add `--repeats`/`--all`-style gating.
- **Today/anytime showing checked-unswept items?** Closed items the log-move sweep hasn't passed stay checked in place in project/area views (GUI parity, completion≠logged model). Whether the flat `today`/`anytime` lists should also show them was flagged ~2026-07-10 and never ruled.
- **Stateful display preferences** (roadmap §H): config-file/env defaults for the growing toggle family (`--show-later`, `--show-logged`, `--until`, `--all`). Decide the config surface + precedence; wary of plist-driven defaults confusing agents.
- **Glyph palette doc + `⧉`**: Mike asked whether `⧉` (U+29C9) was ever considered (it wasn't — whole blocks like Misc Math Symbols-B were never mined). Open offer: a curated single-cell/color-safe candidate inventory under `docs/design/` to feed future picks and the §H cross-terminal audit. Also unanswered: did Mike have a slot in mind for `⧉`?
- **When to send the Cultured Code report**: `docs/things-app-oddities.md` is effectively the draft (crashes §1/§6/§7, silent-failure families §2/§5, the double-trash black hole §6½). Last evidence gaps below.

## 2. VM lab campaigns (autonomous; batch them — they share clone setup)

- ~~**Double-trash black hole screenshots (oddity 6½)**~~ — **DONE 2026-07-12** (run `things-run-r3-20260712-171142`, PR mg/lab-round3): 4-shot report-ready sequence banked at `lab/artifacts/things-run-r3-*/oddity-6half/`, referenced from oddities §6½. Ready for the CC report submission (§3).
- ~~**scf2 round-3 probes**~~ — **DONE 2026-07-12** (research-scf3.sh): P4/P3a/P2b all reconfirmed (Shortcuts backdating DEAD, AS WORKS, URL NO-OP, json WORKS; reminder SET DEAD; Parent = DETACH footgun). **P6 CLOSED** — sdef inventory = exactly one `_private_` command (no sidebar-reorder spelling; sidebar order stays UI-only), and the **Someday reorder convention is LOCKED** (reversed wire-list, matches Inbox A6) → ready to wire as a reorder scope. See §5 follow-ups.
- ~~**logInterval enum verification**~~ — **DONE 2026-07-12**: enum = `0=Immediately · 1=Daily · 4=Manually` (NO weekly/monthly in 3.22.11); `log completed now` advances `manualLogDate`. `src/read/log-boundary.ts` comment corrected.
- ~~**Deadline-less fixed-repeat encoding**~~ — **DONE 2026-07-12**: YES the GUI makes them (it's the default), and the plist is IDENTICAL to a deadlined ts=0 rule — deadline-ness is NOT in `rt1_recurrenceRule`, falsifying the fixed⇒deadlined law for the deadline-less case. `src/model/recurrence.ts` annotated. See §5 follow-up (nonzero-offset encoding + projection fix).
- ~~**Repeating-template dated-reminder clear**~~ — **DONE 2026-07-12**: no in-place automation clear exists (reminder is a rule property, not `reminderTime`; Shortcuts clear = safe no-op, AS move-to-Inbox = clean 301 refusal, both crash-free). `todo.clear-dated-reminder`'s repeating refusal is correct and stays.
- ~~**Lab runner Shortcuts arm**~~ — **DONE 2026-07-12** (`mg/lab-shortcuts-arm`): the DSL grew a `shortcut` step (guest input file + `shortcuts run --input-path/--output-path`) + a `group:interactive` skip for the delete-class proxies; `s-suite.json` is now recurring and wired into `lab:regress`, giving the shipped Shortcuts ops (`heading.create`, `todo.clear-dated-reminder`) recurring live coverage. The §C e2e reorder coverage was already present (commit `d38b05f`, v0.8.0 — inbox/someday/headings/projects-bounce) and re-confirmed in the same change.
- **§E½ UI-vector feasibility probe**: VNC-drive `File → New Repeating To-Do` end-to-end in a clone, verify an `rt1_recurrenceRule` row lands. Gateway to the dedicated-Mac "ui" vector for everything conclusively UI-only (repeat rule create/edit, sidebar order, to-do↔project convert). SX6 + the round-3 VNC arm demonstrated the click mechanics (the round-3 clone drove the full repeat-rule editor by VNC).

## 3. Needs a human present (short sittings)

- **P5**: Shortcuts delete of a NON-empty heading (delete-class consent re-prompts every run — no Always-Allow). Question: children re-parent, orphan, or cascade?
- **`.ips` capture** for the heading-schedule crash (§6) — nice-to-have for the CC report.
- **CC report submission itself** — once 6½ screenshots + (optionally) the §6 .ips land.

## 4. Calendar-pinned

- **macOS 27 public-beta regression VM** — ~late July 2026. Build a beta VM, run `lab:regress`, diff verdicts/tiers (the Things-update canary: rrv decode, fingerprint, doctor `repeats:`).
- **iOS 27 GA runbook** — ~Sept 14 2026: execute `docs/lab/things-update-runbook.md` + the Apple-Intelligence memo follow-ups (`docs/design/apple-intelligence-research.md`).

## 5. Smaller code items (unblocked, low effort)

- **Suppress "(archived)"-titled areas?** Mike's three empty areas render `(no projects)` (correct sidebar mirroring — Things has no area-archive feature; "(archived)" is his naming). If he wants them hidden it's a deliberate divergence (config/pattern filter) — needs his call first (overlaps §1 preferences item).
- **`things logbook --limit` default vs `--since` interplay** — no known bug; noted only that logbook predates the relative-period vocabulary added in #77/#85 and could default tighter. Optional polish.

### New follow-ups from lab round 3 (2026-07-12, PR mg/lab-round3)

- **Wire the Someday reorder scope** (P6h LOCKED): the private reorder command works in `list "Someday"` with a **reversed** wire-list (3-item probe: `[S3,S1,S2]`→`[S2,S1,S3]` top-to-bottom, matching the Inbox A6 convention). Encoding is nailed; this is now a wire-only task (add a `someday` scope to the reorder op, mirroring the Inbox scope's reversal) — no further probing needed. (Note: scf2 already shipped a `someday` reorder scope for area-less someday PROJECTS; confirm whether this someday-TO-DO scope is the same code path or a distinct one before wiring.)
- **Deadline-less fixed-repeat projection fix** (oddities §8a, DLREPEAT): `src/model/recurrence.ts` + the occurrence projection (`src/read/views.ts`, `src/model/occurrences.ts`) assume fixed⇒deadlined, but a deadline-less fixed repeat (the GUI default) spawns instances with NO deadline while its `rt1_recurrenceRule` is byte-identical to a deadlined ts=0 rule. Risk: phantom deadlines projected for deadline-less fixed templates. Blocked on one datapoint NOT captured this round (VNC keyboard entry into the repeat editor's "days earlier" field failed): **how a NON-zero start-offset deadlined repeat encodes** (the real deadline-vs-not discriminator — likely a non-zero `ts` and/or `t2_deadlineOffset`). Re-probe with a working VNC keyboard path (or the `shortcuts`/AS route if one materializes), then decide whether to gate the deadline projection on `t2_deadlineOffset`/`deadline` rather than on the rule alone.
- **Repeating-template reminder storage** (oddities §8b, minor): where a repeating template's rule-level reminder time is actually stored (it is NOT in `reminderTime` and NOT in the decoded `rt1_recurrenceRule`) is unresolved — likely materialized only on freshly-spawned instances (the pre-spawned ones didn't carry it after a mid-cycle rule change). Not product-blocking (the reminder is UI-only to clear regardless); note only if a repeating-instance reminder feature is ever wanted.
