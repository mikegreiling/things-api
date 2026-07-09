# Shortcuts (S) campaign — results

Evidence from the Shortcuts write vector, built during the L5 golden sitting (2026-07-09) and probed via the six `things-proxy-*` shortcuts. First-run evidence was captured during consent absorption ([`lab/scripts/l5-consent-absorb.sh`](../../lab/scripts/l5-consent-absorb.sh); raw log `lab/artifacts/l5-sitting-20260709/consent-probes.txt`). Recurring locked probes live in [`lab/suites/s-suite.json`](../../lab/suites/s-suite.json) and run in disposable clones post-freeze.

## The proxies (golden-resident; Apple provides no programmatic import)

Six shortcuts, all using the **Find → act** pattern (entity fields take a `Find Items` output, never a raw string) and **ID (uuid) addressing** (Find Items *does* offer an `ID` filter — the hoped-for upgrade; there is no `Name` filter, the name field is `Title`):

| Proxy | Input contract |
|---|---|
| `things-proxy-find-items` | `{"search": <name>}` |
| `things-proxy-create-heading` | `{"title": <str>, "project": <uuid>}` |
| `things-proxy-edit-title` | `{"id": <uuid>, "title": <str>}` |
| `things-proxy-set-detail` | `{"id": <uuid>, "detail": <Detail>, "value": <str>}` |
| `things-proxy-delete-items` | `{"id": <uuid>}` → Trash |
| `things-proxy-delete-items-permanently` | `{"id": <uuid>}` → Delete Immediately |

## Verdicts (first-run, 2026-07-09)

