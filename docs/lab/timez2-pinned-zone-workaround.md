# TIMEZ2 — the pinned-zone relaunch workaround for the dated-evening gap, and its side-effect inventory

Certifies the maintainer's proposed workaround for the **dated-evening gap** TIMEZ closed as impossible ([timez-evening-and-zones.md](timez-evening-and-zones.md), TIMEZ-NODATE): there is NO single-surface vector that writes This-Evening (`startBucket=1`) on any calendar day but the app's current local day. The workaround: **quit Things → relaunch under a DIFFERENT effective timezone (so the app's "today" is the day the caller wants) → perform the evening write (which stamps the shifted "today") → quit → relaunch normally.** TIMEZ2 answers: (1) can the effective zone be pinned **per-process** without touching the system zone; (2) does the evening write then land dated-evening; (3) the FULL side-effect bill of the shifted-forward launch; (4) does an early-materialized repeat instance DUPLICATE or dedupe when the real clock later reaches that day; (5) the reverse (behind-zone) leg.

ONE disposable offline Tart clone (`timez2-lab`, runs **2026-08-05**, golden **`things-lab-golden-v2`** · **Things 3.22.12** (build 32212016) · macOS **15.7.7** Sequoia · DB schema **v26** · airgapped, **no cloud account**). Base clock pinned **2026-07-05** at the **12:00Z** instant (`sudo date` on this guest sets UTC; the guest displays 08:00 EDT under the base zone **America/New_York**, UTC−4 DST). At 12:00Z the far-east zone **Pacific/Kiritimati** (UTC+14) reads local **07-06** (host tomorrow); a behind leg re-pins the clock to **06:00Z** so **Pacific/Midway** (UTC−11) reads **07-04** (host yesterday — no real zone is "yesterday" at 12:00Z). Writes go ONLY through official surfaces (URL scheme, AppleScript). Effective-zone changes use the **per-process `TZ` env** (the workflow-native mechanism, T2-ENV) with `systemsetup -settimezone` as the guaranteed control; day-boundary rolls use `sudo date` (RSIM-S recipe). All clock/TZ/launchctl changes happen in the VM ONLY, never the host. Ground truth = guest read-only SQLite (raw bytes + decoded) + **full `.dump` byte-diffs** + the AppleScript list oracle. Date codec is the library's (`y<<16|m<<12|d<<7`): `07-04`=132805120, `07-05`=132805248, `07-06`=132805376, `07-07`=132805504. Fixtures fully synthetic (`TZ2-*`). Script: [`lab/scripts/research-timez2.sh`](../../lab/scripts/research-timez2.sh) (`setup`/`inspect`/`env`/`eve`/`sidefx`/`dedupe`/`reverse` + interactive verbs). Evidence (gitignored, synthetic): `lab/artifacts/timez2-lab/` (`report-*.txt`, `*.dump`, `*.meta`, `diff-*.txt`).

**Status: RAN + BANKED (each headless leg reproduced across two fresh clones). Evidence only — NO wiring, NO CHANGELOG.**

> **Honesty constraint — true two-device sync is BLOCKED (no cloud account, SYNC2).** The dedupe leg (T2-DEDUPE) models the two-synced-devices-across-zones scenario with a SINGLE app whose zone/clock is moved. The load-bearing bridge is the same one TIMEZ established: the app derives every list from the device wall-clock and mutates no `TMTask` row on a pure zone change (TIMEZ-ROLL-c), and the repeat engine's dedupe key (the template's `next`-instance cursor) is a stored row value that sync replicates. So the single-app "materialize early, then advance the real clock" faithfully models "device A materializes, device B receives the row + the advanced cursor and does not re-materialize." The one thing it cannot show is a genuine 3-way sync *merge* of two independently-materialized instances — that stays SYNC2-blocked and is called out inline.

## Verdict table

