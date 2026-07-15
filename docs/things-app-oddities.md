# Things 3 automation-surface oddities — observed behavior catalog

Everything surprising, inconsistent, or hazardous we found while systematically probing Things 3's automation surfaces (URL scheme, AppleScript, and their interaction with the UI). Each entry has reproduction steps, expected vs. actual, and evidence pointers into this repo's probe campaigns. **Section 1 is a genuine crash bug worth reporting to Cultured Code**; the rest ranges from silent-failure hazards to design observations, collected here so a support email can cite them precisely.

**Environment (all findings):** Things 3.22.11 — verified on BOTH the Mac App Store build (32211507, production Mac, macOS 15.7.4) and the direct-download trial build (32211007, clean macOS 15.6 VMs). Deterministically reproduced by the automated probe harness (`npm run lab:regress`); evidence records per probe id live under `lab/artifacts/<runId>/evidence/`.

---

## 1. CRASH: URL-scheme `when=` update on a repeating to-do kills the app

**The report-ready bug.** Setting `when` via the update command on any repeating to-do crashes Things outright — while the equivalent AppleScript command is properly guarded, proving the validation exists but isn't wired into the URL path.

**Reproduce:**
1. Create a repeating to-do (e.g. daily, fixed schedule — any repeat configuration works; reproduced across multiple rules and inside/outside projects).
2. Get its uuid (right-click → Share → Copy Link) and the URL auth token (Settings → General → Enable Things URLs → Manage).
3. `open "things:///update?id=<uuid>&auth-token=<token>&when=today"`

