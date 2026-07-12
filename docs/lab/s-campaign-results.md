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

## VM repair campaign results (SX5 + SX6, 2026-07-10) — all four queued items CLOSED

[`lab/scripts/research-sx5.sh`](../../lab/scripts/research-sx5.sh) (repair + crash discrimination; artifacts `lab/artifacts/things-run-sx5-20260710-140641/` — report, four `.ips`, variant blobs) and [`lab/scripts/research-sx6.sh`](../../lab/scripts/research-sx6.sh) (import validation; artifacts `lab/artifacts/things-run-sx6-20260710-141331/` — screenshots). Final asset builder: [`lab/scripts/build-find-items-shortcut.py`](../../lab/scripts/build-find-items-shortcut.py).

**Zero-cost evidence first (no VM, no app interaction):** `Things3.app/Contents/Frameworks/ThingsCommon.framework/Versions/A/Resources/Metadata.appintents/extract.actionsdata` (host file read, Things 3.22.11 — same version as golden) is the authoritative App Intents vocabulary. `entities.TAIItemEntity.properties` lists identifier **`title`** (display key "Title"); there is **no `name` property** — the prod crash used a nonexistent identifier. `queries.TAIItemQuery` gives per-property comparators: `title` → [0,6,7,8] (equals/contains/begins/ends), `id` → [0,1]. (Note: the top-level `Things3.app/Contents/Resources/Metadata.appintents/` is an empty stub — the real metadata lives in the ThingsCommon framework.)

**Method — DB surgery preserves consent (new fact).** Killing `siriactionsd` and UPDATE-ing the golden-resident proxy's `ZSHORTCUTACTIONS.ZDATA` blob in place lets the candidate run HEADLESS under the golden's inherited Always-Allow — consent is keyed to shortcut identity, not action content. Readback after every injection was byte-identical; no re-signing/validation layer rejected the surgery; the runtime picked up each new blob immediately (no stale cache observed across 7 injections).

