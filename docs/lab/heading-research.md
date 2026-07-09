# Heading research — the consolidated verb matrix

Everything probed about heading rows (`TMTask.type = 2`), consolidated from the S-campaign (L5 sitting), scf/scf2, P9f, and **P10/P10b (2026-07-09) — the AppleScript by-id breakthrough**. Feeds the headings doctrine decision (gaps §0/§1).

## The P10 discovery: AppleScript addresses heading rows by id

A31's "AppleScript has no heading class" holds only for ENUMERATION — `to do id "<heading-uuid>"` resolves type=2 rows fine (the oddity-5e pattern: invisible to list reads, fetchable by id). `get properties` returns a full record (`class: selected to do`, project link, status). That unlocks per-verb probing with NO Shortcuts dependency.

## Verb matrix (all evidence 2026-07-09, Things 3.22.11)

| Verb | URL scheme | AppleScript (by id) | Shortcuts | Verdict |
|---|---|---|---|---|
| Create (existing project) | 🚫 (T09/U09) | 🚫 (`make` — A31) | ✅ S02 `Create Heading` | Shortcuts-only |
| Rename | 🚫 silent no-op (P10c) | ✅ **`set name of to do id`** (P10d + P10b-b6 ×2, works on archived headings too) | ✅ S03 | **AppleScript preferred — no setup** |
| **Archive** (= UI "Archive") | 🚫 `completed=` silent no-op (P10b) | ✅ **`set status … to completed`** — status 3 + stopDate (P10d, P10b-b1) | 🚫 `Status` detail exit-0 no-ops (P10a, oddity 5k) | **AppleScript-only.** ⚠️ CASCADES on a non-empty heading: children are completed with it (P10b-b1); un-archive reopens the heading ONLY — children stay completed (b2). Needs a children policy/ack like project.complete |
| Un-archive | ➖ | ✅ `set status … to open` (b2) | 🚫 | heading-only restore |
| Move to another project | 🚫 (U10) | 🚫 `set project of` silent no-op (P10b-b4) | 🚫 `set-detail` Parent no-op (scf P2) | dead on FOUR surfaces |
| Delete (row removal) | 🚫 | 🚫 `delete to do id` → −1728 on empty AND non-empty (P10b-b3 — the delete verb resolves via the `to dos` container, which excludes type=2) | ✅ interactive only (S04; delete-class consent re-prompts every run) | headless row deletion impossible |
| Reorder within project | 🚫 | ✅ private reorder command, heading uuids in a project specifier (scf P1) — shipped as `reorder --scope headings` | ➖ | children follow their heading |
| Empty (deport children) | ✅ `update?list-id=<project>` clears the child's heading link, tier 0 (P9f) | ➖ | ➖ | the soft-delete precursor |
| Schedule / due date | ➖ | ⚠️ **SUSPECTED APP CRASH** — `schedule to do id <heading>` killed the AppleEvent connection (−609, P10b-b5); unverified (no crash detector in that run) | ➖ | **hard-blocked in the pipeline** (H-UNKNOWN-DESTINATION now rejects non-to-do targets for every todo.* op) |

## The headless deletion story (doctrine input)

True row deletion cannot be headless (AS −1728; Shortcuts delete-class consent has no Always-Allow). But the equivalent intent composes headlessly, no Shortcuts required:

1. **Empty it**: move each child to the project root (`update?list-id=<project>`, P9f) — or leave children and accept the archive cascade with an explicit ack.
2. **Archive it**: `set status of to do id <heading> to completed` (P10d) — the heading leaves the active project view exactly like the UI's Archive.

An archived-empty heading is invisible in normal use, reversible (`set status … to open`), and requires zero consent prompts. This supersedes the blank-the-title hack (P9f probed `edit-title` to `""` — works, but archive is semantically honest and reversible).

## Unprobed / follow-ups

- `set status … to canceled` on a heading (presumed symmetric with completed; minor).
- Crash VERIFICATION for `schedule` on a heading (needs the U12-style crash detector: process death + `.ips` capture + row-unchanged assertion) before it goes in the Cultured Code report as more than a suspicion.
- P5 (delete-class): non-empty heading delete via Shortcuts — child fate (human present).
- Whether the UI renders an archived heading's still-open children anywhere odd (needs eyes on a VM screen).
