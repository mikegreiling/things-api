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

On `when=today` / `when=evening`, re-sending a bare `when=` (no `@time`) **clears** an existing reminder (R07). On a dated schedule it does NOT: `when=2026-07-09` on an item already dated 07-09 with a reminder leaves the reminder intact (R20), and re-dating to `when=2026-07-10` carries the reminder along to the new date (R21). Consequence: **there is no URL-scheme way to remove a reminder from a date-scheduled item** — a caller must bounce it through `when=today` (which clears) and re-date, or use the UI. Whichever behavior is intended, the keyword/date asymmetry is surprising; callers relying on the today/evening clear behavior silently fail on dates. Evidence: R07/R20/R21, 2026-07-05.

**Update 2026-07-09 (scf P3b):** the Shortcuts `Edit Items → Reminder Time` action with an EMPTY value DOES clear a dated reminder (`reminderTime` → NULL, `startDate` untouched). The URL-scheme asymmetry stands, but a workaround now exists outside it — Shortcuts is the only surface that clears a dated reminder in place.

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

### 5c. Checklist updates are replace-all and reset per-item state
`checklist-items=` replaces the entire checklist; previously completed/canceled checklist items are recreated as open — even when re-sending an identical item list. There is no additive or patch form. *(T07/U07/U20)*

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

## 6. CRASH: AppleScript `schedule` on a heading row kills the app

**CONFIRMED 2026-07-09 (P11e, PID watch):** `tell application "Things3" to schedule to do id "<heading-uuid>" for (current date) + 1 * days` returns `Connection is invalid. (-609)` and the Things process DIES (PID present before, gone after; heading row unchanged — no corruption observed). Heading rows are addressable via `to do id` (§5e's by-id pattern: `get properties`, `set name`, `set status` all work — see docs/lab/heading-research.md), so this is reachable by any script that touches to-dos by id without checking the row type. It is the second unguarded-precondition crash in the schedule-class family (§1 is the URL `when=` on repeating items) — the AppleScript guard that correctly rejects e.g. repeating to-dos (302) is missing for type=2 rows. A `.ips` capture is still wanted for the report (the probe VM's DiagnosticReports had not flushed one before teardown). things-api hard-blocks every todo-op against non-to-do targets.

### 6a. Heading "canceled" status is stored as completed — with a different child cascade

`set status of to do id "<heading>" to canceled` sets the heading row's status to **completed** (3, not 2 — headings appear to have no canceled state), yet cascades **canceled** (2) to its open children; `… to completed` cascades completed. Two different child outcomes distinguished only by an input value the heading itself does not record. Pre-resolved children keep their status and stopDate under both cascades (P11c/P11d).

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

## Suggested report to Cultured Code

Item 1 is the actionable bug: **"URL-scheme `when` update on a repeating to-do crashes Things 3.22.11 (both MAS and direct builds), while the same operation via AppleScript is correctly rejected with error 302 — the URL handler appears to skip the repeating-item validation."** Attach: repro steps above, a crash report from `~/Library/Logs/DiagnosticReports` (the lab harness collects the fresh `.ips` under `lab/artifacts/<runId>/guest-run/crash/` on every `lab:regress` run), and optionally items 2a–2c + 3 as related robustness feedback on the URL scheme's silent-failure modes.