| # | Capability | Verdict | Evidence |
|---|---|---|---|
| S01 | `find-items` read | **WORKS** | Returns the item **title** as text (not the uuid) — consumers must map title→uuid themselves, or the proxy needs a "Get Details (ID)" tail to emit uuids. |
| S02 | **Create a heading in an EXISTING project** | **WORKS** 🎉 | `Create Heading` made a `type=2` row with `project=<proj uuid>`. **Closes gaps.md §1** — the one capability dead on both URL (T09/U09) and AppleScript (A31). |
| S03 | Rename a heading | **WORKS** | `Edit Items → Set Title` renamed the `type=2` row in place. |
| S04 | Delete a heading | **WORKS** | The heading row is removed from `TMTask` (headings don't sit in Trash independently). Child-reparenting behavior on a NON-empty heading is unprobed (this heading was empty) — an S-suite follow-up. |
| S-detail | `set-detail` "Reminder Time" | **INCONCLUSIVE** | On an unscheduled Inbox to-do (`startDate` NULL) `reminderTime` stayed NULL — a reminder needs a date to attach to. Re-probe on a SCHEDULED fixture (and test the dated-reminder CLEAR path, oddity 2e) in a clone. |
| S-delperm | **Permanently delete ONE item** | **WORKS** 🎉 | `Delete` with **Delete Immediately** ON: row count 1 → 0, **no tombstone**. **Closes the single-item permanent-delete gap** (dead on AppleScript — B0/A5 — and URL). |

## The Edit Items ("Set Detail") action — a generic editor

`Set ‹value› ‹detail› of ‹Items›` and **the Detail selector accepts a variable**, so one proxy covers the whole Detail list: **Title, Parent, Start, Reminder Time, Deadline, Tags, Status, Completion Date, Notes, Checklist, Creation Date**. Notables that exist nowhere else and want S-suite probes: **Reminder Time** (dated-reminder clear?), **Parent** (heading/container re-parent → heading *move*?), **Completion Date / Creation Date** (backdating — no other surface writes these).

## Consent model (operationally decisive)

Shortcuts Privacy is **per-shortcut and per-data-class**, and is a DIFFERENT system from the AppleEvents Automation consent probed in Phase 21b:

- **Output-class** actions (create/edit/set/find — "Allow X to **output** N items") offer **Always Allow** → durable, headless after one grant. Clones inherit the grant.
- **Delete-class** actions ("Allow X to **delete** N items") offer only **Don't Delete / Delete** — **no "Always" option**. They **re-prompt on every run** and can never be headless.

Consequence: a Shortcuts create/edit/set/find vector can run autonomously; a Shortcuts **delete/permanent-delete is inherently interactive (tier 3, user-present)**. The single-item permanent delete is a real new capability but only as a user-confirmed action — not an autonomous op. The S-suite's delete probes therefore need a human (or SIP-off consent-DB seeding) and can't ride the autonomous `lab:regress`.

## Catalog facts banked (from the action sweep)

- **No repeat parameters** on any Things action (Create To-Do/Project, Edit Items) — confirms repeating-item creation/rule-edit is dead on Shortcuts too, empirically at the catalog level.
- **No Convert action** — to-do↔project conversion is dead on Shortcuts (S05 needs no probe; closes it).
- **No Move action** — heading *move* has no dedicated verb (candidate: `set-detail` Parent — unprobed).
- Create To-Do exposes **Parent + Heading** fields (a second heading-placement surface) and a `Start` of On Date / Anytime / Someday only (no Today/Evening/Inbox keywords at creation).
- `Duplicate Items` exists (could it duplicate a heading? — unprobed).

## Follow-up probes (scf run `things-run-scf-20260709-041543`, 2026-07-09)

Autonomous clone run ([`lab/scripts/research-scampaign-followups.sh`](../../lab/scripts/research-scampaign-followups.sh); raw report + `final.sqlite` under `lab/artifacts/things-run-scf-20260709-041543/`). First fact banked: **output-class Shortcuts consent IS inherited by clones** — every proxy ran headless.

| # | Question | Verdict | Evidence |
|---|---|---|---|
| P1 | Does the private reorder command accept **heading** uuids? | **WORKS** 🎉 | `_private_experimental_ reorder to dos in project id … with ids "<Beta>,<Alpha>"` moved Beta above Alpha (`"index"` 0 → −799 vs Alpha −409); both headings' children kept their `heading` FK. **Heading reorder within a project is automatable** (AppleScript, tier 0) — the command is misleadingly named; it takes to-dos, projects (O14), and now headings. |
| P2 | `set-detail` Parent = heading **move** to another project? | **SILENT NO-OP** | exit 0, item echoed back, `TMTask.project` unchanged. Heading move is now dead on ALL surfaces. (The to-do re-parent variant was not attempted — scf2.) |
| P3a | `set-detail` Reminder Time `"14:30"` on a SCHEDULED to-do | **NO-OP** (string coercion suspect) | exit 0, `reminderTime` stayed NULL on a `start=1, startDate` set fixture. Likely the text→Date coercion fails silently; format experiments queued (scf2). |
| P3b | Clear a **DATED** reminder via `set-detail` Reminder Time `""` | **WORKS** 🎉 | `reminderTime` 603979776 → NULL, `startDate` untouched. **Closes the oddity-2e sticky-dated-reminder gap** — the one reminder edit no other surface can make, and it's output-class (headless). |
| P4 | Completion/Creation Date backdating via `set-detail` | **INVALID RUN** — re-probe (scf2) | Two script bugs: (a) the completion step used `things:///update?…&completed=true` WITHOUT the auth token, so the fixture was never completed (`status=0` in `final.sqlite`); (b) both P4 proxy runs produced NO output, so `cat` served the STALE `--output-path` file from P3b (`SCF-REM-DATED` echoed while targeting `SCF-BACKDATE`). No verdict on backdating itself. |

Harness lessons: `proxy()` must `rm -f` the `--output-path` file before each run (stale-output aliasing); `shortcuts run` exits 0 even when `Edit Items` silently fails inside (oddity 5k) — DB delta is the only truth.

## Doctrine impact (for Mike)

gaps.md §0 held the headings doctrine as "flatten unless Shortcuts delivers; **dual-mode** candidate (first-class with a Shortcuts vector, flattened otherwise)." **Shortcuts delivered** — create/rename/delete all work — so the dual-mode path is unblocked. The implementation decision (flatten vs dual-mode, and whether to ship the interactive permanent-delete) is Mike's; recorded here, not yet acted on.
