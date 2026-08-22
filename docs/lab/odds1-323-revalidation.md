# ODDS1 — the full oddities re-validation against Things 3.23

**Probed under: `things-lab-golden-v4` · Things 3.23 (CFBundleVersion 32300036, direct-download channel) · macOS 15.7.7 (24G720) · `Meta.databaseVersion` 27 · guest clock pinned 2026-07-05 12:00 (rolled deliberately in batch D).** Campaign run 2026-08-22, unattended, six disposable clones. Immutable snapshot per the [harness](harness.md) version-stamping policy.

**Why this exists.** [things-app-oddities.md](../things-app-oddities.md) is the draft Cultured Code report, and most of it was measured on Things 3.22.11 – 3.22.14. The maintainer's directive (2026-08-23): *"I don't want to report a list of stale bug reports."* This document is the **freshness index** for that report — one row per entry, each carrying a current-version verdict and the evidence that produced it. The oddities entries themselves were **never rewritten**; every verdict below is mirrored into the entry as a DATED one-line appendix (house precedent: §8l's retraction, §13's addendum).

Drivers: [`lab/scripts/research-odds1a.sh`](../../lab/scripts/research-odds1a.sh) … [`research-odds1f.sh`](../../lab/scripts/research-odds1f.sh). Raw reports under `lab/artifacts/odds1{a,b,c,d,e,f}-lab/` (gitignored).

---

## 0. Headline