| Leg | Question | Verdict |
|---|---|---|
| **T2-ENV** | can the app's effective zone be pinned per-LAUNCH without changing the system zone? | **YES — `TZ=<zone> open -a Things3` (and direct-exec of the app binary) both PIN; `launchctl setenv TZ` does NOT.** With the system zone held at `America/New_York` (verified each run), a fresh launch under `TZ=Pacific/Kiritimati` stamped `when=today` → `startDate=2026-07-06` (the pinned-zone local day); the control `systemsetup -settimezone` also stamped 07-06. `launchctl setenv TZ` stamped 07-05 (NO pin) — the ssh session's launchd domain ≠ the Aqua session's, so the GUI app never inherits it. Reproduced identically on two clones. **Precondition:** Things must be QUIT first — `TZ=… open` on an already-running app is a no-op activation (the env only applies to a fresh spawn). |
| **T2-EVE** | does `when=evening` under a zone pinned AHEAD land dated-evening, and survive the reset? | **YES — a genuine dated-evening row, the ONLY known way to make one.** Under the AHEAD-pinned app (Kiritimati today=07-06), `things:///update?when=evening` → `start=1, startBucket=1, startDate=2026-07-06` (`tiRef=132804992`, the fixed evening reference, matching Z-SUB). After resetting to base NY and a normal relaunch the row is **byte-identical** (`userModificationDate` unchanged — the reset does NOT rewrite it: purity). For the un-shifted (07-05) viewer it is a member of `list "Today"` AND `list "Anytime"` and ABSENT from `list "Upcoming"` — the Z-ROLL-b law: `start=1` pins it into flat Today/Anytime **a day early**, no This-Evening section, NOT held in Upcoming. |
| **T2-SIDEFX** | full side-effect bill of the shifted-forward launch beyond the intended write | **A tightly bounded bill: one day-cursor blob + the repeat engine materializing the shifted day's instance.** A bare shifted-forward launch (07-05→07-06) on the pristine golden mutated: (c) **the single `TMMetaItem` day-cursor blob** 07-05→07-06; (a) **the DAILY repeat template** — materialized ONE new instance dated 07-06, advanced its `next`-instance cursor 07-06→07-07 and its instance-counter 3→4, **`userModificationDate` UNCHANGED (umd-silent)**; and a shared per-template "horizon" packed-date column advanced 07-06→07-07 (umd-silent) on BOTH repeat templates (the WEEKLY, whose real next is 07-12, materialized nothing). **NOT touched:** (b) NO `start 2→1` promotions (Today membership stays a derivation, existing dated rows byte-identical); (d) NO stale-reminder writes; (e) NO umd-silent re-ranks on user rows — no user `TMTask` row was rewritten at all. The subsequent reset-relaunch stepped ONLY the day-cursor blob back (07-06→07-05); the materialized instance + advanced template cursor **PERSIST permanently**. |
| **T2-DEDUPE** | early-materialized instance vs the real clock later reaching that day — duplicate or dedupe? | **DEDUPE (cursor-keyed); the backward cursor step is tolerated with zero data effect.** STEP 1 (shifted launch) materialized the 07-06 instance early and advanced the template cursor 07-06→**07-07**. STEP 2 (reset zone to base, clock still 07-05, relaunch) stepped the day-cursor blob back 07-06→07-05 with **zero `TMTask` delta** — no error, no compensating mutation; the template cursor did NOT roll back and the instance persisted. STEP 3 (advance the REAL clock to 07-06, relaunch) produced a **byte-identical DB** — no new instance. Because the shift already advanced the cursor past 07-06, the real 07-06 arrival is a no-op. (Models the two-device case per the honesty note; a true 3-way sync merge of two independent materializations is SYNC2-blocked.) |
| **T2-REVERSE** | zone pinned BEHIND (host yesterday): what stamps + side effects distinct from forward? | **`when=today` stamps the behind local day (07-04); the backward launch is MORE inert than the forward one.** Under Midway (UTC−11, local 07-04) `when=today` → `startDate=2026-07-04` (the device local day — TIMEZ-CLOCK, symmetric). The only side effect is the day-cursor blob stepping BACKWARD 07-05→07-04; **NO repeat materialization** (a backward step has no new day to fill), **NO de-materialization** (existing instances stay), and the template cursors do NOT roll back. Only the single day-cursor blob moves. |

---

## The workflow verdict

**The workaround is OPERATIONALIZABLE, and the side-effect bill is small and well-understood.**

```
quit Things
TZ=<ahead-zone> open -a Things3          # app adopts the pinned zone; system zone untouched
things:///update?id=<u>&when=evening      # (or add?title=…&when=evening) → dated-evening on the shifted "today"
quit Things
open -a Things3                           # normal relaunch under the real zone
```