| # | Probe | Verdict | Evidence |
|---|---|---|---|
| SX5-0 | baseline unmodified proxy | echoes input verbatim (S01 correction re-confirmed in-VM) | input `sx5 baseline echo probe` → output same |
| SX5-1 | **repair `v-title-is`** (filter row `Property="title"`, `Operator=4`, `Unit=4`, dict-key `search` token, Limit 1, stray `WFContentItemInputParameter` dropped) — MIS-CASED query | **REAL MATCH, case-insensitive** 🎉 — the case-fold discriminator: query `lab-inbox-1` returned the STORED casing `LAB-INBOX-1` | exit 0, Things alive |
| SX5-2 | same, exact-cased query | `LAB-INBOX-1` | exit 0 |
| SX5-3 | same, no-match query | clean empty (exit 0, no output file, no error) | |
| SX5-4/5 | `v-title-contains` (`Operator=99`), substring `lab-inbox` / no-match | contains also works, also case-insensitive (returned `LAB-INBOX-2`); no-match clean empty | Operator 4 "is" is the shipped choice |
| SX5-C1a/b | `v-name-is` — the EXACT prod-crasher (Property `"name"`) — two runs | **CRASH both runs** — Things PID dead, fresh `.ips` each (EXC_BREAKPOINT/SIGTRAP, Swift trap in the app's Base/FoundationAdditions frameworks) | run 1: "Things app quit unexpectedly"; run 2: "Couldn't communicate with a helper application" — same underlying crash |
| SX5-C2 | `v-garbage-prop` (Property `"zzzNotAProperty"`) | **CRASH** | third `.ips` |
| SX5-C3 | `v-bad-operator` (VALID `title` property, Operator 987654) | **CRASH** | fourth `.ips` — unknown Operator is independently fatal |
| SX5-F | restore `v-title-is` post-crashes, sanity | `lab-inbox-1` → `LAB-INBOX-1` again | crash left no wedge |

**Verdicts against the queue:**
1. **Filter repaired** — `Property: "title"` (not `name`), Operator 4 ("is", case-insensitive), Unit 4, the edit-title token shape. Case-fold proof above. No-match behavior: clean empty output.
2. **Crash discriminated — REAL BUG, banked as oddities §7 C4**: any unrecognized predicate `Property` OR `Operator` reproducibly crashes Things (4/4, `.ips` collected). My prod serialization was *invalid* (wrong property), but the app crashing on it (instead of erroring) is the defect.
3. **Programmatic shortcut authoring banked** — novel-paths #18. The working filter was composed in Python and never touched a GUI; with the ThingsCommon metadata as the vocabulary source, new proxies need no golden GUI sitting (changes roadmap §A.2).
4. **Validated asset shipped** — `shortcuts/things-proxy-find-items.shortcut` rebuilt (SX5-validated actions + the committed file's exact envelope, recovered from its AEA payload via `aea decrypt -sign-pub <leaf-cert pubkey>` + `aa extract`; only `WFWorkflowActions` differs), signed `--mode anyone`, and **import-validated end-to-end in a fresh clone (SX6)**: `open` → genuine Add-Shortcut sheet (signature accepted) → "Add Shortcut" clicked via **VNC synthetic input** (`tart run --vnc-experimental` + vncdotool — no TCC, first working demonstration of the §E½ VNC arm) → row landed in `Shortcuts.sqlite` (`shortcuts list` shows it). The run-after-import consent modal was not exercised (fresh identity needs one Always-Allow click) — Mike's real-hardware import will grant it on first run, exactly like the other five proxies.

## Follow-up probes, round 3 (run `things-run-r3-20260712-171142`, 2026-07-12)

One `--vnc-experimental` clone; headless SSH probes + VNC-driven GUI arms (vncdotool, sx6 mechanics). Script: [`lab/scripts/research-scf3.sh`](../../lab/scripts/research-scf3.sh) re-runs the headless slice autonomously (P4/P3a/P2b/P6 + Someday lock + logNow + deadline-less-repeat read + repeating-clear). Raw report + `final.sqlite` under `lab/artifacts/things-run-r3-20260712-171142/`; 6½ screenshots under `.../oddity-6half/`. All reconfirmations matched scf2 **exactly** — no verdict drift on a fresh clone.

| # | Question | Verdict | Evidence |
|---|---|---|---|
| P4a | Backdate Completion/Creation via Shortcuts set-detail | **DEAD** (reconfirmed) | `Completion Date <- 2025-01-15` on a verified-completed fixture: exit 0, zero delta |
| P4b | Backdate via AppleScript `set completion/creation date` | **WORKS** (reconfirmed) | stopDate 2026-07-05 → **2025-12-17**; creationDate → **2025-05-31** |
| P4c | Backdate via URL `update?completion-date=` (+token) | **NO-OP** (reconfirmed) | `completed=true` sticks; date params zero-delta (oddity 2g) |
| P4d | At-creation backdating via `things:///json` | **WORKS** (reconfirmed) | row `status=3`, stopDate `2025-01-15 09:00`, creationDate `2024-06-01 08:00` — exact |
| P3a | set-detail Reminder Time SET (`2:30 PM`, `14:30`) | **DEAD** (reconfirmed) | reminderTime stays NULL on a scheduled fixture; set-detail can only CLEAR (P3b) |
| P2b | set-detail Parent (text uuid) on a TO-DO | **DESTRUCTIVE DETACH** (reconfirmed) | project `933T…` → **NULL** (item detached, NOT moved to the target — oddity 5l) |
| P6-sdef | Full private-command inventory | **exactly ONE private command** | read the bundle's `Things.sdef` directly (the `sdef` binary needs Xcode, absent in the lab): `_private_experimental_ reorder to dos in` is the only `_private_` verb — no hidden sidebar-reorder spelling. (Also present: `log completed now`, `schedule`.) |
| P6a/c | move project location / `set index` | **DEAD** (reconfirmed) | `move … to before …` → −1700; `set index of project` → −10006 (read-only). Sidebar order stays UI-only. |
| **P6h** | **Someday reorder — 3-item convention LOCK** | **REVERSED wire-list — LOCKED** 🎉 | wire-list `[S3,S1,S2]` produced top-to-bottom order **`[S2,S1,S3]`** (index −2040/−1886/−1680) = the exact reverse of the input, matching the Inbox A6 reversed convention. The Someday reorder scope's wire convention is now nailed for wiring. |
| LOGNOW | Does `log completed now` (AS) update `manualLogDate`? | **YES** | manualLogDate `12:05:41` → **`12:08:34`** (= current guest clock) after an AS `log completed now`. Confirms the boundary's max()-in-manualLogDate model (src/read/log-boundary.ts). |
| logInterval | Full enum (GUI Settings dropdown) | **0=Immediately · 1=Daily · 4=Manually — NO weekly/monthly** | The "Move completed items to Logbook" dropdown offers only **three** options (screenshots banked). Golden default = 0. Selecting Daily → `logInterval=1`; Manually → **`logInterval=4`** (NOT 2/3). **`2`(weekly) and `3`(monthly) do not exist in Things 3.22.11** — those model branches are unreachable. `4` correctly falls to the model's `default` (manual) branch. |
| DLREPEAT | Can a deadline-LESS fixed repeat exist, and how does it encode? | **YES — and it FALSIFIES the fixed⇒deadlined law** 🚨 | The repeat editor's **"Add deadlines" is an opt-in checkbox, OFF by default**; the seeded LAB-REPEAT-DAILY is a fixed (tp=0) daily rule created deadline-less. Its instances carry a `startDate` but **`deadline` is NULL**. Enabling "Add deadlines and start 0 days earlier" leaves `rt1_recurrenceRule` **byte-identical** (tp=0, ts=0, of=[{dy:0}]) and `t2_deadlineOffset=0` — a same-day deadline collapses to the deadline-less encoding. So **`rt1_recurrenceRule` ALONE cannot tell whether a fixed rule's instances get a deadline**; the model's "event date ⇒ deadline for every fixed rule (incl. ts=0)" holds only for Mike's all-deadlined corpus, not the encoding. See oddities §8. (**Follow-up RESOLVED 2026-07-12 by UI1 below**: the discriminator is the template's own `deadline` COLUMN — NULL vs a 4001-01-01 sentinel; a non-zero offset also shows as `ts=−N`. `t2_deadlineOffset` stays 0. Projection fix shipped.) |
| RCLEAR | Repeating-template dated-reminder clear (RC residual) | **No in-place automation clear exists — refusal STAYS** | A repeating template's reminder is a **repeat-RULE property, not a `reminderTime` column value**: setting "Add reminders 12:00 PM" in the repeat editor persists in the editor yet leaves `reminderTime` NULL on the template AND its pre-spawned instances, and adds no time key to the decoded rule (storage location unresolved — see oddities §8). Consequently: **(a) Shortcuts `set-detail Reminder Time=""` on the template = SAFE no-op** (exit 0, NO crash — PID stable, rule intact, nothing to clear); **(b) AppleScript `move … to list "Inbox"` on the template = CLEAN REFUSAL, error 301, NO crash** (the AS guard rejects de-scheduling a repeating item — contrast the URL `when=` path which CRASHES, §1). Neither clears the rule's reminder (UI-only). `todo.clear-dated-reminder`'s repeating refusal is CORRECT and should stay. |

## UI-vector campaign (UI1) — §E½ feasibility + deadline-less-repeat discriminator (2026-07-12, PR mg/ui-vector-probe)

One `--vnc-experimental` clone, autonomous. Reused the SX6 VNC synthetic-input mechanics. **Accessibility is NOT granted in the golden** (`osascript` "System Events" → error −1719 "not allowed assistive access", cannot be granted without disabling SIP), so there is **no AppleScript UI-scripting fallback** — every menu click, dialog interaction, and keystroke is VNC (hardware HID, no TCC). VNC framebuffer = the golden's physical 2048×1536; layout is deterministic per resolution. Run script: [`lab/scripts/research-ui1.sh`](../../lab/scripts/research-ui1.sh); screenshots (`00`–`14`) + `final.sqlite` + `discriminator-evidence.txt` under `lab/artifacts/things-run-ui1-explore-20260712-180724/`.

| Probe | Question | Verdict | Evidence |
|---|---|---|---|
| UI1-A | §E½: can VNC drive `File → New Repeating To-Do` end-to-end and land a rule? | **FEASIBLE** ✅ (headline) | Menu → Repeat=daily → OK → typed title, all via VNC. DB: an `rt1_recurrenceRule` template row landed (tp=0 fixed, fu=16 daily, fa=1, ts=0, of=[{dy:0}], rrv=4) + a spawned instance with a startDate. Green-lights a dedicated-Mac "ui" write vector. |
| UI1-A(rel) | Reliability / input methods | menu-nav first-try; **VNC keyboard WORKS** | Menu-bar and dialog clicks hit first attempt. VNC keyboard entry into text AND numeric fields works — the DLREPEAT "days earlier" failure is overcome. Gotchas: `vncdo type` sends letters LOWERCASE; `super-a` types a literal 'a' (Cmd modifier doesn't register), so clear a field with N×`bsp` + N×`del`, never select-all. |
| UI1-B | Deadline-less vs deadlined FIXED repeat: DB discriminator? | **FOUND — the template's own `deadline` COLUMN** 🎉 | Created all variants via the GUI. Deadline-less (default): template `deadline`=**NULL**; instance `deadline`=NULL. Deadlined offset-0: template `deadline`=**262213760 (4001-01-01 sentinel)**; rule byte-identical to deadline-less (ts=0). Deadlined offset-3: template `deadline`=sentinel, rule **ts=−3**, instances `deadline`=start+3d. `t2_deadlineOffset`=0 in ALL cases (NOT the discriminator). The seeded deadline-less LAB-REPEAT-DAILY control reads `deadline`=NULL. |
| UI1-B' | Does the discriminator generalize to after-completion? | **YES — universal** | after-completion nodl: template `deadline`=NULL. after-completion + "Add deadlines" (offset 0, ts=0): template `deadline`=sentinel, instance `deadline`=real date. This ALSO falsifies the old after-completion "deadline only when ts<0" heuristic (a deadlined ts=0 after-completion template exists). |

**Fix shipped (same PR):** new `RepeatingInfo.deadlined` (mapper reads the template `deadline` column; the sentinel is nulled so it never surfaces as a phantom deadline on template rows), and `src/read/views.ts` + `src/model/occurrences.ts` gate the occurrence deadline on it instead of `rule.type==="fixed"`. `src/model/recurrence.ts` CAVEAT rewritten with the discriminator; unit tests over both encodings in `test/unit/occurrences.test.ts` + `recurrence.test.ts`. Oddities §8a table updated.
