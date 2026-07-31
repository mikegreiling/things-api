# SIT3 — arrival / evening / lists: five probe arms (EVEPROJ · BANNERACK · REMSTALE · LATERLINK · SPECLIST)

Probe sitting 3 closes five residual questions around **This-Evening for PROJECTS**, **replicating the Today-banner OK headlessly**, the **stale evening/reminder gating law**, and the **`show` / `list` id vocabularies**.

ONE disposable Tart clone (`sit3-lab`, run 2026-07-31, **Things 3.22.11**, **macOS 15.7.7** Sequoia, **DB schema v26**, golden `things-lab-golden-v1` UNTOUCHED; airgapped, no cloud account). Pinned clock **2026-07-05 12:00**, rolled forward **+1 → 2026-07-06** and **+1 → 2026-07-07** with the app CLOSED (RSIM-S small-increment law; clock-rolls in the VM ONLY, never the host). Writes go exclusively through official surfaces (URL scheme + AppleScript `_private_experimental_` reorder). Ground truth = guest read-only SQLite reads (raw bytes + decoded) + the AppleScript list oracle + VNC screenshots (the banner, pips, reminder badge and This-Evening section are custom NSViews, invisible to the AX tree — BANNER1 oracle-limits). Fixtures **fully synthetic** (`S3-*`). Script: [`lab/scripts/research-sit3.sh`](../../lab/scripts/research-sit3.sh) (subcommands `setup` + verbs `url`/`as`/`aslist`/`full`/`rows`/`sql`/`clock`/`relaunch`/`shot`/`click`/`key`/`dbdump`/`teardown`). Date codec is the library's (`y<<16|m<<12|d<<7`; reminderTime `hour<<26|minute<<20`) — **no hand-packed integers**: `07-05`=132805248, `07-06`=132805376, `07-07`=132805504, `07-10`=132805888; reminder `18:00`=1207959552. Evidence (gitignored): `lab/artifacts/sit3-lab/` (`snaps/*.png`, `report.txt`, `final-evidence.txt`, `dumps/sit3-final.dump`).

**Status: RAN + BANKED. Evidence only — NO wiring, no CHANGELOG.**

## Verdict table

| Arm | Question | Verdict |
|---|---|---|
| **EVEPROJ** | Is This-Evening wireable for PROJECT movees via `project.update` legs? | **YES.** `things:///update-project?id=<u>&when=evening` sets a project to This-Evening in a **single leg** (`startBucket=1`, `startDate=today`, `start=1`, `type=1` preserved) — for area-less AND area'd projects (area FK preserved). The two-leg bounce (`when=today`→`when=evening`) works and preserves every FK/schedule byte. **Two caveats (both shared conceptually with to-dos):** (1) a project's `when=today` leg does **NOT** front-insert to the global Today minimum the way a to-do's does (project landed mid-pack; a control to-do reached global-min); (2) a native `list "Today"` reorder **DE-EVENS** the project (O03 generalizes to projects). |
| **BANNERACK** | Is a quiet `things today ok` batch op wireable byte-faithfully via the URL scheme? | **NO — unmatchable.** The banner OK performs an **in-place `start 2→1`** (and `startDate:=deadline` for pulls) that no URL `when=` leg reproduces: `when=today` is a **complete no-op** on an already-today provisional row (arrived or deadline-pulled), and the only leg that flips `start 2→1` (`when=anytime`) **destroys `startDate`** (yanks the row out of Today). Worse, **OK does NOT bump `userModificationDate`** (byte-identical across the click) whereas every URL `when=` write **does** bump it — so even a schedule-column match would be byte-unfaithful. |
| **REMSTALE** | The exact stale evening/reminder gating law. | **The `startBucket=1` (This-Evening) flag AND the `reminderTime` render only while `startDate == current day`.** The day `startDate` goes stale (`< today`, or NULL for a pull) the GUI **discards both at the presentation layer** — the row collapses to plain "Today" (day section, no This-Evening section, no reminder badge/popover) — while the DB bytes are **NEVER cleared**: not by day-rollover/arrival, not by the banner OK. The app IGNORES the stale bytes; it does not clean them. Generalizes to **to-do AND project**. Maintainer-observed popover end-state cited. |
| **LATERLINK** | Is `things:///show?id=later-projects` valid? `show?id=tomorrow`? | **`later-projects` = INVALID** (error modal "Cannot show the list with ID 'later-projects' because it does not exist"; view unchanged). **`tomorrow` = VALID** (opens the Tomorrow view in the main pane). So the **`show`-URL id vocabulary ≠ the AppleScript `list id` vocabulary**: `later-projects` is a valid `list id` specifier (P9a) but not a valid `show` id; `tomorrow` is valid in both. |
| **SPECLIST** | Is the P9a `every list` enumeration closed? | **CLOSED.** `every list` = Inbox, Today, Tomorrow, Anytime, Upcoming, Someday, Later Projects, Logbook, Trash + areas (verbatim, unchanged). Every speculative door — `This Evening`, `Next Week`, `Deadlines`, `Day After Tomorrow`, `list id "evening"`, `list id "deadlines"`, and date-shaped (`March 16`, `2026-08-15`) — errors **−1728** for BOTH the `get` and the `_private_experimental_ reorder` specifier (identical resolution). |