- **Per-process pin works (T2-ENV).** `TZ=<zone> open -a Things3` is the clean mechanism the maintainer proposed — LaunchServices forwards the caller's environment to a **freshly-spawned** app, so the app's `NSTimeZone`/`CFTimeZone` default adopts the pinned zone **without** any `systemsetup` change (the system zone stayed `America/New_York` in every run). Direct-exec of the app binary works too. `launchctl setenv TZ` does NOT (cross-launchd-domain from an ssh session). This means the workflow needs **no elevated system-wide zone change** — a per-command env prefix suffices.
- **It produces the otherwise-impossible row (T2-EVE).** `when=evening` under the ahead-pinned app lands `startBucket=1` with `startDate = the shifted day` — a true dated-evening row, the one shape TIMEZ proved unreachable on every single surface. The row is inert to the reset (byte-identical, umd unchanged).

**The side-effect bill (the exact price beyond the intended row):**

| # | Effect | Permanent? | Notes |
|---|---|---|---|
| 1 | The single `TMMetaItem` day-cursor blob advances to the shifted day, then steps back on the reset | **No** (self-correcting) | `bplist00`-wrapped 4-byte int = the packed current-day date (same `y<<16\|m<<12\|d<<7` codec): 07-05=`07EA7280`, 07-06=`07EA7300`, 07-04=`07EA7200`. Round-trips cleanly; the backward step is tolerated (T2-DEDUPE STEP 2). |
| 2 | Any repeating template whose `next`-instance date falls on the shifted day **materializes its instance early** and advances its cursor + instance-counter | **YES** — the reset does NOT undo it | The real cost. A daily repeat pulls tomorrow's instance forward permanently. Template mutations are **umd-silent**. When the real clock later reaches that day, cursor-keyed dedupe means **no duplicate** (T2-DEDUPE). |
| 3 | A shared per-template "horizon" packed-date column (= effective-today+1) advances on ALL repeat templates | Persists (bookkeeping) | umd-silent; benign — the template's real `next` and its schedule are unchanged for templates that don't materialize. |
| 4 | **Nothing else.** No `start 2→1` promotions, no reminder machinery, no user-row re-ranks, no `TMTask` row rewrites | — | The shifted launch does not touch user data beyond materializing due repeat instances. |

**Preconditions & caveats (must be surfaced to any caller):**