- **Nothing in the report has silently rotted.** The ledger below carries **106 rows** (one per claim; §7's catalog contributes six). **53** were re-measured directly on a golden-v4 clone this campaign, **31** ride another 3.23 campaign or a green golden-v4 suite lock, and **27** are honestly marked NOT re-validated with the rig they need. Verdicts: **55 STILL · 9 PARTIAL · 9 MOOT · 4 SUPERSEDED · 1 CHANGED · 27 NOT RE-VALIDATED · 1 n/a**. Not one entry was found to be quietly wrong.
- **The two crash entries the report leads with are alive on 3.23** — and both are now **sharper**, not weaker. §7 C2 (`update-project?when=` on a repeating PROJECT) is confirmed for the first time since 2026-07-09. And §1's `when=` family SPLITS: every spelling that names a *bucket* kills the app, while a spelling that resolves to a *calendar date* survives and silently re-anchors the series' spawn cursor. "The bucket branch of the URL handler has no repeating-item precondition, and the date branch has no user-visible signal" is a far better bug report than "the whole family crashes".
- **Four entries moved, and the report must say so:** the json/`delete` error modals no longer steal focus (§4b), deleting a repeating to-do template now raises a real confirmation sheet (§9bb), `Stop` is now reachable from the Items menu (§8g's menu-parity oversight is fixed), and `AXEnhancedUserInterface = true` no longer collapses the AX tree (§8j).
- **Nine entries are MOOT rather than fixed.** The private `_private_experimental_ reorder to dos in` verb is accepted-and-inert on 3.23 (§12), so every destructive side effect that rides it — §9c, §9f, §9g, §9k, §9m, §9p, §9s, §9t and the §5o HEADSORT/LOGSORT addenda — cannot be provoked on this build (§9e and §9r are moot in their reorder half too). They are true as of 3.22.12/3.22.14 and must be reported that way, not as live 3.23 defects.
- **Twenty-seven rows could not be re-validated here and say so plainly** — GUI drags, framebuffer renders, Quick Find, the Today banner, Shortcuts delete-class consent, a live Automation-consent dialog, and four GUI-minted fixtures the golden does not carry. Each row names the rig it needs.

---

## 1. Method

Six clones of golden-v4, one per batch, each airgapped (default route deleted), clock-pinned, guest audio muted at boot, torn down on exit. Synthetic `ODDS1-*` fixtures throughout; the golden's own `LAB-*` seeds are read, and mutated only where an entry's recipe needs an existing heading / repeating template. Guest SQLite (read-only) is the ground truth — `open` exit 0 proves nothing.

| batch | clone | what it covered |
|---|---|---|
| A | `odds1a-lab` | 20 non-crashing URL / AppleScript / `things:///json` cells |
| B | `odds1b-lab` | error-modal classes, heading cells, `later-projects`, then the two crash triggers (§7 C3, C2) one at a time |
| C | `odds1c-lab` | the stray-`.ips` isolation, the §4b focus re-measurement (2 runs × 3 classes), the 3.23 delete-confirmation sheet, the Items ▸ Repeat menu census, Settings, the Shortcuts proxies |
| D | `odds1d-lab` | clock-roll cells (§9x, §9n, §9z) and the schedule-KEYWORD crash matrix |
| E | `odds1e-lab` | confirmation pass: the `when=` spelling matrix ×2 runs, and the §9bb project arm |
| F | `odds1f-lab` | the two arms E left open: the project delete driven from the Edit MENU, and what a dated `when=` on a template actually writes |

**Crash discipline.** Crash triggers ran last in their batch, one at a time, with a full relaunch between each and a `.ips`-count + pid oracle around every one. Nineteen process deaths were provoked across the campaign (1 · 2 · 0 · 5 · 11 · 0 by batch); every one left the target row byte-identical.

**Classification.** Each entry is one of:

- **(a) cited** — already re-validated on 3.23 this week by another campaign or by a green golden-v4 suite lock; not re-run here.
- **(b) re-run** — this campaign re-executed the entry's own reproduction recipe on a golden-v4 clone.
- **(c) needs-rig** — a framebuffer drag, a GUI-only view, a consent dialog, a second synced device. Honestly **NOT re-validated**; the claim stands at its original version stamp.
- **(d) inspection** — answerable from app resources, the AX tree, or the scripting dictionary without a full drive.

---

## 2. The ledger

Verdict vocabulary: **STILL** = reproduces unchanged · **REFINED** = reproduces, with a measured boundary the entry did not have · **PARTIAL** = one half moved · **FIXED** = no longer reproduces · **MOOT** = the mechanism it rides is gone on 3.23 · **SUPERSEDED** = a 3.23 entry replaces it · **NOT RE-VALIDATED** = see the reason column.

### §1–§4 — the crash, the silent failures, the modals

| entry | class | verdict | evidence |
|---|---|---|---|
| **§1** URL `when=` on a repeating to-do CRASHES | a + b | **STILL — REFINED** | REPX2 §5 E1–E3; u-suite U12 / r-suite R09 green on golden-v4 (gv4-cert §1.7). ODDS1-E1/F2 add the boundary: `today`/`someday`/`anytime`/`evening`/bare `when=` each kill the app (2/2 runs each); `tomorrow`, `<ISO date>` and `<ISO date>@<time>` survive and silently re-anchor the template's spawn cursor. See §3.1 |
| **§2a** unknown `list=` → silent no-op | a | STILL | u-suite U06 green |
| **§2b** unknown tags silently dropped | a | STILL | u-suite U03/U04 green |
| **§2c** `heading=` never creates a heading | b | STILL | ODDS1-B5: `heading=<missing>` lands the row un-headed, creates no heading row; `heading=<existing>` heads it. Archived-match half: u-suite U21 green |
| **§2d** bare hours 1–11 am/pm heuristic | a | STILL | r-suite R01–R21 green (all 21 probes, gv4-cert §1.7) |
| **§2e** reminder CLEAR asymmetry | a + b | STILL | r-suite R07/R20/R21 green; REPX2 §6.1 F1c re-drove the RC01/RC02 bounce; ODDS1-A17 re-drove RC03 (AS move-to-Inbox: `start 2→0`, `startDate`/`reminderTime` → NULL) |
| **§2f** AS `move project … to list "Anytime"` no-op | a | STILL | p-suite P06/P09 green |
| **§2g** `update?completion-date=`/`creation-date=` ignored | b | STILL | ODDS1-A1: status/stopDate/creationDate/`umd` byte-identical across both writes; the `completed=true` control lands |
| **§2h** json date parser rejects fractional seconds / date-only | b | STILL | ODDS1-A2: `…18:00:00.000Z` → 0 rows; `…18:00:00Z` → 1 row, exact `creationDate`; `2025-01-15` → 0 rows. ODDS1-B1: the failure is still an error SHEET, not a crash |
| **§2i** `deadline=` on a repeating template silently dropped | a | STILL | REPX2 §5 E4 |
| **§3** URL project completion cascades silently | a | STILL (URL half) | u-suite U08 green. The UI-prompt contrast is a GUI observation, not re-observed |
| **§4a** error modals don't block execution | a + b | STILL | u-suite U13 green; ODDS1-B3: with the modal up, a URL `add` AND an AppleScript `make new to do` both land |
| **§4b** modal focus behavior differs by command class | b | **PARTIAL — the difference is GONE** | ODDS1-B2 + C2 (2 runs × 3 classes, Finder frontmost throughout): missing-token `update`, the unsupported `delete`, and a `json` payload error each raise a sheet with `frontmost = false`. On ≤3.22 the `json` and `delete` modals activated Things (U10/U14). **No command class steals focus on 3.23.** Invisible to the suite because all three already expected tier 3 |
| **§4c** modal scope (other windows stay interactive) | c | NOT RE-VALIDATED | needs two visible Things windows and a human eye |

### §5 — observations

| entry | class | verdict | evidence |
|---|---|---|---|
| **§5a** AppleEvents to a closed Things launch + steal focus | a | STILL | a-suite A40/A41 green |
| **§5b** open child reopens a resolved project | a | STILL | u-suite U19 green |
| **§5c** checklist replace-all; json preserves per-item state | a | STILL | u-suite U07/U20, p-suite P18 green |
| **§5d** `duplicate=true` on a template: no data, new windows | a | STILL | e-suite E13 green |
| **§5e** templates invisible to AS list reads | a | STILL | a-suite A12 green |
| **§5e** `things:///version` launches + foregrounds | a | STILL | u-suite U01 green (tier 2) |
| **§5f** `delete tag` destroys the subtree | a | STILL | p-suite P16 green |
| **§5g** removing a link: four behaviors | a | STILL | e-suite E19, p-suite P08/P10/P11/P21/P22/P24/P25/P26/P27/P28/P29 green |
| **§5h** "Enable Things URLs" OFF ≠ token cleared | b + c | **PARTIAL** | ODDS1-A18 confirms the split storage on 3.23: `TMSettings.uriSchemeAuthenticationToken` populated, `uriSchemeEnabled = 1` in the group-container plist. The **enable-modal** half (a write while disabled pops a Cancel/Enable prompt and holds the write) needs the Settings toggle driven — NOT re-validated |
| **§5i** no single-item permanent delete surface | b + c | **PARTIAL** | ODDS1-A3: on a trashed row, bare `delete to do id` → −1728 and the `list "Trash"` specifier form is a silent no-op (row survives) — unchanged. The Shortcuts `Delete Immediately` half is delete-class (no Always-Allow, `group:interactive`) — NOT re-validated |
| **§5j** Shortcuts consent asymmetry (no Always-Allow for delete) | c | NOT RE-VALIDATED | the dialog is the finding; needs a human sitting |
| **§5k** Shortcuts `Edit Items` reports success on a silent failure | b | **STILL — one arm CHANGED** | ODDS1-C8: `Completion Date = "2025-01-15"` still exits 0, echoes the item, and writes nothing (status 0, `stopDate` NULL). But `Reminder Time = "14:30"` (text) no longer no-ops — it **CLEARS** the reminder (`1006632960 → NULL`). Still a silent wrong outcome; now a destructive one |
| **§5l** `Edit Items → Parent` as text DETACHES | b | STILL | ODDS1-C8: exit 0, output echoes the to-do, `project` → NULL |
| **§5m** pending Automation dialog → −1712 asymmetry | c | NOT RE-VALIDATED | needs a live TCC prompt on a real host |
| **§5n** AS `delete` −1728 on a COMPLETED to-do | b | STILL | ODDS1-A3: `get name` returns the title, `delete` → −1728 (`trashed` stays 0), `move … to list "Trash"` succeeds, the OPEN control deletes fine |
| **§5o** open child into an ARCHIVED heading reopens it | a + b | STILL (core); addenda MOOT | u-suite U21 green; ODDS1-B7: archive a heading, `add?…&heading=<archived>` → heading `status 3→0`, `stopDate` NULL, child headed. The **HEADSORT / LOGSORT reorder-reopen addenda** ride the private reorder verb → MOOT on 3.23 (§12) |
| **§5p** AS `set completion date` FORCES completed | b | STILL | ODDS1-A4: OPEN `0→3` and CANCELED `2→3`, both stamped with the given date; the `set creation date` control is status-safe and `umd`-silent |
| **§5q** json completed PROJECT + open child lands OPEN | b | STILL | ODDS1-A5: open-child payload → `status 0`, `stopDate` NULL, backdated `creationDate` survives; the all-resolved control lands `status 3` with both dates |

### §6 / §7 — crashes, black holes, the catalog

| entry | class | verdict | evidence |
|---|---|---|---|
| **§6** AS `schedule` on a heading CRASHES | b | STILL | ODDS1-B14: `get name` returns "Beta", `schedule` → `Connection is invalid. (-609)`, pid 1682 → gone, fresh `.ips` `Things3-2026-07-05-120726.ips`, `EXC_BREAKPOINT` / `SIGTRAP`, `Trace/BPT trap: 5`; heading row unchanged after relaunch |
| **§6a** heading "canceled" stored as completed | b | STILL | ODDS1-B6: heading `status 0→3` with a `stopDate`; both open children `0→2` |
| **§6½** double-trashed to-dos vanish from every view | c | NOT RE-VALIDATED | the claim is about GUI views; needs a framebuffer sitting |
| **§6¾** completion modal ignores trashed children | c | NOT RE-VALIDATED | needs the GUI completion sheet and Put Back |
| **§6⅘** Empty Trash destroys a trashed project's LOGGED children | b | STILL | ODDS1-A20: project trashed shallow (3 children keep `trashed=0`, statuses 0/3/2), `empty trash` → all four rows gone, `TMTombstone` 0 → 0 |
| **§7 C1** URL `update?when=` on a repeating TO-DO | a + b | STILL — REFINED | see §1 |
| **§7 C2** URL `update-project?when=` on a repeating PROJECT | b | **STILL — WIDENED** | first re-measurement since 2026-07-09 (REPX2 deliberately skipped it). ODDS1-B15: `when=today` → pid 1784 gone, fresh `.ips`, `EXC_BREAKPOINT`/`SIGTRAP`, template byte-identical. ODDS1-D + E2: `when=someday` and `when=anytime` crash identically — **the spellings §8k recorded as silent no-ops on 3.22.11 are now crashes** |
| **§7 C3** AS `schedule` on a heading | b | STILL | = §6 |
| **§7 C4** Shortcuts Find Items malformed predicate | c | NOT RE-VALIDATED | needs a hand-authored/corrupted `.shortcut` asset installed in the guest (the SX5 surgery) |
| **§7 C5** stop-repeat then SELECT the demoted project | c | NOT RE-VALIDATED | needs the repeat-bar popover drive (uncertified on 3.23, RDLG2 §7.3) |
| **§7 F1** AS `move project … to area id <bad>` writes a report | b | **PARTIAL** | ODDS1-A15 + C1: the −1728 error reproduces exactly and the app survives — but **no DiagnosticReport is written** (`.ips` count unchanged across two independent runs). The "non-fatal fault" half does not reproduce on 3.23 |

### §8 — repeat-rule and scheduling model

| entry | class | verdict | evidence |
|---|---|---|---|
| **§8a** the template `deadline` COLUMN is the deadline-less discriminator | b + c | **PARTIAL** | RDLG2 §1.3: the `Add deadlines` / `Add reminders` checkboxes survive the 3.23 dialog redesign unchanged. ODDS1-C9: both golden templates read `deadline = NULL`, `t2_deadlineOffset = 0` — consistent with the deadline-less arm. The five-row discriminator matrix needs GUI-minted deadlined templates — not re-built |
| **§8b** a template's reminder can't be cleared in place | b + c | **PARTIAL** | ODDS1-A13/E3 re-confirm two of the three clear surfaces on 3.23: AS `move … to list "Inbox"/"Anytime"` → error 301, URL `when=` (keyword) → CRASH (§1). The Shortcuts arm was vacuous — the golden's template carries `reminderTime = NULL`. ODDS1-F2 adds a **SET** path the entry did not have: a dated `update?…&when=<date>@<time>` writes `reminderTime` onto the template, and a following bare dated `when=` does not clear it — so the no-CLEAR claim is untouched, but "no surface can touch it" would now be wrong |
| **§8c** `logInterval` has only THREE values | b | STILL | ODDS1-C7: the Settings ▸ General log-interval pop-up enumerates `Immediately · Daily · —— · Manually`. No weekly/monthly |
| **§8d** banner OK MATERIALIZES deadline-pulled rows | c | NOT RE-VALIDATED | the finding is the OK click; needs a framebuffer sitting |
| **§8e** no dismiss-deadline command; suppression is a reschedule side effect | b | STILL | ODDS1-B10: the Items menu carries `Deadline…` and nothing else deadline-related; `update?when=someday` on an overdue-deadline row stamps `deadlineSuppressionDate` (NULL → 132804736) |
| **§8f** the blue Someday project circle (not a bug) | c | NOT RE-VALIDATED | GUI colour |
| **§8g** repeat/convert are identity replacements; Stop lives on ONE surface | b | **PARTIALLY FIXED** | ODDS1-C4: with a repeating template selected, `Items ▸ Repeat` = `Edit Rule… · Show Previous Copy · Create Next Copy · Pause · Stop`. **The menu-parity oversight is FIXED — Stop is now on the Items menu**, no card popover required. The identity-replacement half was not re-probed here; REPX1 §5.4 measures `Stop` on 3.23 |
| **§8h** AX-tree surprises | b + a | STILL (structure) | ODDS1-C6/D7: `window 1` is still the hidden 40×40 `AXUnknown` beside the `AXStandardWindow`; `entire contents` still returns 0 on the custom views. The "list rows expose no title/actions" half is unchanged; REPX1 §1.2 already corrected the `AXPress` reading (decorative, not inert-by-design) |
| **§8i** sidebar/Tags drag writes a sparse index, renumbers the NEIGHBOUR | c | NOT RE-VALIDATED | drag rig |
| **§8j** project repeat surface + AX surprises | b | **PARTIAL — one bullet FALSIFIED** | ODDS1-D7 (with an attribute read-back): setting `AXEnhancedUserInterface = true` reads back `true` and the standard window still exposes 29 UI elements — **it no longer collapses the tree** on 3.23. The Stop-sheet "to-do" copy on a project, and the inert custom-popover bullets, need the repeat-bar drive — not re-validated |
| **§8k** project row-selection + template refusals | b | **CHANGED** | ODDS1-A13/D/E2: `update-project?id=<template>&when=anytime|someday` is **no longer a silent no-op — it CRASHES** (see §7 C2). The AppleScript half is unchanged: `move (to do id <template>) to list "Anytime"` → 301, `schedule` → 302. The AX row-selection bullets need the AX drive |
| **§8l** repeat-dialog control AX surprises | a | SUPERSEDED (in part) | the reminder-picker retraction stands. The dialog itself was re-censused on 3.23 by RDLG1/RDLG2 and the `Next:` control changed class — see [§11](../things-app-oddities.md) |
| **§8m** (RSIM-P2) project conversion flattens a nested repeater | c | NOT RE-VALIDATED | GUI conversion of a project subtree |
| **§8n** template children are status/schedule-immutable | c | NOT RE-VALIDATED | the golden's repeating PROJECT template has **no children** (ODDS1-A14), so the recipe has no fixture; needs a GUI-minted repeating project with a subtree |
| **§8o** Quick Find surfaces hidden-template content unmarked | c | NOT RE-VALIDATED | Quick Find is GUI-only |
| **§8p** fixed→after-completion reschedule preserves `ts`, resets offsets | c | NOT RE-VALIDATED | needs the repeat dialog driven twice; the dialog changed on 3.23 (§11) |
| **§8q** trashing an after-completion occurrence ADVANCES the series | c | NOT RE-VALIDATED | needs an after-completion series (GUI/ui-vector mint) |
| **§8r** "Show Latest" drops when a template has no instances | b | **SUPERSEDED — the law survives under a new name** | ODDS1-C4: `Show Latest` no longer exists on 3.23; the submenu carries `Show Previous Copy`. With every instance trashed and the Trash emptied the submenu becomes `Edit Rule… · Create Next Copy · Pause · Stop` — the copy-navigation item is **removed, not disabled**, exactly as §8r describes |
| **§8s** the Today banner is a pure MATERIALIZER | c | NOT RE-VALIDATED | the OK click is the finding. ODDS1-D5's AX census of the Today window found no banner element to actuate headlessly |
| **§8t** a container-trashed repeater keeps spawning into the Trash | c | NOT RE-VALIDATED | needs a repeating template inside a project (GUI mint) |
| **§8u** make-repeating defaults the first occurrence to TODAY | a | SUPERSEDED | the `Next:` field is a pop-up on 3.23 — [§11](../things-app-oddities.md) (RDLG2 §1.1) |
| **§8v** RETRACTED (`--ends-on` collapse was ours) | — | n/a | a retraction; nothing to re-validate |
| **§8m** (CONVINST) Convert to Project on an instance | c | NOT RE-VALIDATED | GUI `Items ▸ Convert to Project…` on a live instance |

### §9 — ordering, AX, and the late additions

| entry | class | verdict | evidence |
|---|---|---|---|
| **§9** sidebar AX mirror blanks after drag/scroll churn | c | NOT RE-VALIDATED | drag rig |
| **§9a** the in-project filter bar ignores tag inheritance | c | NOT RE-VALIDATED | GUI filter bar |
| **§9b** AS `set tag names` CREATES unknown tags; the URL DROPS them | b | STILL | ODDS1-A7: URL `tags=known,ghost` → 1 tag row, ghost tag not created; AS `set tag names` → 2 tag rows, ghost tag created |
| **§9c** `reorder … in list "Anytime"` strips `area` | b | **MOOT on 3.23** | the verb is accepted-and-inert (§12); o-suite O05/O10 lock a byte-empty delta. True as of 3.22.14 |
| **§9d** `- [x]` renders dimmed in notes | c | NOT RE-VALIDATED | render; needs screenshots |
| **§9e** resting templates share one drag-inert sub-bucket | c + moot | NOT RE-VALIDATED | the drag half needs a rig; the TMPLORD-b reorder half is MOOT (§12) |
| **§9f** `reorder … in area` DE-SOMEDAYS someday members | b | **MOOT on 3.23** | §12; o-suite O05/O10 |
| **§9g** `reorder … in list "Upcoming"` RE-DATES | b | **MOOT on 3.23** | §12; o-suite O20 and the UPCDL family |
| **§9h** the `when=` bounce direction depends on containment | a | STILL | o-suite O07/O08/O19/O21 green on their BASE expectation (gv4-cert §1.3 — deliberately not overridden) |
| **§9i** the json `when` update reindexes differently | a | STILL | o-suite O18 green on its base expectation |
| **§9j** two heading-DELETE surfaces disagree on the children | c | NOT RE-VALIDATED | the ellipsis `Delete` is GUI-only; the Shortcuts side is delete-class |
| **§9k** the container-day reorder rips a headed child's heading FK | b | **MOOT on 3.23** | §12; o-suite O06 locks the byte-empty delta |
| **§9l** a same-heading re-head is index-INERT | b | STILL | ODDS1-B8: four already-headed someday children re-headed in a scrambled order — `index` byte-identical (`-570 / -206 / -126 / 0` before and after) |
| **§9m** `reorder … in list id "later-projects"` re-dates someday projects | b | **MOOT on 3.23** | §12 |
| **§9n** stale evening flag / reminder bytes are never cleared; a reschedule clears a stale reminder | b | STILL (data half) | ODDS1-D2: after a 07-05 → 07-08 roll, the This-Evening row (`startBucket=1`, `startDate` 07-05) and the 18:00-reminder row are **byte-identical**. ODDS1-D3: rescheduling the stale row to 07-10 CLEARS `reminderTime`; a freshly-live reminder rescheduled to 07-11 KEEPS it. The GUI-hiding half needs a framebuffer |
| **§9o** a deadline-forecast someday row joins the `todayIndex` axis | b | STILL | ODDS1-A11: three someday rows with `deadline = 07-08` → `todayIndex` −585 / −1072 / −1651 (distinct, front-inserted), `todayIndexReferenceDate = deadline`, `startDate` NULL; the Inbox-with-deadline control rests at `todayIndex = 0` |
| **§9p** the hidden-list reorder verbs are blind writers | b | **MOOT on 3.23** | §12; o-suite O03/O17/O20 |
| **§9y** a Today drag across a cohort boundary falsifies the entry date | c | NOT RE-VALIDATED | GUI drag |
| **§9q** deadline-set `todayIndex` is write-vector-dependent; AS cannot CLEAR a deadline | b | STILL | ODDS1-A10: `set due date … to missing value` → −1700, deadline unchanged; URL `deadline=` (empty) clears it. The URL front-insert half is locked green by o-suite O31/O32 |
| **§9r** a native/GUI re-rank is `umd`-SILENT | c + moot | NOT RE-VALIDATED | the GUI-drag half needs a rig; the reorder half is MOOT (§12) |
| **§9s** a template's block `todayIndex` is writable via `list "Upcoming"` | b | **MOOT on 3.23** | §12; o-suite O36 |
| **§9t** a repeating PROJECT-template projection is drag-sortable / `list "Tomorrow"`-reachable | b | **MOOT on 3.23** (headless half) | §12; o-suite O37. The GUI-drag half needs a rig |
| **§9u** `list "Later Projects"` is an AppleScript-only list | b | STILL | ODDS1-B9: `things:///show?id=later-projects` still raises the sheet *"Things URL Scheme — Cannot show the list with ID "later-projects" because it does not exist."* while the AppleScript `reorder … in list "Later Projects"` specifier still RESOLVES (exit 0). The asymmetry stands; the reorder's *effect* is now inert (§12) |
| **§9v** GUI Anytime drag is secretly a reorder+REPARENT | c | NOT RE-VALIDATED | maintainer GUI observation; needs a drag rig |
| **§9w** `when=<ISO>@evening` discards the date and stamps a YEAR reminder | b | STILL | ODDS1-A8: `2026-07-06@evening` → `start=1 startBucket=1 startDate=today reminderTime=1369440256` (**20:26**); `2027-…` → `1370488832` (**20:27**); `tomorrow@evening` → dated tomorrow, no reminder, `sb=0`; `2026-07-06@20:00` → dated tomorrow + a 20:00 reminder |
| **§9x** an early-materialized instance is not rolled back | b | STILL | ODDS1-D1: +1 day → `icCount 3→4`, a 07-06 instance minted, cursor 07-06→07-07; rolling BACK to 07-05 leaves template and instances byte-identical (`umd` silent throughout) |
| **§9y** json checklist items must be an OBJECT array | b | STILL | ODDS1-A9: the bare string array creates 0 rows (whole payload discarded, no error); the object array creates the row with 2 checklist items |
| **§9z** reactivating a swept DATED to-do re-derives its `when` | b | STILL | ODDS1-D4 (rolled to 07-08): the 07-06-dated swept row reactivates `start 2→1` keeping `startDate` 07-06; the someday row with an overdue 07-06 deadline reactivates `start 2→1` with `startDate` **stamped** to 07-06 |
| **§9aa** deleting an area trashes OPEN members, DETACHES logged ones | b | STILL | ODDS1-A19: the open member → `trashed 0→1`, `area` NULL; the completed+swept member → `trashed` stays 0, `area` NULL, `userModificationDate` byte-identical |
| **§9bb** there is NO delete confirmation | b | **PARTIALLY FIXED** | ODDS1-C3: a **repeating TO-DO template** now raises a sheet — *"Are you sure you want to delete this repeating to-do and all future copies?"* `[Cancel] [Delete To-Do]` — and the row is NOT trashed until confirmed, so consequence (a) is fixed. A **plain to-do** and a **repeating instance** still trash instantly with `sheets = 0`, and ODDS1-F1 settles the project arm: a project with two open children, selected in an area view and deleted from `Edit ▸ Delete Project`, trashes with **zero sheets** — consequence (b) STILL STANDS |
| **§9cc** an open modal sheet blocks AS object-model mutations | b | **STILL — signature changed** | ODDS1-B12: with the `Edit Rule…` sheet up, `delete to do id <open row>` fails **−1728** and the row is not trashed; after Escape the identical call succeeds. On 3.22.14 the same call returned *without error* and silently no-op'd — on 3.23 the block is LOUD |
| **§9dd** `Items ▸ Repeat…` is selection- AND frontmost-dependent | c | NOT RE-VALIDATED | ODDS1-C5 could not establish the precondition: after `things:///show?id=<todo>` the AppleScript selection oracle came back EMPTY once Finder was activated, so both the backgrounded and the frontmost menu lacked `Repeat…` for the same reason (no selection). Selection-dependence is re-confirmed (ODDS1-C4: `Repeat…` present with a plain to-do selected and frontmost); frontmost-dependence needs the SESSGATE rig |
| **§9ee** the MONTHLY dialog snaps `Next:` to the anchor day | a | SUPERSEDED | the free `Next:` date field no longer exists on 3.23 — [§11](../things-app-oddities.md) |
| **§9ff** `make-repeating` on a future deadlined to-do DOUBLE-BOOKS | a | STILL (as a class) | REPX1 §3.3 / [§13](../things-app-oddities.md): the reconciliation defect is NOT fixed on 3.23 and is reachable from a bare re-date. The specific `make-repeating` precondition changed shape (RDLG2 §5.5) |
| **§339-addendum** a repeating project template refuses the URL container move | b | STILL | ODDS1-A13: `update-project?id=<template>&list-id=<area>` → zero delta, `area`/`start`/`umd` byte-identical |

### §10–§14 — the entries born on 3.23

| entry | class | verdict | evidence |
|---|---|---|---|
| **§10** at-locus create no longer schedules | a | STILL | a-suite A01B green under its 3.23 reconciliation (gv4-cert §1.7) |
| **§11** the `Next:` control became a pop-up | a | STILL | RDLG2 §1.1 / cells C8/C9 vs the ≤3.22 arm D5 |
| **§12** the private reorder verb is declared but inert | a | STILL | gv4-cert §1.1: 15 probes byte-empty; the o-suite now locks the inertness as a behavioral canary |
| **§13** re-dating an occurrence onto its next slot double-books | a | STILL | REPX1 §3.2/§3.3, REPX2 §1.2–§1.5 |
| **§14** projection CONTENT edits silently rewrite the template | a | STILL | REPX2 §3 |

---

## 3. What moved — the four changes a fresh report must carry

### 3.1 The `when=` crash SPLITS by spelling (§1 / §7 C1 / §7 C2 / §8k)

§1 says "the whole `when=` family is affected". On 3.23 that is measurably too broad, and the true boundary is a better bug report:

| spelling on a repeating TO-DO template | 3.23 result |
|---|---|
| `when=today` · `when=someday` · `when=anytime` · `when=evening` · `when=` (empty) | **CRASH** — `EXC_BREAKPOINT` / `SIGTRAP`, fresh `.ips`, row byte-identical (2/2 runs each) |
| `when=tomorrow` · `when=2026-07-09` · `when=2026-07-09@18:00` | **survives** — and writes something no caller asked for (below) |

The dividing line is not keyword-vs-date but **bucket-vs-calendar-date**: `tomorrow` is a keyword and survives, because the app's natural-language parser resolves it to a date (REPX2 §6.2). Everything that names a *bucket* — Today, This Evening, Anytime, Someday, and the empty clear — takes the unguarded branch.

**And the surviving branch is not inert.** ODDS1-F2 snapshotted the `rt1_*` columns the earlier cells did not:

```
baseline               start=2 sd=NULL rem=NULL   next=2026-07-06 icStart=2026-07-06 icCount=3
update?when=2026-07-09 start=2 sd=NULL rem=NULL   next=2026-07-09 icStart=2026-07-09 icCount=3
   …@18:00             start=2 sd=NULL rem=18:00  next=2026-07-09 icStart=2026-07-09 icCount=3
update?when=2026-07-10 start=2 sd=NULL rem=18:00  next=2026-07-10 icStart=2026-07-10 icCount=3
```

A dated `when=` on a template leaves `start`/`startDate` alone (which is why it reads as a no-op through the row's own schedule columns) but **re-anchors the series' spawn cursor**, and a `@<time>` component writes a rule-level `reminderTime` that a subsequent bare dated `when=` does not clear. Existing instances are untouched throughout and `rt1_instanceCreationCount` never moves. That is exactly what the app's own `Update Rule` chooser branch does behind a modal (REPX2 §1.4) — done here silently, from a URL, on the same command whose sibling spellings kill the process.

Provenance caution: the ≤3.22 behavior of the DATED spelling was never measured — §1's "whole family" wording is precisely why nobody tried it — so this is recorded as a 3.23 **measurement**, not as a 3.23 **change**.

The repeating PROJECT template behaves the same way, and this is where the second half of the finding sits: `update-project?when=anytime|someday` was recorded by UIC4 (3.22.11) as a **silent no-op** on a template's `start` bucket (§8k). On 3.23 both spellings **kill the app**. So a spelling that used to be merely ignored is now fatal — the guarded/unguarded split inside the URL handler moved in the *wrong* direction between builds.

Read together with §2i (`deadline=` on the same rows is silently and safely dropped) the report gets a crisp shape: **within one URL handler, on the same row class, one schedule-adjacent field is guarded, one schedule field is guarded-by-spelling, and the keyword branch is unguarded.**

Both crash families still have their AppleScript contrast intact on 3.23: `schedule to do id <template>` → `Cannot schedule to-do (302)`, `move (to do id <template>) to list "Anytime"` → `Cannot move to-do (301)`, zero delta, app alive.

### 3.2 No error modal steals focus any more (§4b)

Two runs each of the three command classes, Finder frontmost throughout, `frontmost` sampled at +2 s and +8 s: the missing-token `update`, the unsupported `delete` and a malformed `things:///json` payload all raise a sheet on the main window and **none activates Things**. The ≤3.22 asymmetry (add/update modals background, json/delete modals steal focus) is gone. The suites could not see this because U02/U05/U10/U14 all already expect tier 3, which subsumes the tier-2 focus steal.

### 3.3 Deleting a repeating template now asks (§9bb)

3.23 introduces exactly one delete confirmation, and it is the one §9bb argued for hardest:

```
Are you sure you want to delete this repeating to-do and all future copies?
[Cancel]  [Delete To-Do]
```

It fires for a repeating **to-do template** and holds the write (`trashed` stays 0 until confirmed). It does **not** fire for a plain to-do or for a repeating **instance** — both still trash instantly. So §9bb's consequence (a) ("deleting a template silently breaks the series with zero warning") is FIXED.

Consequence (b) **still stands**. ODDS1-F1 selected the project row in an area view (verified by `Edit ▸ Delete Project` appearing) and clicked that menu item: a project holding two open children was trashed with `sheets 0 → 0`, no prompt of any kind, children keeping `trashed = 0` under the shallow-delete law — byte-identical in shape to the empty-project control. A destructive, project-emptying action still has zero friction.

One methodological note for whoever re-runs this: ⌘⌫ actuates on a to-do content row but **not** on a project content row in this rig (ODDS1-E4: selection verified, no sheet, no trash). Driving `Edit ▸ Delete Project` as a menu click works. That is a synthetic-keystroke delivery artifact, not app behavior, and it is why the E pass read as inconclusive.

### 3.4 `AXEnhancedUserInterface` no longer collapses the tree (§8j)

With an explicit read-back (`value of attribute "AXEnhancedUserInterface"` → `true`), the standard window still exposes 29 UI elements and `entire contents` still returns 0. On 3.22.11 the same set drove `UI elements` to 0. The companion facts in the same entry — the hidden 40×40 `window 1`, and `entire contents` aborting on Things' custom views — are unchanged.

---

## 4. The ordering family: MOOT, not fixed

Eleven rows describe destructive side effects of `_private_experimental_ reorder to dos in …`. On 3.23 that command exits 0 and changes nothing (§12), so **none of them can be provoked on this build**: §9c, §9f, §9g, §9k, §9m, §9p, §9s, §9t (headless half), §9e (data half), §9r (reorder half), and the HEADSORT / LOGSORT addenda under §5o.

This is a reporting distinction that matters. "Fixed" would be wrong — Cultured Code did not repair the de-areaing, the re-dating or the heading-FK rip; they withdrew the implementation of the command that performed them while leaving it declared in the dictionary. For the report these entries should be presented as **true as of Things 3.22.14, unreachable on 3.23 because the command is inert**, with §12 (the declaration/implementation mismatch) carrying the live complaint.

---

## 5. Residue — what this campaign could not reach

Twenty-seven rows, each with the rig it needs:

| needs | entries |
|---|---|
| a framebuffer / HID drag rig | §8i, §9, §9e (drag half), §9r (drag half), §9t (drag half), §9v, §9y (Today drag) |
| a GUI view the headless clone cannot render or navigate | §4c, §6½, §6¾, §8f, §8o, §9a, §9d, §9j (ellipsis half) |
| a GUI-driven fixture we did not mint (after-completion series, repeating project with children, deadlined template, a repeater inside a project) | §8a (matrix half), §8b (Shortcuts arm), §8n, §8q, §8t, §8m (RSIM-P2), §8m (CONVINST), §8p |
| the repeat-bar popover reveal (uncertified on 3.23, RDLG2 §7.3) | §7 C5, §8j (Stop-copy + inert-popover bullets) |
| the Today banner's OK click | §8d, §8s |
| a Shortcuts delete-class consent sitting | §5i (Shortcuts half), §5j, §9j (Shortcuts half), §7 C4 |
| a live macOS Automation-consent dialog | §5m |
| the SESSGATE selection/Space rig | §9dd |
| the Settings enable/disable toggle | §5h (modal half) |

None of these is believed stale; each simply carries its original version stamp and says so in its appendix.

---

## 6. Standing state

- Six clones created and destroyed; `tart list` ends with the three goldens (v2, v3, v4) stopped and no `*-lab` VMs. Nineteen deliberate process deaths, all inside disposable clones; the host's production Things was never touched.
- No suite expectation, capability-matrix cell, assumption-register row or engine behavior was changed by this campaign. The entry that records a *widened* crash surface (§7 C2 / §8k) does not unblock anything — `H-REPEAT-SCHEDULE` already refuses the whole class, and it refuses the dated spelling too, which is the correct call given what that spelling silently does to the cursor.
- **Nothing here is a FIXED-unlock.** The four movements are a lost focus-steal, an added confirmation sheet, a menu-parity repair and an AX attribute that stopped collapsing the tree — none of them re-opens a capability we refuse. The one *capability-shaped* discovery is the opposite of an unlock: the dated `when=` cursor re-anchor (§3.1) is an undocumented private-ish write with no user-visible signal, and it is queued as a probe rather than a feature.
- Follow-ups filed in [up-next](../up-next.md): the dated-`when=` cursor re-anchor probe, and the §8k spelling change (a silent no-op that became a crash earns its own line in the Cultured Code report).