**Expected:** an error (the item's schedule is owned by its repeat rule), like the AppleScript path produces.
**Actual:** Things terminates immediately. ~1s after the `open` handoff the process dies; macOS writes a crash report to `~/Library/Logs/DiagnosticReports`. Crash signature: **`EXC_BREAKPOINT (SIGTRAP)`** ("Trace/BPT trap: 5") — a Swift runtime trap, consistent with an unguarded precondition/force-unwrap in the URL handler path (captured `.ips`: `Things3-2026-07-05-120202.ips`, banked by the harness).

**Contrast — the app already knows how to refuse this.** AppleScript `schedule to do id "<uuid>" for (current date) + 1 * days` on the same row returns a clean scriptable error: `Things3 got an error: Cannot schedule to-do (302)`, exit 1, zero database changes. The guard exists; the URL handler bypasses it.

**Data integrity:** no corruption observed — after relaunch the to-do and its repeat rule are byte-identical (verified by row-level DB diff before/after the crash, every run).

**Also affected:** non-scheduling updates on the same repeating item work fine (`title`, checklist items), so the crash is specific to schedule-class fields via URL. **The same crash fires on a repeating PROJECT** via `update-project?...&when=<x>` (P14-A4, 2026-07-09 — process death + fresh `.ips`), so the whole repeating-template family is affected across both `update` and `update-project`.

**Evidence:** first isolated 2026-03-12 on the MAS build (validation notes T12, reproducible across repeat configs); re-reproduced deterministically 2026-07-03 in clean-room VMs on the trial build — probe `U12` (crash detector: process death + `.ips` capture + row-unchanged assertion, green in every acceptance run), guard contrast probe `A21`. The reminder-flavored form `when=today@18:00` crashes identically (probe `R09`, 2026-07-04) — the whole `when=` family is affected. Repo refs: `docs/research/validation-notes-step3.md` (T12), `docs/lab/u-suite-results.md`, `docs/lab/a-suite-results.md`, `lab/suites/u-suite.json` (U12), `lab/suites/a-suite.json` (A21), `lab/suites/r-suite.json` (R09).

---

## 2. Silent-failure hazards in the URL scheme

Commands that fail *silently* — the caller gets no signal that nothing (or only part) of the request happened. `open` exits 0 regardless, so an automation caller has no error channel at all; these make read-after-write verification mandatory.

### 2a. Unknown `list=` destination → complete silent no-op
`things:///update?id=<uuid>&auth-token=<t>&list=No Such Area` does nothing: no modal, no mutation, no log. A typo in a destination name is indistinguishable from success. *(T06/U06)*

### 2b. Unknown tags → silently dropped (partial write)
`things:///add?title=X&tags=real-tag,typo-tag` creates the to-do with only the tags that already exist; unknown names are discarded without any indication, and no tag is created. The caller believes the full tag set was applied. *(T03/U03, U04)*

### 2c. `heading=` never creates a heading — silently ignored when missing
On `add`, a `heading=` value that doesn't match an existing heading in the target project is dropped: the to-do is created un-headed. Heading placement works only against pre-existing headings (and matching is by name, so duplicate heading names are ambiguous). *(T09/U09)*

### 2f. AppleScript `move project … to list "Anytime"` on a non-trashed project → complete silent no-op
The command returns success and produces literally zero database delta (not even a modification-date bump). The same command on a *trashed* project un-trashes it — so the identical statement is either a restore or a no-op depending on state the caller may not know, with no signal distinguishing the two. *(P06/P09, 2026-07-06)*

### 2g. `update?completion-date=` / `creation-date=` are silently ignored — while the json importer honors the same attributes
`things:///update?id=<uuid>&auth-token=<t>&completion-date=2025-01-15` (and `creation-date=`) on a completed to-do changes nothing — no error, no modal, zero delta; `completed=true` in the same command class works. Meanwhile `things:///json` **add** honors `creation-date`/`completion-date` attributes exactly (row created with the given epoch values). The parameter names parse somewhere (no unknown-parameter error either way), the write path just drops them on update. *(scf2 P4c/P4d, 2026-07-09)*

### 2h. The json date parser rejects fractional-seconds ISO 8601 — failing the WHOLE command
A `things:///json` payload whose `creation-date`/`completion-date` carries milliseconds (`2025-03-01T18:00:00.000Z` — the default output of every ISO serializer, incl. JavaScript's `toISOString()`) fails the entire command: error modal (the json class steals focus, §4b), zero rows written. The identical payload with second-precision timestamps (`…T18:00:00Z`) imports perfectly. Accepting the RFC 3339 fractional-seconds form — or at least failing with a message naming the offending attribute — would save every JS/Swift-Date integrator a debugging session. *(live e2e catch, 2026-07-09; second-precision shape validated scf2 P4d)*

---

### 2d. Reminder times with bare hours 1–11 are silently reinterpreted (am/pm heuristic)

**Report-ready.** `when=today@10:05` does not set a 10:05 AM reminder — it silently sets **22:05**. There is no error, no signal; the caller only finds out by reading the item back.

**Reproduce** (any afternoon wall-clock, e.g. 12:30 PM):
1. `open "things:///add?title=T1&when=today@10:05"` → reminder stored as **22:05** (10:05 PM).
2. `open "things:///add?title=T2&when=today@06:45"` → reminder stored as **06:45** — exact.
3. `open "things:///add?title=T3&when=today@6:45"` → reminder stored as **18:45** (6:45 PM).

**The rule** (pinned across 13 known-time probes, R01–R16, identical on `add` and `update`):

| Time spelling | Parsed as | Example (at a ~noon clock) |
|---|---|---|
| Leading-zero hour (`06:45`, `00:15`) | 24-hour LITERAL | `06:45` → 06:45 |
| Hour ≥ 12 (`12:30`, `14:10`, `22:30`) | 24-hour literal | `14:10` → 14:10 |
| **Bare hour 1–11** (`6:45`, `10:05`) | 12-hour, resolved to the **next upcoming occurrence** vs. the current clock | `10:05` → 22:05 |
| Explicit suffix (`6pm`, `10:05am`) | honored | `10:05am` → 10:05 |

**Why it bites:** the three lexical classes look interchangeable, and the dangerous one is time-of-day dependent — the same URL stores a different reminder depending on when it runs. Worse, `10` and `11` have no leading-zero spelling, so a caller emitting canonical `HH:mm` strings still gets silently PM-shifted for two hours of the day. **Expected:** either parse `H:mm`/`HH:mm` uniformly as 24-hour, or reject ambiguous times; a silent, clock-dependent reinterpretation is neither.

**Workaround** (what things-api's compiler does — every branch probe-verified): emit hours 0–9 zero-padded 24h (`06:45`), hours 10–11 with an explicit suffix (`10:05am`), hours 12–23 as literals (`14:10`). Never emit a bare 1–11 hour.

**Scope note (2026-07-05):** the heuristic applies to the clock-relative keywords only — on a DATED schedule, `when=2026-07-09@10:05` stores **10:05 exactly** (R19). The trap is `when=today@…` / `when=evening@…`.

**Evidence:** R-suite (`lab/suites/r-suite.json`, R01–R21), clean-room VM, Things 3.22.11 trial build, 2026-07-04/05; every probe locks the exact stored `reminderTime` int (packing: `hour<<26 | minute<<20`). Results: `docs/lab/r-suite-results.md`.

### 2e. Reminder CLEAR semantics are asymmetric between keyword and dated schedules

On `when=today` / `when=evening`, re-sending a bare `when=` (no `@time`) **clears** an existing reminder (R07). On a dated schedule the SAME-date bare `when=` does NOT: `when=2026-07-09` on an item already dated 07-09 with a reminder leaves the reminder intact (R20), and re-dating to `when=2026-07-10` carries the reminder along to the new date (R21). Consequence: there is no *same-date, in-place* URL way to strip a reminder off a dated item. Whichever behavior is intended, the keyword/date asymmetry is surprising; callers relying on the today/evening clear behavior silently fail on the same-date dated case. Evidence: R07/R20/R21, 2026-07-05.

**Correction 2026-07-11 (RC campaign — the earlier "no URL way" claim was too strong).** Sending `when=today` (the *keyword*, not a date) to a dated-reminder item DOES clear the reminder — the keyword-clear (R07) wins over the dated-sticky carry (R20/R21): `reminderTime` → NULL, and the item is re-dated to today (`start` 2→1, `startDate` → today's int) (RC01). Re-dating back with `when=<original-date>` restores the date and does NOT re-attach a reminder (RC02). So a **pure-URL two-leg bounce (`when=today` → `when=<original-date>`) clears a dated reminder** — exactly the remediation H-REMINDER-SCOPE already recommends, now verified end-to-end. It is non-atomic and transiently re-dates the item to Today (a crash between legs leaves it mis-dated), and it CRASHES on repeating items (§1). Independently, an **AppleScript `move … to list "Inbox"` drops the reminder** by de-scheduling the item (`reminderTime`/`startDate` → NULL, `start` → 0) (RC03) — most disruptive (loses the date). And the Shortcuts `Edit Items → Reminder Time = ""` clears it **in place** (`reminderTime` → NULL, `startDate` untouched) on both to-dos (scf P3b) and projects (RC avenue D) — headless (output-class consent). AppleScript has NO writable reminder property to clear directly: the sdef exposes only a read-only `activation date` and a read-only `_private_experimental_ json`; `set` on either errors -10006 (RC avenue C). **Net: Shortcuts is the only in-place / schedule-preserving clear; it is NOT the only clear.** Evidence: RC01–RC03 + avenues C/D, [docs/lab/rc-suite-results.md](lab/rc-suite-results.md), 2026-07-11.

## 3. UI vs. URL behavioral divergence: project completion

Completing a project **in the UI** with unresolved children prompts ("mark as completed" etc.). Completing the same project via `things:///update-project?...&completed=true` **silently auto-completes every open child** — no prompt, no signal, canceled children left canceled. Same user intent, materially different outcome depending on the surface. For automation this is a destructive default: one URL can mark dozens of children done. *(T08/U08 — cascade behavior verified row-level)*

---

## 4. Error-modal inconsistencies

### 4a. Error modals don't block execution — they just stack
URL-error modals (unsupported command, missing auth token) stay on screen until manually dismissed, but subsequent `things:///` commands **keep executing and mutating data behind the open modal** — both further URL commands (T13/U13) and AppleScript commands (A43/X02). A visible error therefore implies neither "stopped" nor "will stop." Unattended machines accumulate stacked modals while data keeps changing.

### 4b. Modal focus behavior differs by command class
- Bad `add`/`update`/missing-token errors: modal appears **without activating Things** (stays in the background). *(U02/U05)*
- `things:///json` payload errors and the unsupported `delete` command: the error modal **activates Things and steals focus**. *(U10/U14)*

Same error category, two different disruption behaviors.

### 4c. Modal scope
The error modal only darkens/blocks the frontmost Things window; other Things windows remain partially interactive. *(T02 notes)*

---

## 5. Observations (arguably by design, but automation-relevant)

### 5a. AppleEvents to a closed Things launch it AND steal focus
Any AppleScript command — even a pure read like `count of to dos of list "Inbox"` — against a non-running Things launches the app *frontmost*. There is no background-launch behavior on the AppleEvent path; automation must pre-launch with `open -g -a Things3` to avoid yanking the user's focus. *(A40/A41)*

### 5b. Adding an open child silently reopens a resolved project
Adding (or moving) an open to-do into a completed, canceled, or even already-logged project silently flips the project back to open. Re-resolving the children does not re-complete it. No surface signals this side effect. *(T19/U19)*

### 5c. Checklist updates are replace-all (but the `json` form preserves per-item state)
The classic `checklist-items=` form replaces the entire checklist and recreates every item OPEN — previously completed/canceled items lose their state even when re-sending an identical list. There is no additive or patch form, and item uuids regenerate on every rewrite (no stable per-item identity). *(T07/U07/U20)*

The `things:///json` form is NOT subject to the reset: it honors a per-item `completed` attribute, recreating items pre-checked *(P18)*. This is what makes a "granular" checklist edit possible: read the current list, apply one change in memory, and re-send the whole list via `json` so every non-targeted item keeps its state (op `todo.edit-checklist-item`, `things todo checklist --check/…`). Canceled items are still not recreatable (the item model carries only a `completed` boolean) — they round-trip to open. The forward edit remains read-then-rewrite, so a concurrent out-of-band checklist edit landing in that window is overwritten (surface limit; there is no item-level write and no cross-app lock).

### 5d. `duplicate=true` on a repeating template: no-op on the data, but opens new windows

The URL update command with `duplicate=true` works on plain to-dos (exact copy — E07). Aimed at a repeating TEMPLATE, it duplicates nothing (zero DB delta, template untouched) but the app opens **new windows** — a disruptive dead-end where either an error or a rule-carrying copy would be reasonable. Evidence: E13, 2026-07-05.

### 5e. Repeating templates are invisible to AppleScript list reads but fetchable by id
`to dos of list "Someday"` omits repeating templates entirely, yet `to do id "<template-uuid>"` returns them fine. Third-party tooling that enumerates lists (e.g. things.py) can't see repeat rules at all through official read surfaces. *(A12, T16)*

### 5e. `things:///version` launches and foregrounds the app, shows nothing
Without an x-callback, the version command has no visible output — its only observable effect is launching Things and taking focus. *(T01/U01)*

### 5f. AppleScript `delete tag` on a parent tag silently destroys the entire subtree
Deleting a tag that has child tags cascade-deletes the children too — permanently (no Trash for tags), with no confirmation and no error through the AppleScript channel. Combined with tag deletion already being unrecoverable, one scripted delete of a parent can wipe a whole tag hierarchy the caller never named. *(P16, 2026-07-06)*

### 5g. Removing a link (container/parent): four different behaviors for one intent
Clearing a relationship behaves differently on every automation spelling: **AppleScript rejects** `set area/project/parent tag … to missing value` (E19/P08/P10/P11) and `set … to ""` (P27/P28) with errors; **the `json` command silently ignores** `"area-id": null` / `"list-id": null` (zero delta, no signal — P25/P26); **the URL scheme quietly supports container clears** via an EMPTY parameter (`update?list-id=` / `update-project?area-id=` — P21/P22/P24, undocumented, matches the empty-`tags=` replacement pattern); and **AppleScript's property-DELETE form works for tag parents** (`delete parent tag of tag X` un-nests cleanly, P29 — while the set-form of the very same property errors). One intent family: two error spellings, one silent no-op, two undocumented successes on two different surfaces. *(2026-07-06/07)*

### 5h. "Enable Things URLs" OFF ≠ token cleared; a disabled URL write pops an enable-modal, not an error
The `uriSchemeAuthenticationToken` in `TMSettings` **stays populated** when "Enable Things URLs" is unchecked, and it **does not rotate** across an off→on cycle (the old token keeps working the instant the feature is re-enabled). The real enabled/disabled flag lives elsewhere — `uriSchemeEnabled` (int-bool) in the app's group-container preferences plist — so token presence is not a proxy for feature availability. A URL-scheme write while disabled is **not** a silent no-op and **not** an error return: it raises a modal ("Things has been opened via the URL Scheme. Do you want to enable this feature?" — Cancel/Enable) and **holds the write pending the choice** (Cancel discards it; no DB row appears either way). Two queued writes stack two modals. *(Phase 21b, 2026-07-09)*

### 5i. Single-item permanent delete: no AppleScript/URL surface — Shortcuts hard-deletes with no tombstone
There is no scripted way to permanently delete ONE item via AppleScript or URL. On an already-trashed to-do, `delete to do id X` errors `-1728` (the delete verb can't re-address a trashed row by bare `to do id`), while `delete (first to do of list "Trash" whose id is X)` and `delete to do id X of list "Trash"` are silent no-ops; `empty trash` is all-or-nothing. **The Shortcuts `Delete Items` action with "Delete Immediately" ON does hard-delete a single row** — but it leaves **NO `TMTombstone`** (row count 1→0, zero tombstones; S-delperm). A tombstone-less permanent delete means Things Cloud sync has no deletion record to propagate — the item may resurrect from another device or diverge. *(Phase 21b B0/A5 + L5 S-delperm, 2026-07-09)*

### 5j. Shortcuts Privacy consent is asymmetric: "output" actions can be Always-Allowed, "delete" actions cannot
Running a Things Shortcuts action prompts a per-shortcut Shortcuts-Privacy dialog scoped to a data class (distinct from AppleEvents Automation consent). **Output-class** dialogs ("Allow X to **output** N items" — create/edit/set/find) offer **Don't Allow / Allow Once / Always Allow**. **Delete-class** dialogs ("Allow X to **delete** N items") offer only **Don't Delete / Delete** — there is **no Always-Allow**, so a delete re-prompts on every single run and can never be made headless. A user can grant a create/edit shortcut once and automate it, but can never non-interactively delete through Shortcuts. *(L5 sitting, 2026-07-09)*

### 5k. Shortcuts `Edit Items` reports success even when the edit silently fails

`shortcuts run` exits 0 and the shortcut completes "successfully" even when the `Edit Items` action changed nothing: setting `Parent` on a heading echoes the item back with zero DB delta (scf P2), and setting `Reminder Time` from a plain `"14:30"` text value silently fails to coerce and writes nothing (scf P3a). When the action fails internally it may also produce NO output at all while still exiting 0 (scf P4) — an automation caller gets no error channel whatsoever; the only truth is re-reading the data. Round 2 widened the blast radius: EVERY date/time-valued detail write fails this way (Completion Date and Creation Date in five formats, Reminder Time in three — scf2 P4a/P3a). *(scf runs, 2026-07-09)*

### 5l. Shortcuts `Edit Items → Parent` with a text value DETACHES the item instead of erroring

Setting the `Parent` detail to a project uuid passed as TEXT does not move the to-do and does not error — it silently CLEARS the to-do's project link (`project` → NULL), leaving the item container-less. The text→entity coercion fails and the action writes the empty result. On a heading row the same call is a pure no-op (project unchanged) — two different silent-failure behaviors for one action depending on row type. A destructive wrong-action with exit 0 is the worst of the silent-failure family: the caller asked for a move and got a detach. *(scf P2 / scf2 P2b, 2026-07-09)*

### 5m. A pending macOS Automation dialog: object-model AppleEvents hang (-1712) while app-level events and URL commands keep working

While an unanswered Automation consent dialog is up (or after one was dismissed without re-enabling), the failure signature is ASYMMETRIC and easy to misread as an app hang: every object-model AppleEvent times out with `-1712` (`count projects`, `get name of project id …`, `delete project id …` — even `count windows`), while app-level events (`get name` of the application) answer instantly and URL-scheme commands (`things:///update?…`) execute normally. Two operational traps compound it: (1) macOS attributes the consent to the TERMINAL EMULATOR hosting the process tree — the dialog read "**Ghostty.app** wants access to control Things.app", so a Shortcuts Always-Allow or a prior grant to a different terminal does not cover it; (2) the dialog renders on the machine's physical screen only — over SSH/remote-control sessions nothing indicates it exists, and the CLI's transport deadline reports a generic timeout. Restarting Things does NOT clear the state (the block is in macOS TCC, not the app). Diagnostic that separates the cases in seconds: `get name` works + `count projects` -1712 ⇒ consent pending, not a wedged app. `things doctor --probe-automation` now classifies this signature. *(live host, 2026-07-12 — three delete attempts chased as app hangs before the dialog was found via screen sharing)*

## 6. CRASH: AppleScript `schedule` on a heading row kills the app

**CONFIRMED 2026-07-09 (P11e, PID watch):** `tell application "Things3" to schedule to do id "<heading-uuid>" for (current date) + 1 * days` returns `Connection is invalid. (-609)` and the Things process DIES (PID present before, gone after; heading row unchanged — no corruption observed). Heading rows are addressable via `to do id` (§5e's by-id pattern: `get properties`, `set name`, `set status` all work — see docs/lab/heading-research.md), so this is reachable by any script that touches to-dos by id without checking the row type. It is the second unguarded-precondition crash in the schedule-class family (§1 is the URL `when=` on repeating items) — the AppleScript guard that correctly rejects e.g. repeating to-dos (302) is missing for type=2 rows. A `.ips` capture is still wanted for the report (the probe VM's DiagnosticReports had not flushed one before teardown). things-api hard-blocks every todo-op against non-to-do targets.

### 6a. Heading "canceled" status is stored as completed — with a different child cascade

`set status of to do id "<heading>" to canceled` sets the heading row's status to **completed** (3, not 2 — headings appear to have no canceled state), yet cascades **canceled** (2) to its open children; `… to completed` cascades completed. Two different child outcomes distinguished only by an input value the heading itself does not record. Pre-resolved children keep their status and stopDate under both cascades (P11c/P11d).

## 6½. Double-trashed to-dos vanish from every GUI view — no place to see or recover them individually

**Report-ready (GUI data-visibility bug).** Trashing a to-do AND its containing project as SEPARATE actions makes the to-do invisible everywhere in the app: the trashed project's view hides it (directly-trashed children are filtered from project views), and the Trash view ALSO hides it (Trash apparently hides items whose container is itself trashed, showing only the container). Directly and transitively trashed at once — the two hiding rules compose into a black hole.

**Reproduce (GUI, live host 2026-07-12):**
1. Create project P with child to-do T.
2. Trash T (T appears in Trash individually, with P's name in muted text; Put Back returns it to P; P's view no longer shows T). ✓ expected
3. Trash P separately. → T is gone from BOTH the Trash view and P's (trashed) view. There is genuinely no view in the app that lists T.

Contrast the benign single-trash cases: trashing ONLY P keeps its untrashed children visible when viewing P from the Trash (they recover with it — trash cascade is derived, not written; A24B); trashing ONLY T shows it in the Trash individually. It is specifically the direct+transitive combination that loses the row. The data is intact (the row keeps `trashed=1` and its project link — restore/empty-trash still act on it); only every VIEW of it is gone.

**things-api behavior (deliberately divergent):** `things trash` lists every directly-flagged row including double-trashed ones, and a trashed project's own view (`things show <uuid>`) shows a `── Trashed (n) ──` bucket with them — locked by regression tests. Every LIVE view (upcoming/today/anytime/someday/search) excludes the whole derived-trash chain, which the GUI gets right and our CLI initially got wrong (a child of a shallow-trashed project leaked into Upcoming — fixed same change). Evidence: GUI observation on the live host, 2026-07-12; **VM screenshot capture DONE 2026-07-12** (VNC arm, clone `things-run-r3-20260712-171142`), report-ready sequence under `lab/artifacts/things-run-r3-20260712-171142/oddity-6half/` (gitignored, like the `.ips` crash reports):
- `01-trash-child-only.png` — baseline: after trashing ONLY the child, the Trash view shows it individually with its parent project's name in muted text; the project is still live in the sidebar. ✓ expected
- `02-trash-after-both-child-gone.png` — after separately trashing the project: the child has **vanished** from the Trash view; the project now appears there with a **"0" child-count badge**.
- `03-project-selected-0-children.png` / `04-project-view-empty.png` — opening the trashed project's own view shows it **empty** ("Press ⌘N to create a new to-do"): the child is invisible there too, though the DB row persists (`trashed=1`, project link intact — confirmed in `final.sqlite`).

## 6¾. The completion modal ignores trashed children → restoring one yields a COMPLETED project holding an OPEN to-do that the Logbook sweep never reconciles

**Report-ready (data-integrity bug; two composing defects).** Completing a project **in the UI** raises the "mark remaining items?" sheet only when the project has an **open, non-trashed** child. A child that is in the Trash is **not counted** — so a project whose only unresolved child is trashed is marked completed **silently, with no sheet**. That trashed child can then be **restored (Put Back) into the now-completed project**, and Put Back — unlike every other way of adding an open child (§5b) — **does not reopen the project**. The result is a completed project containing an open, actionable to-do. When the Logbook sweep passes, the project moves to the Logbook and takes the open child with it: the child is now `status=0` but present only inside a *logged* project, **absent from Anytime, Today, and Inbox** — an actionable item lost to every actionable view.

The root defect is the **completion check's blind spot for trashed children**. The URL/Shortcuts project-complete path shares it (`update-project?...&completed=true` cascades to open children but skips trashed ones — parallels §3). Neither surface warns that the project has a trashed child that could re-materialize as unfinished work.

**Reproduce (GUI, VM `things-run-plog1-20260713-184245`, 2026-07-13):**
1. Project P with child to-do T (open). Trash T. (T2 completed alongside, for realism.)
2. Complete P via its completion circle. → **No sheet appears; P is marked completed.** (Control: the same gesture on a project with an *open, non-trashed* child DOES raise the "There is still 1 to-do…" sheet — screenshot `10-C-control-modal.png`.)
3. Open Trash → right-click T → **Put Back**. → T returns to P: `trashed=0`, `status=0`, `project=P`. **P remains `status=3` (completed) — Put Back did not reopen it.** The GUI renders a checked project header above an unchecked open child (`13-P-completed-with-open-child.png`).
4. Trigger the Logbook sweep (Settings "Immediately", or AppleScript `log completed now`). → P moves to the Logbook **carrying the open child unchanged** (`status=0`); T disappears from Anytime/Today/Inbox and is reachable only by opening the logged project from the Logbook (`15-P-from-logbook-open.png`).

Restoring the child **after** the sweep (fresh project Q, sweep first, then Put Back) reaches the **same** end-state — the open child lands directly inside the logged project (`17-Q-logged-with-open-U1.png`).

**Our surface (PLOG1 guard, 2026-07-14):** we cannot CREATE this state — our only to-do un-trash op (`todo.restore`) is the scriptable Put-Back-to-**Inbox** (E15), which severs the parent link rather than restoring in place, and moving/adding an open child into a completed project reopens it via the app (T19/U19), guarded by `acknowledgeProjectReopen`. We do SURFACE it: `things project show` of a completed/canceled (incl. logged) project counts its untrashed open children and prints a muted `contains N unfinished to-dos — invisible in the app's live views` advisory (JSON: `openChildrenWhileResolved`), so a state the app buries is discoverable from the CLI. Completing/canceling a project deliberately still ignores trashed children (matches the app — ruled 2026-07-14).

**Why the sweep can't save it:** "logged" is a **derived time-boundary**, not a per-row flag (Logbook = `status IN (2,3) AND stopDate ≤ boundary`); `log completed now` only advances `manualLogDate` and **mutates no task rows**. There is no reconciliation pass that could force-complete or eject the stranded open child. **Suggested fix:** count trashed children in the completion check (or warn), and/or have Put-Back-into-a-completed-project reopen the parent (consistent with §5b) so the inconsistency can never form. Data is not lost (the row is intact and re-completing/reopening the project recovers normal behavior), but the item is silently unreachable through normal workflow. Evidence: [docs/lab/plog1-research.md](../lab/plog1-research.md) (PLOG1 a–d), screenshots under `lab/artifacts/things-run-plog1-20260713-184245/` (gitignored). Related: §3 (URL completion cascade), §5b (open-child reopen), §6½ (trashed-child visibility).

## 7. Consolidated crash & fault catalog (for the report)

Systematic incoherent-mutation sweep (P14, 2026-07-09, PID-watched on a clean VM). Two crash-prone families are known: **SCHEDULE-CLASS operations on rows that cannot accept a schedule** (C1–C3) and **malformed Find Items predicates** (C4, 2026-07-10) — every OTHER type-mismatch is a graceful scriptable error or a silent no-op. Cultured Code could add the missing precondition guards (the AppleScript `schedule` path already refuses a repeating to-do cleanly with error 302 — that guard is just missing for the other cases).

| # | Operation | Result | Evidence |
|---|---|---|---|
| C1 | URL `update?...&when=` on a repeating TO-DO | **CRASH** (SIGTRAP) | §1 (U12/R09), re-standing |
| C2 | URL `update-project?...&when=` on a repeating PROJECT | **CRASH**, fresh `.ips` | P14-A4 (NEW 2026-07-09) |
| C3 | AppleScript `schedule to do id <heading>` | **CRASH** (process death, −609) | §6 (P11e), re-confirmed P14-A1 |
| C4 | Shortcuts **Find Items** with an unrecognized predicate `Property` OR `Operator` | **CRASH — CONFIRMED, 4/4 reproducible** (EXC_BREAKPOINT/SIGTRAP, a Swift trap inside the app's Base/FoundationAdditions frameworks; `shortcuts run` reports "the 'Things' app quit unexpectedly") | SX5 (2026-07-10, `lab/artifacts/things-run-sx5-20260710-140641/`, four `.ips` captured). Triggers: `Property="name"` (nonexistent — the entity's field is `title`; this was the 2026-07-10 real-hardware crash, now explained), `Property="zzzNotAProperty"`, and `Operator=987654` on the VALID `title` property. A well-formed hand-authored predicate (`Property="title"`, Operator 4) runs perfectly — the crash is the app failing to guard unknown predicate identifiers, not a serialization-format problem. Ordinary GUI-built shortcuts can't hit this; a hand-authored/corrupted workflow can. |
| F1 | AppleScript `move project … to area id <bad-uuid>` | non-fatal FAULT — errors −1728 but writes a DiagnosticReport without dying | P14-C4 |

**Graceful (no guard needed):** AS `schedule` on a repeating to-do → error 302; every wrong-TYPE specifier (set status / delete / move / project op against a to-do/heading/area uuid of the wrong kind) → clean −1728 / −10006 / −1700, or a silent no-op on the URL side; malformed dates/statuses → silent no-op or −1700; unknown uuids → −1728. Full matrix in `lab/artifacts/things-run-p14-20260709-151631/`.

**Novel working path found in the same sweep** (not a bug — a capability): AppleScript `schedule to do id <PROJECT>` SUCCEEDS (projects inherit the `to do` class), setting the project's startDate with no error — an AppleScript vector for project scheduling that complements the URL `update-project?when=` path (P14-A3).

---

## 8. Repeat-rule & scheduling model surprises (round-3 VM probes, 2026-07-12)

Found while GUI-probing repeat rules and the log-move preference in a `--vnc-experimental` clone (`things-run-r3-20260712-171142`). Not bugs to report — model-relevant behavior worth documenting.

### 8a. `rt1_recurrenceRule` does NOT encode whether a fixed repeat is deadlined — the template's own `deadline` COLUMN does (RESOLVED, UI1 2026-07-12)

The repeat editor's **"Add deadlines"** is an opt-in checkbox, **OFF by default** — so the *default* fixed repeat is **deadline-less**: its schedule dates are START dates ("Next:"), and its spawned instances carry a `startDate` with **`deadline` = NULL**. Ticking "Add deadlines and start N days earlier" reframes those dates as DEADLINES ("Due:") with start = deadline − N.

At N=0 ("deadline on the day"), the deadlined and the deadline-less variants are **byte-identical** in `rt1_recurrenceRule` (`tp=0, fu=…, ts=0, of=[{dy:0}]`) **and** in `t2_deadlineOffset` (both 0). So deadline-ness is **not derivable from `rt1_recurrenceRule` alone**, falsifying the "every fixed rule deadlines its occurrences (incl. ts=0)" law for the deadline-less case.

**The discriminator (UI1, VNC-driven):** the **TEMPLATE row's own `deadline` COLUMN** — **NULL** when deadline-less, a **far-future sentinel `4001-01-01`** (packed int `262213760`) when deadlined. Probed by creating all variants via the GUI:

| template | rule `ts` | template `deadline` col | `t2_deadlineOffset` | verdict |
|---|---|---|---|---|
| fixed daily, no deadline (default) | 0 | **NULL** | 0 | deadline-less |
| fixed daily, "Add deadlines" 0 earlier | 0 | **262213760** (4001-01-01) | 0 | deadlined |
| fixed daily, "Add deadlines" 3 earlier | **−3** | 262213760 | 0 | deadlined |
| after-completion, no deadline | 0 | **NULL** | 0 | deadline-less |
| after-completion, "Add deadlines" | 0 | **262213760** | 0 | deadlined |

Findings: (1) the column NULL/sentinel split is the reliable, **universal** discriminator (holds for fixed AND after-completion); (2) a **non-zero** start offset additionally surfaces as **`ts = −N`** in the rule (3 days earlier → ts=−3), so a *non-zero* ts unambiguously means deadlined, but ts=0 stays ambiguous in the rule; (3) `t2_deadlineOffset` stays **0** in every case — it is NOT the discriminator; (4) instances confirm — deadline-less spawn `deadline=NULL`, deadlined spawn `deadline = start + |ts| days`. The old after-completion "deadline only when ts<0" heuristic is ALSO falsified (a deadlined ts=0 after-completion template exists). **Fix shipped:** `RepeatingInfo.deadlined` (mapper reads the template `deadline` column; the sentinel is never surfaced as a phantom deadline), and `src/read/views.ts` / `src/model/occurrences.ts` gate the deadline projection on it, not on the rule. Evidence: `UI1`, s-campaign-results.md; `lab/artifacts/things-run-ui1-explore-20260712-180724/` (screenshots `00`–`14`, `final.sqlite`, `discriminator-evidence.txt`).

### 8b. A repeating template's reminder is a rule property, invisible in `reminderTime`

Adding a reminder to a repeating template via the repeat editor ("Add reminders 12:00 PM") **persists in the editor** (re-opening shows it checked) yet writes **nothing to the `reminderTime` column** on the template OR its pre-spawned instances, and adds **no time key** to the decoded `rt1_recurrenceRule`. The reminder lives in the repeat spec (materialized on future instances, storage column unresolved). Consequence for automation: there is **no `reminderTime`-column reminder to clear on a template** — the Shortcuts `set-detail Reminder Time=""` clear is a safe no-op there, and clearing the template's reminder means editing the rule (UI-only). Evidence: `RCLEAR`, s-campaign-results.md round 3.

### 8c. `logInterval` has only THREE values — no weekly/monthly

The "Move completed items to Logbook" preference (`TMSettings.logInterval`) offers exactly **Immediately (0) · Daily (1) · Manually (4)** in Things 3.22.11 — there is **no Weekly or Monthly** option. The `2`(weekly)/`3`(monthly) values assumed by `src/read/log-boundary.ts` are unreachable; the real manual value is `4` (which falls to the model's `default`/manual branch, so behavior is unaffected — only the enum documentation was wrong). A mid-interval AppleScript `log completed now` advances `TMSettings.manualLogDate` to the current time (confirms the boundary max()-in). Evidence: `logInterval`/`LOGNOW`, s-campaign-results.md round 3.

### 8d. Deadline-driven Today membership MATERIALIZES when the "new to-dos" banner is acknowledged (UPC1, 2026-07-13)

A due/overdue deadline pulls an item into Today even from Someday/Anytime/Inbox (the F-DL rule). Immediately after launch this is a **pure computed overlay** — the row keeps its `start` (0/1/2) with `startDate IS NULL`; only `todayIndexReferenceDate` is stamped = the deadline (its entry-cohort date). Clicking **OK** on the yellow "You have N new to-dos" banner then **materializes** every such member: `start → 1`, `startDate := deadline`, `todayIndexReferenceDate := deadline`. So a seemingly informational banner **mutates `start`/`startDate`** of deadline-pulled items. Consequence for readers: the deadline-overlay is not a stable DB signal — the same item reads `start=2, startDate=NULL` before the user acknowledges the banner and `start=1, startDate=deadline` after. (Orthogonal to suppression: suppressed items never appear in the banner, so they retain `start=2`.) Evidence: `UPC1-C`, isolated pre/post (`upc1e-today-before-OK.png` at start=2 → after-OK DB at start=1), [lab/upcoming-research.md](lab/upcoming-research.md).

### 8e. There is no "dismiss deadline" command — `deadlineSuppressionDate` is a reschedule side-effect (UPC1, 2026-07-13)

The [today-order-research](lab/today-order-research.md) F-DL model calls `deadlineSuppressionDate` the "dismissed nag," but Things 3.22.11 exposes **no dedicated dismiss-deadline affordance**: the Items-menu / context-menu / row "Deadline…" popover only *sets* a date or offers **Clear** (which *deletes* the deadline, not suppresses it); clicking the red deadline flag merely selects the row. `deadlineSuppressionDate := deadline` is instead stamped as a **side effect of rescheduling an OVERDUE-deadline item to a no-startDate bucket** — verified for both **Someday** and **Anytime** (`update`/`update-project when=someday|anytime`). Rescheduling to a **future date** does *not* stamp it (the future `startDate` suppresses Today instead; UPC1-B EARLYDL kept supp=NULL). Coherent model, but worth recording so the "dismissed nag" phrase isn't read as a user-facing button. Evidence: `UPC1-C`, [lab/upcoming-research.md](lab/upcoming-research.md).

### 8f. NOT a bug — the blue Someday project circle is a coherent overdue indicator (UPC1, 2026-07-13)

Recorded here for completeness (the campaign was asked to rule bug-vs-indicator): a someday **project** whose deadline is **past-due** renders its dashed progress circle in the app **accent colour (blue)** instead of gray — the list-view analog of the red overdue flag. It is **not** a bug: it tracks the overdue deadline (future-deadline someday projects render gray), it is **not** "in Today" (the prod blue rows are suppressed, hence still in Someday) and **not** "suppressed per se" (the equally-suppressed someday *to-do* stays gray — the effect is project-circle-only). No CC report item. Verdict detail: [lab/upcoming-research.md](lab/upcoming-research.md) §blue-circle.

### 8g. Repeat/convert GUI transforms are IDENTITY REPLACEMENTS; the "Stop repeating" command lives on only ONE surface (UI2 + UI2-i, 2026-07-14)

Behaviors recorded from GUI driving (not bugs — model notes with automation consequences), evidence [lab/ui-vector-research.md](lab/ui-vector-research.md):
- **Making an existing to-do repeat** (Items → Repeat…) **destroys the original uuid** and spawns a NEW template row (carrying `rt1_recurrenceRule`) + a spawned instance. The row you "made repeat" is gone; anything holding its uuid is now dangling. (Contrast: **editing** an existing rule via Reschedule… mutates the rule bytes IN PLACE — same uuid.)
- **Convert to Project** (to-do OR heading) is likewise an **identity replacement**: new type=1 project uuid, old uuid dead, irreversible, behind a confirmation dialog. A converted **heading** is promoted into the parent project's **area** and its children reparent to the new project (`heading`→NULL).
- **Stop = the true "un-repeat," and it IS an identity replacement.** ~~There is no "Stop repeating" command anywhere~~ — **CORRECTED (UI2-i, 2026-07-14):** a **Stop** command exists. Confirmed via GUI (`i-15`/`i-16`): confirmation-guarded ("Stop To-Do from Repeating — Are you sure…?"), it **hard-deletes the template uuid** and **replaces it with a NEW plain to-do** whose `rt1_recurrenceRule` is **NULL** (rule fully cleared, not end-bounded); the already-spawned instance survives untouched; terminal (no Resume). So you CAN turn a repeating item back into a plain to-do via the UI — you just get a new uuid.
- **🚩 Menu-parity oversight (report-worthy): Stop is reachable from exactly ONE surface.** It appears **only** in the **open-card repeat-bar popover** (double-click the row → click "↻ Repeat every …" → Change… / Pause / **Stop** / Show Latest). It is **absent** from both the **Items menu** and the **row right-click context menu**, whose Repeat submenu offers only **Reschedule… / Pause↔Resume / Show Latest** (`i-13`). Every other Repeat action (Reschedule, Pause, Show Latest) is on all three surfaces; only Stop is card-popover-exclusive — a plausible CC UI oversight (menu parity). Pause remains the reversible cessation (`rt1_instanceCreationPaused=1`, also clears `rt1_nextInstanceStartDate`); an "Ends after/on date" bound in Reschedule and deleting the template are the other cessations.

These are why the ui vector treats make-repeat/convert/**stop** as identity-replacing transforms (any wrapper must re-fetch the new uuid), and why an automated "unrepeat" must drive the **card popover** — the only surface that spells Stop.

### 8h. Accessibility-tree surprises in Things (UIC1, 2026-07-14, Things 3.22.11)

Recorded while certifying the ui vector against the live AX tree ([lab/uic1-certification.md](lab/uic1-certification.md)) — automation-relevant, mostly not bugs:

- **List rows are not AX-addressable — and there is no AX/URL handle to select an arbitrary row.** A Things list row is an `AXRow` holding a single empty `AXCell` with no title, no `AXIdentifier`, and **no actions** (no `AXPress`/`AXOpen`). Consequences the AX-only vector cannot work around: (a) a to-do's edit **card opens only on a genuine mouse double-click** — `AXPress` on the cell, a second `AXPress`, `Return`, and `Get Info` all fail to open it (an `entire contents` scan finds no repeat bar), so the card-only **Stop** popover (§8g) is unreachable; (b) a **heading is not selectable via `things:///show?id=`** — the reveal URL selects to-dos only, so a heading id leaves the selection empty (window falls to Today) and `Convert to Project…` stays **disabled**. Both blocked UIC1 certification of `stop-repeat` and `heading.convert-to-project`.
- **`window 1` is a hidden 40×40 `AXUnknown` utility window.** The real UI is the `AXStandardWindow` (at index 2 in this build), and all sheets (confirm dialogs, the Repeat dialog) attach there. Addressing sheets on `window 1` silently targets the wrong window — recipes must select the standard window by subrole.
- **Setting the Repeat dialog's frequency pop-up with `set value` is a silent no-op.** `set value of <pop up button> to "weekly"` returns success but does not change the selection (the layout keeps showing "daily"). The control must be opened (`click`) and the menu item clicked, with a settle so the menu renders before the click lands. (Same class as UI2-i's dropdown-arrow finding.)
- **AppKit `_NS:NNN` identifiers regenerate per dialog layout.** The interval text field is `_NS:25` under a daily rule but `_NS:253` under weekly — the number changes when the frequency changes the dialog's control set. So `_NS:` identifiers are not stable addressing; positional/title addressing is required for dialog controls. (The menu-bar items expose stable name identifiers — `items`/`file`/`edit` — but every actionable menu *item* shares the generic `performCommand:`, useless for disambiguation. Only alert/confirm-sheet buttons carry semantic, locale-proof identifiers: `action-button-1`/`action-button-2`.)
- **Heavy AX poking degrades the Items menu until relaunch.** Repeatedly opening/cancelling dialogs and popovers can leave the Items menu missing its context-dependent entries (the `Repeat` submenu vanishes even with a repeating item selected); a clean app relaunch restores it. Operational, not a data bug.

## Suggested report to Cultured Code

Item 1 is the actionable bug: **"URL-scheme `when` update on a repeating to-do crashes Things 3.22.11 (both MAS and direct builds), while the same operation via AppleScript is correctly rejected with error 302 — the URL handler appears to skip the repeating-item validation."** Attach: repro steps above, a crash report from `~/Library/Logs/DiagnosticReports` (the lab harness collects the fresh `.ips` under `lab/artifacts/<runId>/guest-run/crash/` on every `lab:regress` run), and optionally items 2a–2c + 3 as related robustness feedback on the URL scheme's silent-failure modes.
