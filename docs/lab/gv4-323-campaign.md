# GV4 — minting golden-v4 (Things 3.23) and the first regression sweep

**Version stamp:** `things-lab-golden-v4` · Things **3.23** (CFBundleVersion **32300036**, direct-download channel; the maintainer's host is MAS **32300536**) · macOS **15.7.7 (24G720)** · `Meta.databaseVersion` **27** · guest clock pinned **2026-07-05 12:00** · derived by APFS COW from `things-lab-golden-v3` (Things 3.22.14 / DB 26). Campaign run 2026-08-22, unattended. Immutable snapshot per the [harness](harness.md) version-stamping policy.

Companion evidence: [rdlg1-323-repeat-dialog-census.md](rdlg1-323-repeat-dialog-census.md) (the AX census of the redesigned repeat surface). Golden record: [golden-v4-metadata.json](golden-v4-metadata.json).

**Nothing here is reconciled.** No suite expectation, assumption-register row, capability-matrix cell or oddities entry was edited by this campaign; every delta below is reported as observed and left for the maintainer.

---

## 1. How golden-v4 was built — and why not from L0

The brief called for `golden-build.sh v4` against a fresh Cirrus base so the 15-day trial clock restarts (DRIFT-1). That path was **measured as impossible on this host and abandoned deliberately**:

- `ghcr.io/cirruslabs/macos-sequoia-vanilla:latest` is **23.71 GB** of compressed OCI layers (96 layers, read from the registry manifest) and nothing is cached — `TART_HOME/cache` was empty. Pull + materialize peaks near **49 GB**; the volume had **31 GB** free. The pull alone would have left the volume under the runner's own `MIN_FREE_GB = 10` preflight floor, i.e. it would have broken Leg 3 even if it fit.
- A from-L0 golden carries **none** of the human-seeded layers — L2 settings + URL auth token, the L3-accessibility (AXVM1) grant, the six L5 Shortcuts proxies (which Apple offers no programmatic import for), the L6 seed dataset. Both the regression sweep and the AX census require all four.
- The trial-clock concern is moot in practice: clones pin the guest clock to the golden's `pinnedDate`, and `firstAppLaunchDate` was re-read **after** the 3.23 swap and is unchanged (`2026-07-03 03:14:28 +0000`), leaving **13 days** of margin at the pin. `lab:regress`'s own trial preflight passes.

So golden-v4 was minted by the **drift-runbook DRIFT-1 in-place path** — the same recipe that produced v2 and v3 — now scripted as [`lab/scripts/golden-inplace-swap.sh`](../../lab/scripts/golden-inplace-swap.sh):

1. `tart clone things-lab-golden-v3 things-lab-golden-v4` (APFS COW).
2. Boot, delete the default route (airgap verified by a failed ping), pin the clock to 2026-07-05 **before Things is ever launched**.
3. Copy out the pre-swap DB (databaseVersion 26) for the migration diff.
4. `rm -rf /Applications/Things3.app` then `ditto -xk` + `mv` the pristine 3.23 zip into place — **unlink before install**, never an in-place overwrite (the kernel caches code signatures per vnode; #515).
5. One warm-up launch; the DB migration runs; poll `Meta.databaseVersion` until stable; quit cleanly.
6. Copy out the post-swap DB, truncate `events.ndjson`, re-verify every inherited layer, `tart stop`.

### 1.1 Structural gates

| Gate | Result |
|---|---|
| `CFBundleShortVersionString` / `CFBundleVersion` | 3.22.14 / 32214000 → **3.23 / 32300036** |
| `LSMinimumSystemVersion` | 10.15.0 → **13.3** (3.23 drops pre-Ventura macOS) |
| Code signature | `Developer ID Application: Cultured Code GmbH & Co. KG (JLMPQHK86H)`, notarized, `spctl -a -vv` = **accepted** |
| `Things.sdef` sha256 | `1b6752334207f68cdcb7e71dfc34a21407095bd239afe5df6b3cdd8e2c70cde0` — **byte-identical** to 3.22.11/.12/.14. Zero dictionary delta; `_private_experimental_` still declared (7 hits). |
| `Meta.databaseVersion` | **26 → 27**, migrated live by the warm-up launch |
| Schema fingerprint | `sha256:784bd2f6…d4c52b` **unchanged** across the migration (measured on both the pre- and post-swap DB copies with `observeSchema()`) — the existing `src/db/baselines/db-v27.ts` covers this golden |
| Trial clock | `firstAppLaunchDate = 2026-07-03 03:14:28 +0000`, **not reset** by the in-place update |
| Inherited layers | disruption-monitor LaunchAgent `state = running`; all six `things-proxy-*` shortcuts present; `kTCCServiceAppleEvents` / `SystemPolicyAllFiles` / `Accessibility` / `ScreenCapture` all `auth_value = 2`; `TMSettings` intact (`groupTodayByParent=0`, auth token present) |

One signature curiosity worth knowing: the 3.23 bundle's signing timestamp is **2026-08-21 20:20:50**, *later* than the golden's pinned clock, so `codesign -dv` prints `postdated timestamp or bad system clock`. Gatekeeper still accepts and the app launches; harmless, but it will show up in every future pinned-clock golden.

### 1.2 A surprise during the build

The **first** boot of the v4 clone reached DHCP and ARP but never opened port 22 — 22 minutes, `com.apple.Virtualization.VirtualMachine.xpc` idling at ~3% CPU, every port closed. A `tart stop` + plain restart brought sshd up in **8 seconds**. Cause unknown (a stale `control.sock` in the source golden's directory is the only anomaly noted; tart logged `Failed to run control socket: Address already in use`). Treat a silent first boot as a flake and simply restart the VM.

The wait itself was made much worse by a real bug in the lab harness, now fixed in this branch: `lab_wait_for_ssh` counted **iterations**, not wall-clock, and each iteration could burn 30 s inside `lab_ssh`'s retry loop — so a nominal 300 s timeout was really ~55 minutes. It now uses a wall-clock deadline and a cheap `nc -z` TCP probe before attempting SSH.

---

## 2. The DBV27 migration, re-measured in the lab (and a correction)

[dbv27-migration-diff.md](dbv27-migration-diff.md) measured the 26→27 migration on the maintainer's production library. Running it again inside the golden — 37 fully synthetic `TMTask` rows, pre/post copies taken either side of the warm-up launch — reproduces the DDL exactly and **refines two of the three data findings**.

**DDL — identical to the host measurement, index-only:**

```
ADDED   index index_TMTask_id_where_recurrenceRuleNotNull
          ON TMTask (uuid) WHERE rt1_recurrenceRule IS NOT NULL
ADDED   index index_TMTask_repeatingTemplate_and_creationDate
          ON TMTask (rt1_repeatingTemplate, creationDate)
REMOVED index index_TMTask_repeatingTemplate ON TMTask (rt1_repeatingTemplate)
```
Zero table / column / trigger delta; 0 rows inserted or deleted; every other table's row count unchanged.

**Data — what actually moved (37 rows):**

| column | rows changed | transition |
|---|---|---|
| `rt1_nextInstanceStartDate` | 35 | the sentinel `69760` → **NULL**, on every **non-template** row |
| `untrashedLeafActionsCount`, `openUntrashedLeafActionsCount` | 28 | `-1` → `0`, every changed row `type = 0` |
| `checklistItemsCount`, `openChecklistItemsCount` | 9 | `-1` → `0`, on `type = 1` (7) and `type = 2` (2) |
| `rt1_instanceCreationStartDate` | **0** | untouched |
| everything else | 0 | — |

### 2.1 Correction 1 — `rt1_nextInstanceStartDate` is NOT retired, and the migration did not break the projection day

DBV27 reads the host numbers as "the per-row next-instance cache is **RETIRED**", and up-next escalates that into engine break (0): *the TMPLSORT/PTMPL projection day has lost its input.*

The lab says otherwise. Before the migration **all 37 rows** carried a value; 35 of them carried the same sentinel `69760`, and the two repeating templates carried real packed dates (`132805376`, `132806144`). After the migration:

- the 35 sentinel rows are **NULL**;
- **both templates kept their exact values, byte-identical**;
- the set of rows retaining a value is **exactly** the set of rows with `rt1_recurrenceRule IS NOT NULL` (`kept-set == template-set` → true).

So the migration does not retire the column — it **scopes it to repeating templates** and clears the meaningless sentinel everywhere else, which is precisely what the new partial index `… ON TMTask (uuid) WHERE rt1_recurrenceRule IS NOT NULL` is for. The host numbers agree once you do the arithmetic: 22,074 shared rows − 21,960 changed = **114**, exactly the host's repeating-template count.

#### Confirmed against the live host

The lab has only two templates, so the claim was checked on the maintainer's own (already-migrated) library, read-only through `scripts/prod-read.sh`:

```
SELECT (rt1_recurrenceRule IS NOT NULL) AS isTemplate,
       (rt1_nextInstanceStartDate IS NOT NULL) AS hasNext, COUNT(*)
FROM TMTask GROUP BY 1,2;
  0 | 0 | 21962      <- every non-template row: NULL
  1 | 0 |    41      <- templates WITHOUT a projection value
  1 | 1 |    73      <- templates WITH one
```

So on the host too the column survives — on **73 of 114 templates** — and is NULL on every one of the 21,962 non-template rows. It is not retired.

The 41 template NULLs are **not** the migration's doing; they predate it. DBV27's own numbers close exactly: of 22,074 shared rows, 21,960 changed (21,959 val→NULL plus 1 organic val→val), and 73 end non-null, so 21,959 + 73 = 22,032 rows held a value before the migration and **42 were already NULL** — matching the 41 template NULLs measured now to within one row. Every template that had a cached projection kept it, byte-identical, exactly as the lab shows.

Breaking the 41 down (`rt1_recurrenceRule IS NOT NULL`, grouped):

| paused | trashed | count | has a projection? |
|---|---|---|---|
| no | no | **73** | yes |
| no | no | **27** | no |
| no | yes | 6 | no |
| yes | no | 3 | no |
| yes | yes | 5 | no |

All 8 paused and all 11 trashed templates lack one, which is unsurprising. The interesting cohort is the **27 live, unpaused, untrashed templates with no cached projection** — a template class that never had one (after-completion rules have no calendar next; a rule past its Ends bound has none either are the obvious candidates, unverified).

#### What this means for the queued work

- **The 3.23 migration did NOT break the projection day.** Any template lacking a cached projection lacked it under 3.22 as well. If `move.ts` / `reorder.ts` / `pre-state.ts` behaved correctly on 3.22.14 they behave the same on 3.23 — the up-next item (0) framing ("the projection day has lost its input") is wrong.
- The derivation work that landed on main while this campaign ran — `src/model/template-projection.ts` (#520) and the read routing (#522) — is therefore **a real robustness improvement for a PRE-EXISTING gap covering ~24% of live templates, not a 3.23 regression fix.** It already prefers the cached column when present, which is exactly right; what needs correcting is the premise in its naming and comments ("Things 3.23 has retired `rt1_nextInstanceStartDate`", "takes the cached column while a running app still maintains it (≤3.22)") — 3.23 maintains it too, on 73 of 114 live templates. **Its lab certification still rides steps (2)/(3), and the 27 live templates with no cached projection are the cohort that actually exercises the derivation** — worth a targeted cell rather than assuming the sweep covers it (the golden's two seed templates both carry a cached value, so nothing in this sweep touched the derived path).
- Template-adjacent reorder IS broken under 3.23 — see §3.1 — but for a completely unrelated reason (the private reorder command no-ops for everything).

### 2.2 Correction 2 — the counters are sentinel initialisation, not a self-count

DBV27 reads the counter move as "leaf to-dos now count **themselves** (+1)". In the lab every changed counter goes `-1 → 0` and **no row that already held a real count changed at all**:

- `type = 0` (to-dos) had `untrashedLeafActionsCount = -1` (uninitialised) → `0`. A to-do has no leaf children, so 0 is the *correct* value, not a self-count.
- `type = 1` / `type = 2` (projects, headings) had `checklistItemsCount = -1` → `0`. Neither can hold a checklist.
- Rows that carried real values — projects with 1/2/3/4 open leaves, the one to-do with 3 checklist items — are **untouched**.

The law is: **3.23 back-fills the `-1` sentinel with a computed 0 for the row classes that never had one**, so every row now carries all four counters. `+1` is just what `-1 → 0` looks like in aggregate. Any consumer that treats `-1` as "unknown / not computed" now sees a genuine `0` — that, not a self-count, is the semantic to check in `src/read/shape.ts`.

### 2.3 The spawn-cursor rewrite did not reproduce

The host saw `rt1_instanceCreationStartDate` move strictly forward on 94 of 114 templates. In the lab: **zero changed rows** — both templates' cursors sat at `132805376` before and after. The obvious explanation is that the lab's clock is pinned to 2026-07-05 and its cursors already point there, whereas the host's library had months of real time behind it. That makes the host's forward move look like **cursor catch-up to "now" on first launch**, not a schema-driven rewrite — but the lab cannot prove it, because it cannot produce a stale cursor without unpinning the clock. A cell worth designing: pin a clone forward by N months, launch 3.23, and watch what the cursor does.

---

## 3. `lab:regress` against golden-v4

Run 2026-08-22 with the runner and `regress.sh` re-pointed at `things-lab-golden-v4` / `golden-v4-metadata.json`. Because the sweep is expected to be red, it was driven by a wrapper that runs every suite instead of stopping at the first failure (`regress.sh` itself is `set -e`). Golden-v3 was GREEN across all of these ([gv3-certification.md](gv3-certification.md)), so **every FAIL below is a v3→v4 delta** and every `ok` is an unchanged law.

| suite | probes | result | failures |
|---|---|---|---|
| u (URL scheme) | 23 | **GREEN** | — (U12's schedule-class crash still reproduces, as expected) |
| a (AppleScript) | 39 | **RED** | **A10** (tier 3 ≠ 0), **A01B** (create-at-locus lost its Today scheduling) |
| x (cross-vector) | 3 | **GREEN** | — |
| o (ordering) | 38 | **RED — 14 failures** | O03 O04 O06 O10 O11 O15 O16 O17 O20 O34 O35 O36 O38 O39 |
| r (reminders) | 21 | **RED** | **R01** (tier 3 ≠ 0) — the other 20 green, R09's crash still reproduces |
| e (editing) | 19 | **GREEN** | — |
| p (gap-closure) | 30 | **GREEN** | — |
| s (Shortcuts) | 6 (delete-class probes are `group:interactive`, auto-skipped) | **GREEN** | — |
| write-layer e2e smoke | 132 steps | **RED — 6 failures** | steps 54, 70, 76, 78 (+ 2 dependent disclosure asserts) — **all reorder, all failing CLOSED** |

Run ids: `lab/artifacts/{u,a,x,o,r,e,p,s}-20260822-08*` and `lab/artifacts/things-run-e2e-20260822-033719`.

### 3.1 The headline: the private reorder command is a SILENT NO-OP

Every o-suite failure has the same shape — `_private_experimental_ reorder to dos in …` exits **0**, produces an **empty row delta**, and the ordering assertion never becomes true.

A dedicated probe ([`lab/scripts/research-ord323.sh`](../../lab/scripts/research-ord323.sh)) confirms it against a project scope with an order the fixture provably did not already have:

```
project LAB-PROJ-PLAIN children by index:  LAB-P-1:-665  LAB-P-2:-283  LAB-P-3:0
drive: _private_experimental_ reorder to dos in project id "<uuid>" with ids "<P-3,P-2,P-1>"
osascript EXIT=0
after:                                     LAB-P-1:-665  LAB-P-2:-283  LAB-P-3:0
```

Byte-identical. (The same script's Today-scope cell is inconclusive — the "reversed" id list it built happened to match the existing display order — but o-suite's Today probes O03/O17/O20 all fail with a zero delta, so Today behaves the same way.)

**The sdef canary cannot see this.** `Things.sdef` still declares `_private_experimental_ reorder to dos in` (7 hits), so `write/experimental.ts`'s availability check stays green while the command does nothing. This is exactly the failure mode the drift runbook warns about: a behavioral change with zero schema and zero dictionary delta. Whatever the fix is, the canary needs a *behavioral* arm.

Scope of the blast radius, unreconciled: the native reorder wire in `src/write/reorder.ts`, everything the O-suite locks, and the `todayIndex`/`index` placement laws that `move.ts` depends on. Note the five `W3PZB9e7W6BEtKmEKP4deG` failures (O34/O35/O36/O38/O39) are the *repeating-template* interleave cells — they fail for the same reason as the plain ones (the command no-ops), **not** because of the `rt1_nextInstanceStartDate` story in §2.1.

The good news is in §3.5: the shipped engine's verify-per-write catches this and refuses. Users get exit 3 and an honest `app-behavior-change` message, never a silently wrong order.

O06 additionally shows two seed to-dos ending with `heading = "5saDdJcodvWARN9Ct2nQsT"` where `null` was expected — worth a second look, though it may be fixture bleed from an earlier failed probe in the same clone rather than a new law.

### 3.2 A01B — AppleScript create-at-locus no longer schedules

```
tell application "Things3" to make new to do at beginning of list "Today" with properties {name:"A01B-TODO"}
```
lands the to-do (the row is inserted) but with `start = 0` and `startDate = NULL`, where 3.22.14 produced `start = 1`, `startDate = 132805248`. **Creating "at a list locus" no longer applies the list's scheduling.** This is a genuine AppleScript capability regression and touches `todo.create-at-locus` in the capability matrix.

### 3.3 A10 / R01 — a first-touch window materialisation (tier 0 → 3)

Both failures are tier-only, both with an identical monitor signature: `window-new` with title `Today`, `launch = false`, `activated = false`, `windowClose = 0`, `titleChanges = 0`. Both are the **first probe executed** in a suite whose `appState` is `running-background`, and in both cases every command still returns exit 0 with correct output (A10's list counts, R01's URL add). So under 3.23 the app appears to materialise a list window on first touch **without emitting a launch or activation**, which the tier rules classify as tier 3. Not a data regression; it is a disruption-budget question the maintainer has to rule on (fix the app-state warm-up, widen the budget for this shape, or record a new tier law).

### 3.4 What did NOT move

Worth saying explicitly, because it bounds the campaign: the entire URL-scheme surface (u, 23 probes), cross-vector identity (x), the editing surface (e), 20 of 21 reminder probes, and 26 of 40 ordering probes are **unchanged**. Both known schedule-class crashes (U12, R09) still reproduce, so the guards stay. The repeat-rule blobs still decode (the golden's two templates round-trip with their rule bytes intact through the migration).

### 3.5 The shipped engine fails CLOSED on the reorder no-op

The write-layer e2e smoke is the reassuring half of the story: 132 steps, 6 failures, **all of them reorder, and every one of them a clean refusal rather than a wrong landing**.

```
[54] project-child reorder (bare)      -> verify-failed / silent-noop
        "no observable change in the database (the app accepted the command but did nothing)"
        likelyCause: app-behavior-change
[70] native reorder of a project's HEADINGS  -> verify-failed:silent-noop
[76] grand interleave (day scope)      -> verify-failed / bounce-aborted
[78] mixed-kind grand interleave       -> verify-failed / bounce-aborted
```

Verify-per-write caught the no-op every time, named the right cause (`app-behavior-change`), and returned exit 3 with zero mutation. The 126 non-reorder steps — creates, updates, moves, tags, deadlines, repeats, checklists, trash/restore, undo, the audit trail (305 records, token-free) and both live guard checks — all pass. `dbVersion: 27`, `fingerprint: ok` throughout.

### 3.6 Sweep completeness

All eight suites and the e2e smoke ran to completion. Run ids are listed under §3's table; the raw per-suite logs are in the campaign's scratch output, and per-probe evidence in each run's `evidence/` directory.

---

## 4. The repeat surface

Full census in [rdlg1-323-repeat-dialog-census.md](rdlg1-323-repeat-dialog-census.md). The three-line version:

- The dialog is still an `AXSheet` (attached) / detached `AXUnknown` window, and `DIALOG_FREQUENCY`, `DIALOG_INTERVAL`, `DIALOG_ENDS`, `DIALOG_AC_UNIT`, `DIALOG_ADD_WEEKDAY`, `DIALOG_OK` and both checkboxes all still resolve. **`todo make-repeating --frequency daily --interval 1 --dangerously-drive-gui` drove end-to-end and landed a correct template + instance under 3.23** (8 steps, `ok: true`, verify passed).
- A **new `Next:` pop-up** sits between Ends and every per-frequency control, so `DIALOG_WEEKDAY` / `DIALOG_MONTH_*` / `DIALOG_YEAR_*` are all off by **+1**, and the first-occurrence anchor changed control class from `AXDateTimeArea` to `AXPopUpButton` (killing the `setDateTime(target:"next")` path and every off-rule-first law that rides it).
- `Items ▸ Repeat ▸ Reschedule…` was **renamed `Edit Rule…`**, so `rescheduleRepeatRecipe` fails with `-1728`. The submenu also gained `Create Next Copy` and `Show Previous Copy`, and `File` gained `New Repeating To-Do`.

---

## 5. Standing state after this campaign

- `things-lab-golden-v4` is **frozen** (stopped, never re-booted after the freeze) and is now the golden the runner clones (`lab/runner/run.ts`, `lab/scripts/regress.sh`, `lab/scripts/e2e-write-smoke.sh`).
- It is **NOT certified**. `golden-v4-metadata.json` records `MINTED + SWEPT, NOT YET CERTIFIED`; certification waits on the maintainer reconciling §3.
- `things-lab-golden-v3` (3.22.14) and `-v2` (3.22.12) are retained on disk as fallbacks.
- Do **not** run `things config set certified-app-version 3.23` yet — the drift runbook's step 4 requires the register walk, and the register walk is blocked on reconciling the reorder no-op.