---

## ARM 1 — EVEPROJ: project This-Evening mechanics

**Seeds (clock 07-05):** `S3-EP-A` (area-less project, `add-project`), `S3-EP-B` (area'd, `add-project?…&area=LAB-AREA-A`), `S3-TD-1` (control to-do). Both projects created as `type=1, start=1, startBucket=0, startDate NULL`.

### (a) The `update-project?when=evening` spelling WORKS in one leg

`things:///update-project?id=6akY…&when=evening` on the area-less project:

| col | before | after |
|---|---|---|
| type | 1 | 1 |
| start | 1 | 1 |
| startBucket | 0 | **1** |
| startDate | NULL | **132805248 (07-05)** |
| index | −537 | −537 (kept) |

The project renders under the **This Evening** section (moon-icon) of Today as a project row (`snaps/01a-eveproj-today.png`). So the spelling is not merely tolerated — it materializes the maintainer-observed "projects CAN be This-Evening" shape (`startBucket=1, type=1`) in a **single dispatch**, unlike the to-do evening BOUNCE which corpus documents as a two-leg (`when=today`→`when=evening`) sequence. Confirmed for the area'd project too: `S3-EP-B` flagged evening kept `area=7Ck4hAXU…` (LAB-AREA-A) — an **area'd project can be This-Evening and retains its area FK**.

### (b) The two-leg bounce preserves all state; placement diverges from to-dos

Bounce = `update-project?when=today` then `update-project?when=evening`.

| row | leg | start | startBucket | todayIndex | index | area | startDate |
|---|---|---|---|---|---|---|---|
| S3-EP-A | when=today | 1 | 1→**0** | 0→**−407** | −537 | — | 07-05 (kept) |
| S3-EP-A | when=evening | 1 | 0→**1** | −407→**154** | −537 | — | 07-05 (kept) |
| S3-EP-B (area'd) | when=today | 1 | 1→**0** | 0→**−603** | −1103 | **7Ck4hAXU (kept)** | 07-05 (kept) |
| S3-EP-B (area'd) | when=evening | 1 | 0→**1** | −603→**−95** | −1103 | **7Ck4hAXU (kept)** | 07-05 (kept) |

Every leg preserves `start`, `startDate`, `index`, the **area FK**, `deadline` (NULL) and `reminderTime` (NULL). The bounce is state-preserving.

**Placement divergence (the `todayIndex` law is NOT a global front-insert for projects).** The control to-do `S3-TD-1`, bounced identically, front-inserted to the **global Today minimum**: its `when=today` leg wrote `todayIndex = −744`, strictly below the pre-existing global min (−619, `LAB-TODAY-1`). The two projects' `when=today` legs wrote −407 and −603 — both **above** the −619 global min (mid-pack). So a to-do's `when=today` reaches the top-of-Today front, but a project's does not; project placement is a computed sub-min position, deterministic but not the clean most-negative front-insert. In the evening bucket the bounced rows landed below the pre-existing evening member (`LAB-EVENING-1` −229 < S3-EP-B −95 < S3-EP-A 154), i.e. back-of-bucket for both types.

### (c) O03 analog — a native `list "Today"` reorder DE-EVENS project rows

`to dos of list "Today"` returns **11 ids including both project uuids** (O12 analog: `project` inherits from `to do` in the sdef). One `_private_experimental_ reorder to dos in list "Today" with ids "<scrambled, both projects at front>"`:

| row | type | startBucket before→after | todayIndex before→after |
|---|---|---|---|
| S3-EP-A | 1 (project) | 1 → **0** | 154 → −5315 |
| S3-EP-B | 1 (project) | 1 → **0** | −95 → −4694 |
| S3-TD-1 | 0 | 1 → **0** | −176 → −4207 |
| LAB-EVENING-1 | 0 | **1 → 1 (kept)** | −229 → −3692 |

The reorder re-ranked `todayIndex` to the sent order AND **de-eveninged the project rows** (`startBucket 1→0`) exactly as O03 found for to-dos — so **O03 generalizes to projects**. (It also materialized the day's provisional rows, `start 2→1`, like a banner OK side effect.) The lone survivor `LAB-EVENING-1` kept `startBucket=1` because its `startDate` is **stale** (07-03, not the current day) — a direct hint of the REMSTALE gating: the de-evening applies to evening rows whose `startDate == today`, not to already-collapsed stale ones.

### (d) Verdict

The evening scope is **wireable for project movees via `project.update` legs**: `update-project?when=evening` reliably sets This-Evening single-leg, preserving `type=1`, the area FK, `index`, `deadline` and `reminderTime`; the bounce preserves all state. The two caveats (project `when=today` does not global-front-insert; a native Today reorder de-evens the project) are the same fragilities a to-do evening flag already carries, so they do not block wiring. **Evidence only — NOT wired.**

---

## ARM 2 — BANNERACK: replicating the banner OK headlessly

Extends **BANNER1** (the Today-banner + pip law: a Today member is provisional/pip'd ⟺ `start != 1 OR startDate IS NULL`; OK materializes `start:=1`, `startDate:=deadline` where NULL, touching only member rows, no other table). BANNERACK asks whether that OK can be reproduced **byte-faithfully** by the URL scheme, and pins the `userModificationDate` collateral.

### (a) Manufacturing provisional rows — the two direct URL shortcuts FAIL

Two provisional classes were needed; both required the **clock-roll** manufacture, because the naive direct-URL constructions do not produce a provisional row:

- **Scheduled-past** `add?when=2026-07-04` (a past ISO): the app **CLAMPS to today and materializes** — `start=1, startDate=07-05, startBucket=0` (a plain Today row, no pip). Not provisional.
- **Someday + past-deadline** `add?when=someday&deadline=2026-07-03`: the app **auto-sets `deadlineSuppressionDate := deadline`** (both 07-03) — the pull is suppressed, so the row never enters Today. Not provisional.

So genuine provisionals were seeded FUTURE at 07-05 and rolled into: `S3-BK2-ARR-{URL,OK}` = `add?when=2026-07-07` (arrives), `S3-BK2-PULL-{URL,OK}` = `add?when=someday&deadline=2026-07-07` (future deadline → NOT suppressed → pulls). After the roll to 07-07 all four are provisional (`start=2`; ARR `startDate=07-07`, PULL `startDate NULL, deadline 07-07 due`), banner read "**5 new**" (my 2 OK-rows + 3 golden entrants), pips confirmed on-screen.

### (b) GUI oracle — the exact OK delta (byte-for-byte, incl. `userModificationDate`)

Clicked the banner OK via VNC HID (the button is not in the AX tree — BANNER1). The **OK-pair** (never touched by URL) before → after:

| row | class | start | startDate | startBucket | todayIndex | deadline | **userModificationDate** |
|---|---|---|---|---|---|---|---|
| S3-BK2-ARR-OK | scheduled arrival | 2 → **1** | 07-07 → 07-07 (kept) | 0 (kept) | −415 (kept) | — | **1783253642.13555 → 1783253642.13555 (BYTE-IDENTICAL)** |
| S3-BK2-PULL-OK | deadline-pull | 2 → **1** | NULL → **132805504 (07-07 = deadline)** | 0 (kept) | 132805504 (kept) | 132805504 (kept) | **1783253646.70426 → 1783253646.70426 (BYTE-IDENTICAL)** |

This reproduces **BANNER1 L4** on a fresh class set (OK writes only `start→1` and `startDate:=deadline` where NULL, nothing else) and **adds a new fact: OK does NOT bump `userModificationDate`.** Both rows' `umd` are byte-identical across the click — the banner materialization is a "quiet" write that leaves the modification timestamp untouched.

### (c) The pure-URL reproduction — UNMATCHABLE

Applied to the parallel **URL-pair** (so the OK oracle above stays clean):

- **Arrived** `S3-BK2-ARR-URL` (`start=2, startDate=07-07`): `update?…&when=today` → **complete NO-OP** (`start` stays 2, `startDate` unchanged, `umd` **byte-identical** — zero writes). `update?…&when=anytime` → `start 2→1` **but `startDate 07-07 → NULL`** (row leaves Today) and `umd` **bumped**. Neither reproduces OK's "`start 2→1`, keep `startDate=today`".
- **Deadline-pull** `S3-BK2-PULL-URL` (`start=2, startDate NULL, deadline 07-07 due`): `update?…&when=today` and `when=2026-07-07` (= the deadline) → **NO-OP** (`start=2, startDate NULL, umd` byte-identical). A control `update?…&when=2026-07-10` (a FUTURE date) **DID apply** (`startDate → 07-10, umd` bumped), proving `when=` is functional but `when=<today-or-past>` short-circuits on a due-deadline overlay row. No leg yields OK's `start=1, startDate=deadline, in-Today`.

**Collateral confirmed:** a URL `when=` write **bumps `userModificationDate`** (observed on both the ARR `when=anytime` and PULL `when=07-10` legs) where the banner OK **does not**. So a URL reproduction is detectable at the byte level (the modification timestamp diverges and syncs) even in the unreachable case where the schedule columns matched.

### (d) Verdict

A quiet `things today ok` batch op is **NOT wireable byte-faithfully** via the URL scheme. The OK acknowledgement is a **GUI-only in-place materialization**: `when=today` no-ops on provisional rows, `when=anytime` destroys the today-schedule, and every URL `when=` write bumps `userModificationDate` where OK leaves it byte-identical. The exact byte differences of any approximate URL attempt: it would (a) fail to flip `start 2→1` without also nulling `startDate` (arrived) or leaving the pull unmaterialized (deadline-pull), and (b) bump `userModificationDate`. **Evidence only — NOT wired.**

---

## ARM 3 — REMSTALE: the stale evening/reminder gating law

From a live prod repro (a project with `startBucket=1` + `reminderTime=18:00` + `startDate` ~3 weeks past that renders with no evening placement and no reminder). REMSTALE pins the gating boundary and whether the bytes are ever cleared.

### Seeds and a manufacture finding — the URL cannot co-express `startBucket=1 + reminderTime`

Seeded at 07-05: `S3-RS-TDE` (to-do This-Evening, `sb=1, startDate 07-05`, no reminder), `S3-RS-PRJE` (project This-Evening, `sb=1, startDate 07-05`), `S3-RS-TDR` (to-do reminder `18:00`, `sb=0, startDate 07-05, reminderTime=1207959552`).

**Finding: `update?…&when=evening` CLEARS `reminderTime`.** A row created via `add?when=2026-07-05@18:00` (`sb=0, reminderTime=1207959552`) then `update?when=evening` came back `sb=1` **and `reminderTime = NULL`**. So the URL scheme cannot hold `startBucket=1` and `reminderTime` simultaneously through these legs — the exact prod byte-shape is a GUI/sync-origin combination. The two elements were therefore tested on **separate** rows (evening on TDE/PRJE, reminder on TDR); the combined-row popover end-state is the maintainer oracle below.

### The boundary — pinned at exactly `startDate == current day`

| clock | S3-RS-TDR reminder badge | evening rows (TDE/PRJE) render | DB bytes |
|---|---|---|---|
| **07-05** (`startDate == today`) | **shown** (🔔 bell, `snaps/03-remstale-0705.png`) | in the **This Evening** section | `sb=1`/`reminderTime` set |
| **07-06** (1-day stale) | **GONE** (`snaps/03-remstale-0706*.png`) | collapse to the plain **Today day section** (no This-Evening section) | `sb=1`/`reminderTime` **UNCHANGED** |
| **07-07** (2-day stale) | GONE | plain Today day section | `sb=1`/`reminderTime` **UNCHANGED** |

The transition happens on the FIRST day `startDate` is no longer the current day. Direct in-frame corroboration: the golden's own `LAB-EVENING-1` (`sb=1`, `startDate` 07-03 — stale from seed) renders as a **plain row in the Today day section**, never in a This-Evening section — the same collapse, independently.

### Arrival and acknowledgement NEVER clear the bytes

At 07-06 and 07-07 the REMSTALE rows' `startBucket=1` and `reminderTime=1207959552` are **byte-identical** to their 07-05 values — day-rollover/arrival does not touch them. Clicking the banner **OK** at 07-07 also left them untouched (`sb=1`, `reminderTime` intact, `userModificationDate` unchanged — OK never touched these rows, they are already `start=1` and thus non-provisional per BANNER1 L1). So the GUI **only ignores** the stale bytes at the presentation layer; nothing in the app cleans them. Both to-do (`S3-RS-TDE`, `S3-RS-TDR`) and project (`S3-RS-PRJE`) generalize — all three stay Today members and collapse identically.

### Maintainer oracle (2026-07-31, cited as oracle-grade for the popover end-state)

For the live prod repro row (`type=1` project, `startBucket=1`, `reminderTime` 18:00-packed, `startDate` ~3 weeks past), the GUI **When popover shows simply "Today"** — no This-Evening state, no reminder row at all — while the bytes remain in the DB. This matches the VM's row-level render (badge gone, collapsed to Today) and extends it to the popover surface.

### Verdict — the gating law

**The This-Evening flag (`startBucket=1`) and the `reminderTime` apply GUI-side only while `startDate == current day`.** Once `startDate` is stale (`< today`, or NULL for a deadline-pull), the app presents the row as a plain "Today" member and hides both — but never writes the bytes away (not on arrival, not on banner OK). Precise enough to gate a GUI-faithful reader in a follow-up: **when deriving `when`/evening, suppress `startBucket=1` (present as plain Today) and suppress `reminderTime` emission whenever `startDate != today`** (including `startDate IS NULL`), mirroring the app. Filed as a new oddity ([things-app-oddities.md](../things-app-oddities.md) §9n). **Evidence only — NOT wired.**

---

## ARM 4 — LATERLINK: `show?id=` validity for `later-projects` and `tomorrow`

- **`things:///show?id=later-projects`** → **error modal** "Things URL Scheme — Cannot show the list with ID 'later-projects' because it does not exist." (`snaps/04-later-projects.png`). The view is unchanged (stays on the prior list). **INVALID show id.**
- **`things:///show?id=tomorrow`** → **VALID**: opens the **Tomorrow** view in the main pane (calendar icon, title "Tomorrow", listing tomorrow's scheduled items; `snaps/04-tomorrow.png`).

**The `show`-URL id vocabulary is NOT the same set as the AppleScript `list id` vocabulary.** Both `list id "later-projects"` and `list id "tomorrow"` are valid AppleScript specifiers (P9a), but only `tomorrow` is accepted as a `show` id — `later-projects` is rejected. So a reader/driver must not assume a `list id` is show-navigable. **Evidence only.**

## ARM 5 — SPECLIST: `every list` re-enumeration + speculative doors

`get name of every list` (verbatim, Things 3.22.11): **Inbox, Today, Tomorrow, Anytime, Upcoming, Someday, Later Projects, Logbook, Trash, LAB-AREA-B, LAB-AREA-A** — the P9a set unchanged (built-ins + areas).

Speculative specifiers via `count of (to dos of list …)`:

| specifier | error |
|---|---|
| `list "This Evening"` | −1728 |
| `list "Next Week"` | −1728 |
| `list "Deadlines"` | −1728 |
| `list "Day After Tomorrow"` | −1728 |
| `list "March 16"` | −1728 |
| `list "2026-08-15"` | −1728 |
| `list id "evening"` | −1728 |
| `list id "deadlines"` | −1728 |

The `_private_experimental_ reorder to dos in list …` specifier resolves identically: `list "This Evening"` → −1728, `list id "deadlines"` → −1728, while the valid `list "Tomorrow"` (bad id string) → no error (tolerated). So `get` and `reorder` share one list-object resolver; there is no hidden reachable list beyond `every list`. **The P9a enumeration is CLOSED.** (Reconfirms the date-shaped-specifier −1728 corpus fact.)

## App oddities filed

- **New oddity §9m — a This-Evening flag (`startBucket=1`) and a `reminderTime` are hidden by the GUI once `startDate` is stale, but the bytes are never cleared.** The evening bucket placement and the reminder render only while `startDate == current day`; the day it goes stale the row collapses to plain "Today" (no This-Evening section, no reminder badge/popover) with `startBucket`/`reminderTime` left intact in the DB — and neither day-rollover nor the banner OK ever clears them. A read model keyed on the raw columns would over-report evening/reminders; it must gate both on `startDate == today`. Evidence: this doc, REMSTALE.
- **Note (not filed as a bug) — the `show`-URL id set ≠ the AppleScript `list id` set:** `show?id=later-projects` errors ("does not exist") though `list id "later-projects"` is a valid P9a specifier; `show?id=tomorrow` works. Recorded here (LATERLINK) and in the capability matrix.
- **Note — `update?…&when=evening` CLEARS `reminderTime`** (REMSTALE manufacture): the URL scheme cannot co-express `startBucket=1 + reminderTime` via `when=` legs; that combination is GUI/sync-origin only.

## Reproduce

```sh
VNCDO=<vncdotool> TART_HOME=/Volumes/Workspace/tart \
  bash lab/scripts/research-sit3.sh setup            # clone+boot(--vnc-experimental)+airgap+pin 07-05+helpers, leaves VM up
# then drive the arms with verbs, e.g.:
  bash lab/scripts/research-sit3.sh url 'things:///update-project?id=<u>&when=evening'   # EVEPROJ
  bash lab/scripts/research-sit3.sh as  'tell application "Things3" to get name of every list'  # SPECLIST
  bash lab/scripts/research-sit3.sh relaunch 070712002026   # REMSTALE / BANNERACK clock roll to 07-07
  bash lab/scripts/research-sit3.sh shot <name>  ;  bash lab/scripts/research-sit3.sh click <x> <y>  # banner OK
  bash lab/scripts/research-sit3.sh teardown
```

No Accessibility grant is needed (AppleEvents is an image default; the banner OK is clicked via VNC HID, screenshots come from the VNC framebuffer). Fixtures are synthetic `S3-*`; the prod REMSTALE repro is described from the maintainer's observation, never copied.
