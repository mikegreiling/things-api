# Up-next queue (parked 2026-07-12, post-v0.8.0)

The working queue for the next session(s). Everything here was triaged with Mike on 2026-07-12 after the v0.8.0 release (PRs #73–#85: Shortcuts write vector + live validation, reversible/guarded undo, checklist intent undo, reversibility matrix, trash-cascade fix, the `things projects` sidebar mirror, upcoming window, hidden-item hints, `--when` validation, capabilities undo column). Read `docs/roadmap.md` for the long-lived doctrine; THIS file is the short-horizon pick list. Remove items as they land.

## 1. Decisions Mike needs to make (blocked on him, near-zero effort)

- **Hide `── Repeating To-Dos ──` behind a flag in `upcoming`?** The dateless resting-template section (~15 rows in his library) always renders and survives every `--until` bound (a date bound can't apply to dateless rows — deliberate, PR #77). If maximum brevity wins, add `--repeats`/`--all`-style gating.
- **Today/anytime showing checked-unswept items?** Closed items the log-move sweep hasn't passed stay checked in place in project/area views (GUI parity, completion≠logged model). Whether the flat `today`/`anytime` lists should also show them was flagged ~2026-07-10 and never ruled.
- **Stateful display preferences** (roadmap §H): config-file/env defaults for the growing toggle family (`--show-later`, `--show-logged`, `--until`, `--all`). Decide the config surface + precedence; wary of plist-driven defaults confusing agents.
- **Glyph palette doc + `⧉`**: Mike asked whether `⧉` (U+29C9) was ever considered (it wasn't — whole blocks like Misc Math Symbols-B were never mined). Open offer: a curated single-cell/color-safe candidate inventory under `docs/design/` to feed future picks and the §H cross-terminal audit. Also unanswered: did Mike have a slot in mind for `⧉`?
- **When to send the Cultured Code report**: `docs/things-app-oddities.md` is effectively the draft (crashes §1/§6/§7, silent-failure families §2/§5, the double-trash black hole §6½). Last evidence gaps below.

## 2. VM lab campaigns (autonomous; batch them — they share clone setup)

- **Double-trash black hole screenshots (oddity 6½)** — VNC arm (`research-sx6.sh` template): repro Mike's GUI sequence in a clone (trash to-do, separately trash project), capture Trash-view + project-view screenshots for the CC report. Repro steps are in the oddity entry.
- **scf2 round-3 probes** (probe-backlog §A round 2 leftovers): P4 redo (backdating value formats — completion/creation via Shortcuts set-detail, AppleScript `set completion date`, URL with token), P3a redo (Reminder Time SET formats), P2b (`set-detail` Parent on a TO-DO — re-parent between projects), **P6 sidebar-order spellings sweep** (AppleScript `move project to before project`, `set index of`, private reorder in "Anytime"/"Someday" with area uuids, full sdef `_private_` inventory) — P6 landing would unlock sidebar reorder as a write.
- **logInterval enum verification** (probe-backlog §C): log-boundary model has only `1=daily` live-verified; probe 0/2/3/manual by flipping the GUI pref in a clone; confirm whether "log now" updates `manualLogDate`.
- **Deadline-less fixed-repeat encoding** (probe-backlog §C): can the GUI even make one, and does its plist differ from ts=0? Our fixed⇒deadlined law depends on the answer.
- **Repeating-template dated-reminder clear** (RC residual): Shortcuts `set-detail` clear was never re-probed ON a repeating template (bounce crashes there, R09; move-to-Inbox unprobed on templates). One clone probe settles whether repeating items truly have an in-place clear.
- **Lab runner Shortcuts arm** (probe-backlog §C): guest input files + `shortcuts run --input-path` in the DSL so `s-suite.json` becomes a recurring suite — also unlocks recurring e2e for the shipped Shortcuts ops, and fold in **§C e2e reorder coverage** (guest smoke has NO reorder steps: inbox/someday/headings/projects-bounce) in the same lab-touching change.
- **§E½ UI-vector feasibility probe**: VNC-drive `File → New Repeating To-Do` end-to-end in a clone, verify an `rt1_recurrenceRule` row lands. Gateway to the dedicated-Mac "ui" vector for everything conclusively UI-only (repeat rule create/edit, sidebar order, to-do↔project convert). SX6 demonstrated the click mechanics.

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
