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

**Also affected:** non-scheduling updates on the same repeating item work fine (`title`, checklist items), so the crash is specific to schedule-class fields via URL.

**Evidence:** first isolated 2026-03-12 on the MAS build (validation notes T12, reproducible across repeat configs); re-reproduced deterministically 2026-07-03 in clean-room VMs on the trial build — probe `U12` (crash detector: process death + `.ips` capture + row-unchanged assertion, green in every acceptance run), guard contrast probe `A21`. Repo refs: `docs/research/validation-notes-step3.md` (T12), `docs/lab/u-suite-results.md`, `docs/lab/a-suite-results.md`, `lab/suites/u-suite.json` (U12), `lab/suites/a-suite.json` (A21).

---

## 2. Silent-failure hazards in the URL scheme

Commands that fail *silently* — the caller gets no signal that nothing (or only part) of the request happened. `open` exits 0 regardless, so an automation caller has no error channel at all; these make read-after-write verification mandatory.

### 2a. Unknown `list=` destination → complete silent no-op
`things:///update?id=<uuid>&auth-token=<t>&list=No Such Area` does nothing: no modal, no mutation, no log. A typo in a destination name is indistinguishable from success. *(T06/U06)*

### 2b. Unknown tags → silently dropped (partial write)
`things:///add?title=X&tags=real-tag,typo-tag` creates the to-do with only the tags that already exist; unknown names are discarded without any indication, and no tag is created. The caller believes the full tag set was applied. *(T03/U03, U04)*

### 2c. `heading=` never creates a heading — silently ignored when missing
On `add`, a `heading=` value that doesn't match an existing heading in the target project is dropped: the to-do is created un-headed. Heading placement works only against pre-existing headings (and matching is by name, so duplicate heading names are ambiguous). *(T09/U09)*

---

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

### 5d. Repeating templates are invisible to AppleScript list reads but fetchable by id
`to dos of list "Someday"` omits repeating templates entirely, yet `to do id "<template-uuid>"` returns them fine. Third-party tooling that enumerates lists (e.g. things.py) can't see repeat rules at all through official read surfaces. *(A12, T16)*

### 5e. `things:///version` launches and foregrounds the app, shows nothing
Without an x-callback, the version command has no visible output — its only observable effect is launching Things and taking focus. *(T01/U01)*

---

## Suggested report to Cultured Code

Item 1 is the actionable bug: **"URL-scheme `when` update on a repeating to-do crashes Things 3.22.11 (both MAS and direct builds), while the same operation via AppleScript is correctly rejected with error 302 — the URL handler appears to skip the repeating-item validation."** Attach: repro steps above, a crash report from `~/Library/Logs/DiagnosticReports` (the lab harness collects the fresh `.ips` under `lab/artifacts/<runId>/guest-run/crash/` on every `lab:regress` run), and optionally items 2a–2c + 3 as related robustness feedback on the URL scheme's silent-failure modes.
