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
| S01 | `find-items` read | **CONFOUNDED — see 2026-07-10 correction below** | ~~Returns the item title as text~~ — every lab run searched an EXACT fixture title, so a real match and a plain input-echo were indistinguishable. Real-hardware retest proved the proxy ECHOES its input, it does not search. |
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

**Container delete cascades (P12, interactive, 2026-07-09):** a Shortcuts delete on a HEADING always cascades — Trash removes the heading row outright and reparents its children to the project root before trashing them; permanent removes heading + children with no tombstone. A Shortcuts delete on a PROJECT is SHALLOW — the project goes to Trash, children keep their links untrashed (matches AppleScript). Shortcuts has NO area-delete surface at all (Find Items never returns area rows).

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


## Follow-up probes, round 2 (scf2 run `things-run-scf2-20260709-045454`, 2026-07-09)

[`lab/scripts/research-scf2.sh`](../../lab/scripts/research-scf2.sh); raw report + `final.sqlite` under `lab/artifacts/things-run-scf2-20260709-045454/`. Fixture completion verified in-DB before every backdating probe (round 1's confound eliminated).

| # | Question | Verdict | Evidence |
|---|---|---|---|
| P4a | Backdate Completion/Creation Date via `set-detail` | **DEAD** | Five value shapes (`1/15/2025`, `January 15, 2025`, `2025-01-15`, `6/1/2024`, `June 1, 2024`) all exit-0 silent no-ops on a VERIFIED-completed fixture. |
| P4b | Backdate via AppleScript property writes | **WORKS** 🎉 | `set completion date of to do id X to ((current date) - (200 * days))` → `stopDate` 2026-07-05 → **2025-12-17**; `set creation date` → `creationDate` → **2025-05-31**. **Backdating existing items is unlocked, AppleScript-only.** |
| P4c | Backdate via URL `update?completion-date=` / `creation-date=` (auth token attached) | **SILENT NO-OP** | `completed=true` WITH the token works (round-1 diagnosis confirmed); the date params change nothing (oddity 2g). |
| P4d | **At-creation backdating via `things:///json` attributes** | **WORKS** 🎉 | `{"completed":true,"creation-date":"2024-06-01T08:00:00Z","completion-date":"2025-01-15T09:00:00Z"}` → row created `status=3`, `stopDate=2025-01-15 09:00`, `creationDate=2024-06-01 08:00` — exact values honored. The logbook-import / GTD-migration path. |
| P3a | Set Reminder Time via `set-detail`, format sweep | **DEAD** | `2:30 PM`, `14:30`, `7/5/2026 2:30 PM` — all exit-0 no-ops on a scheduled fixture. `Edit Items → Reminder Time` can only CLEAR (P3b); it cannot set. |
| P2b | `set-detail` Parent on a TO-DO (text uuid value) | **DESTRUCTIVE FOOTGUN** 🚨 | The to-do was not moved to the target project — it was **DETACHED from its project entirely** (`project` → NULL), exit 0. Text→entity coercion fails and CLEARS the parent (oddity 5l). An entity-typed variant (a proxy whose Parent field takes a second `Find Items` output) is unprobed — needs a golden sitting to build. |
| P6a–g | Sidebar order, exhaustive spelling sweep | **ALL DEAD — sidebar ordering is conclusively UI-only** | `move project id X to before project id Y` → −1700; `move project/area … to beginning of …` → −1700; `set index of project/area` → −10006 (read-only); private reorder with top-level-project uuids (P17 re-check) or AREA uuids in `list "Anytime"` → zero-delta no-ops. Host sdef dump confirms exactly ONE private command exists (`_private_experimental_ reorder to dos in`) — no hidden sidebar verb. |
| P6h | Private reorder in `list "Someday"` | **WORKS** 🎉 | `LAB-SOMEDAY-1` `"index"` 0 → −901, landing ABOVE the first-listed id — consistent with the Inbox scope's REVERSED wire-list convention (A6). **Someday is a new native reorder scope**; lock the exact convention with a 3-item probe before wiring the op. |

## Doctrine impact (for Mike)

gaps.md §0 held the headings doctrine as "flatten unless Shortcuts delivers; **dual-mode** candidate (first-class with a Shortcuts vector, flattened otherwise)." **Shortcuts delivered** — create/rename/delete all work — so the dual-mode path was unblocked. RESOLVED 2026-07-09: **first-class always, no flatten/dual mode** (roadmap §E, gaps §0); only `heading.create` is capability-gated behind the Shortcuts vector, exhaustively confirmed by the HX sweep ([heading-research.md](heading-research.md)).

## Real-hardware validation + corrections (2026-07-10, Mike's Mac)

The signed extracted `.shortcut` files were import-and-run tested on Mike's production machine (reads only; no data harm, no write-rail violation — but see the safety note).

- **Distribution pipeline VALIDATED end-to-end.** `open shortcuts/things-proxy-find-items.shortcut` → the genuine "Add Shortcut" import sheet (signature accepted, "anyone" mode trusted) → the shortcut installs and runs. **iCloud-free signed-file distribution works on real hardware** — closes the last §A.1 open item. Consent classes observed live: an **input** class ("Allow X to *share 1 dictionary with* Things", Always-Allow available) distinct from the **output** class documented earlier, plus a broader **"Allow X to *access* Things"** on the hand-authored variant.

- **S01 CORRECTION — `find-items` ECHOES its input, it does not search.** Query `{"search":"anything"}` → output `anything`; query `{"search":"CLEAN AIR CONDITIONER"}` (a real to-do's title deliberately mis-cased) → output `CLEAN AIR CONDITIONER` verbatim (NOT case-folded to the stored casing). A true match would return the item's stored title; the verbatim caps prove it's echoing the input value. Root cause in the extracted blob (`lab/artifacts/things-run-sx3-20260709-165344/sx3-out/things-proxy-find-items.ZDATA.blob`): action 1 (Find Items / `TAIItemEntity`) has an **empty** `WFActionParameterFilterTemplates` (no predicate) plus a stray `WFContentItemInputParameter` aggrandizing the dict `search` value; the proxy was mis-built during the L5 sitting. The other five proxies address by `id` and are unaffected. **Product impact: NONE** — the write pipeline addresses items by uuid from SQLite reads; `find-items` is a diagnostic-only proxy on no write path.

- **⚠️ CRASH (lab-PENDING, not yet a firm oddity): a malformed Find Items predicate crashed Things.** A hand-authored repair (graft a `Property="name"` / `Operator=4` / `Unit=4` filter row cribbed from `edit-title`'s `id` filter, drop the input-parameter, add Limit 1) IMPORTED fine but on run: `Error: The action "Find Items" could not run because the "Things" app quit unexpectedly.` Unknown whether this is (a) a genuine Things bug (malformed predicate → crash = a NEW crash family distinct from schedule-class, oddities §7) or (b) simply an invalid serialization on my part (wrong Property key — maybe `title` not `name` — or wrong Operator/Unit). **Must be discriminated in a VM clone, NOT on prod.** The crash-inducing asset was reverted from `shortcuts/` immediately (`git checkout`); the committed file is the non-crashing echo-bug version.

### Queued VM work (the `find-items` repair campaign)
1. In a golden clone, iterate the Find Items filter serialization until it returns REAL matches: candidate `Property` values `title` / `name`; confirm `Operator` (4 = "is"?) and the `Unit`/string-token shape against a KNOWN-GOOD hand-built Find-Items-by-name shortcut (build one in the golden GUI, extract its blob, diff — the authoritative reference). Prove with a case-fold test (mis-cased query returns stored casing = real match).
2. Determine if the malformed-predicate crash reproduces with obviously-invalid predicates → if yes, bank as oddities §7 crash family C4 with an `.ips`.
3. **Novel-path candidate — programmatic shortcut authoring:** the extracted-blob→edit→sign→import path already proves import+sign of a *hand-edited* workflow; if a hand-authored FILTER runs correctly in the VM, we can COMPOSE new proxies in Python with no golden GUI sitting — materially changes the §A.2 write-vector-wiring plan (no human-in-VM needed to mint proxies). Bank in novel-paths.md if it works.
4. Only a VM-validated re-signed `shortcuts/things-proxy-find-items.shortcut` returns to the repo + Mike's machine.

### Safety note (banked)
Iterating hand-authored/experimental shortcuts on the PRODUCTION host crashed Things (read-only op, so no data loss and no write-rail breach — but a crash nonetheless). Rule reaffirmed: **all shortcut experimentation happens in disposable golden clones; only validated assets touch prod.** `find-items` reads are the only prod-safe shortcut runs; the five mutating proxies must never be `shortcuts run` against prod outside the verified pipeline.