1. **Quit first.** The pin only applies to a fresh spawn; `TZ=… open` on a running app silently no-ops.
2. **A repeat due on the shifted day is pulled forward permanently** (bill #2). If the shifted day is a day a repeating template is due, that instance is created early and the template advances — this is the only durable data effect, and it self-dedupes when the real clock arrives, but the early appearance is real. Callers who must avoid it should pick a shifted day with no repeat due (or accept the early instance).
3. **The dated-evening row renders a day EARLY for the current device.** For the un-shifted (real-today) viewer the `start=1` evening-on-tomorrow row appears in flat **Today/Anytime immediately**, NOT held in Upcoming until the target day (Z-ROLL-b). It only presents as a proper This-Evening item once *this* device's own clock reaches the target date. So the workaround achieves the dated-evening **storage shape**, but on the writing device the presentation is "in Today a day early," not "waiting in Upcoming." This is inherent to `startBucket=1` (evening is a sub-placement of Today) and cannot be avoided while keeping the evening bucket.
4. **No reminder is attached** (the evening bucket carries none), so the item is a silent Today member until viewed.

**Net:** for a caller who genuinely needs a This-Evening item dated for another day (e.g. a remote-zone user whose local evening is the app's tomorrow), the pinned-zone relaunch is a viable, low-cost mechanism — provided the caller understands the early-materialization of any due repeat and the day-early Today presentation on the writing device.

---

## Per-leg evidence

### T2-ENV — per-process effective-zone pin

Each mechanism: quit Things → launch under `TZ=Pacific/Kiritimati` (or the control) → `things:///add?title=…&when=today` → read `startDate`. System zone asserted `America/New_York` throughout.

| Mechanism | Command | `when=today` `startDate` | Pins? | System zone during |
|---|---|---|---|---|
| `open` | `TZ=Pacific/Kiritimati open -a Things3` | **2026-07-06** | **YES** | America/New_York |
| `launchctl` | `launchctl setenv TZ Pacific/Kiritimati; open -a Things3` | 2026-07-05 | **NO** | America/New_York |
| `directexec` | `TZ=Pacific/Kiritimati /Applications/Things3.app/Contents/MacOS/Things3 &` | **2026-07-06** | **YES** | America/New_York |
| `systemsetup` (control) | `systemsetup -settimezone Pacific/Kiritimati` | 2026-07-06 | YES | **Pacific/Kiritimati** |

The `open` and `directexec` results are the finding: the app adopts the `TZ` env of the process that spawns it (Foundation's default timezone honors `TZ` on Darwin), so a per-command env prefix pins the effective zone with the system zone untouched. `launchctl setenv` fails because an ssh-session `launchctl` writes to a different launchd domain than the one LaunchServices launches the GUI app into. Reproduced identically on both clones (2026-08-05).

### T2-EVE — the dated-evening write

Under the ahead-pinned app (`open`, Kiritimati today=07-06):

```
before:            TZ2-EVE start=0 sb=0 sd=-        (fresh anytime to-do)
when=evening:      TZ2-EVE start=1 sb=1 sd=2026-07-06 tiRef=132804992 umd=1783267238
after reset+relaunch (base NY, 07-05): TZ2-EVE start=1 sb=1 sd=2026-07-06 tiRef=132804992 umd=1783267238  (BYTE-IDENTICAL)
AS oracle (un-shifted viewer, local 07-05): in Today=true · in Anytime=true · in Upcoming=false
```

`startBucket=1` on a `startDate ≠ today` — the exact shape TIMEZ-NODATE proved impossible on every single surface, produced here by moving the app's notion of "today." The reset leaves the row untouched (the derivations are pure; TIMEZ-ROLL-c). Z-ROLL-b governs the un-shifted render: the row is pinned into Today/Anytime a day early, not Upcoming.

### T2-SIDEFX — the shifted-launch byte-diff (pristine golden)

Golden repeat landscape at base: `LAB-REPEAT-DAILY` template `next`=07-06 (instances 07-03/04/05, none on 07-06); `LAB-REPEAT-WEEKLY-PROJ` template `next`=07-12. Full `.dump` diff of a single bare shifted-forward launch (07-05→07-06, no write):

- **`TMMetaItem` day-cursor** `bKihwoi9HYJL7Dd9YDGc2`: `…07ea7280…` (07-05) → `…07ea7300…` (07-06).
- **DAILY template** `W3PZB9e7…`: `next`-instance cursor 132805376→132805504 (07-06→07-07), instance-counter 3→4, `userModificationDate` **unchanged** (`1783253090.89…`); the embedded `rt1` recurrence plist blob untouched.
- **WEEKLY-PROJ template** `759yS6…`: the shared horizon column 132805376→132805504 (07-06→07-07), umd-silent; its real `next` (132806144 = 07-12) and counter (1) unchanged — no weekly instance materialized.
- **NEW instance** `U8NHn3sSbJx5rGUmVrgRGB`: a fresh `LAB-REPEAT-DAILY` row, `startDate`=132805376 (07-06), `start=2`, `rt1_repeatingTemplate` FK = the template uuid, `rt1_nextInstanceStartDate`=69760 (instance sentinel).

Repeat-machinery deltas confirmed by decoded query: `next 07-06 → 07-07`, `daily-instances 3 → 4`, `daily-inst-0706 0 → 1`. The **shifted→reset** diff was ONLY the day-cursor blob stepping back (07-06→07-05), `TMTask: 0` — the materialization persisted (`next` stayed 07-07, 4 instances). Evidence: `lab/artifacts/timez2-lab/diff-base-shifted.txt`, `diff-shifted-reset.txt`, `report-sidefx.txt`.

### T2-DEDUPE — early materialization vs real-clock catch-up

Pristine golden (`next`=07-06, 0 instances on 07-06):

| Step | Action | inst-0706 | DAILY `next` | day-cursor | `TMTask` delta |
|---|---|---|---|---|---|
| BEFORE | base NY, clock 07-05 | 0 | 07-06 | 07-05 | — |
| STEP 1 | shifted launch (Kiritimati, 07-06) | **1** | **07-07** | 07-06 | +1 instance, template cursor advanced |
| STEP 2 | reset zone→NY, clock still 07-05, relaunch | 1 | 07-07 | **07-05** | **0** (only cursor blob steps back) |
| STEP 3 | advance REAL clock→07-06, relaunch | 1 | 07-07 | 07-06 | **0** (byte-identical to STEP 1) |

The real-clock arrival at 07-06 (STEP 3) is a no-op because the shift already advanced the template `next` past it — **cursor-keyed dedupe**. The backward day-cursor step (STEP 2) is tolerated cleanly: no error, no compensating write, the template cursor does not roll back, the instance is not removed. Evidence: `diff-dedupe-back.txt` (2 `TMMetaItem` lines, 0 `TMTask`), `diff-dedupe-catchup.txt` (empty).

### T2-REVERSE — behind-zone stamping + backward launch

Reverse base clock 06:00Z (NY date still 07-05); pin Midway (UTC−11, local **07-04**):

```
when=today under Midway:  TZ2-REV start=1 sb=0 sd=2026-07-04   (the behind local day — TIMEZ-CLOCK, symmetric)
day-cursor blob: 07EA7280 (07-05) → 07EA7200 (07-04)          (steps BACKWARD)
TMTask delta base→behind: only the TZ2-REV write itself; repeat templates UNCHANGED (DAILY next stays 07-07, 4 instances)
```

The backward launch is strictly more inert than the forward one: a step back in time has no new day to materialize, does not de-materialize existing instances, and does not roll the template cursors back. Only the day-cursor blob moves.

---

## App oddities filed

- **§9x (new)** — **A repeating instance materialized "early" by a forward day step is NOT rolled back when the day step reverses.** A relaunch whose effective today is day D+1 (via a pinned-ahead zone OR a real clock advance) materializes the repeating template's D+1 instance and advances the template's `next` cursor past D+1; a subsequent relaunch whose effective today reverts to D steps only the opaque `TMMetaItem` day-cursor blob back to D — the materialized instance persists and the template cursor stays advanced (zero `TMTask` compensation). Consequence (benign, and arguably correct): a repeating instance can exist in the DB dated a day (or more) in the future relative to the device's real today, and when the real clock catches up the app dedupes on the advanced cursor rather than re-materializing. Not a crash or corruption — recorded because it is the durable data effect of any forward-then-back clock/zone excursion (the pinned-zone dated-evening workaround, a user who manually time-travels the clock, or a device that briefly held a fast/ahead clock). (TIMEZ2 T2-SIDEFX / T2-DEDUPE.)
- **Note (not an app bug — platform/mechanism):** the app's effective timezone is the process `TZ` environment variable at launch (Foundation default-zone honors `TZ` on Darwin), so `TZ=<zone> open -a Things3` pins the app's "today" without any system-zone change — but only on a FRESH spawn (an already-running app ignores it), and `launchctl setenv TZ` from a non-Aqua (ssh) launchd session does NOT reach a LaunchServices-spawned GUI app. Recorded in [novel-paths.md](../reference/novel-paths.md) as a per-process zone-pin path.

## Reproduce

```sh
TART_HOME=/Volumes/Workspace/tart bash lab/scripts/research-timez2.sh setup     # clone golden-v2 + boot + airgap + base TZ + pin 07-05 12:00Z + helpers
  bash lab/scripts/research-timez2.sh inspect        # golden repeat templates + dated landscape + meta blob
  bash lab/scripts/research-timez2.sh env            # T2-ENV: open / launchctl / directexec / systemsetup pin sweep
  bash lab/scripts/research-timez2.sh eve open       # T2-EVE: dated-evening via TZ=<ahead> open, + reset purity + AS oracle
  bash lab/scripts/research-timez2.sh sidefx open    # T2-SIDEFX: full-dump byte-diff of the shifted-forward launch  (run on a PRISTINE clone)
  bash lab/scripts/research-timez2.sh dedupe         # T2-DEDUPE: materialize-early → backward reset → real-clock catch-up  (run on a PRISTINE clone)
  bash lab/scripts/research-timez2.sh reverse        # T2-REVERSE: behind-zone (Midway) when=today + backward launch
  bash lab/scripts/research-timez2.sh teardown
```

`sidefx` and `dedupe` each need a fresh clone (the FIRST shifted launch consumes the pristine `next`=07-06 template state; a second shifted launch is a no-op). All legs are headless (byte + AS oracle); no Accessibility/VNC needed. Timezone/clock/launchctl changes are VM-only. Fixtures are synthetic `TZ2-*`; the golden is never mutated (disposable clone). Golden repeat templates (`LAB-REPEAT-DAILY` next=07-06, `LAB-REPEAT-WEEKLY-PROJ` next=07-12) are the natural experiment for the materialization legs.
