# RRX1 — repeat-rule count exhaustion + reminder storage (two unprobed questions + a read/doc reconciliation)

**Probed under: `things-lab-golden-v2` · Things 3.22.12 (build 32212016) · macOS 15.7.7 · DB schema v26 · pinned clock 2026-07-05 12:00 (a SUNDAY), advanced +1 day at a time to 2026-07-09.** ONE disposable clone `rrx1-lab` of golden-v2 (golden untouched; every write inside the clone), airgapped (default route deleted, ping fails), clock pinned before Things launched, all six `things-proxy-*` shortcuts golden-resident. Ground truth = read-only guest SQLite (decoded `rt1_recurrenceRule` blob keys + `rt1_nextInstanceStartDate` cursor + `rt1_instanceCreationStartDate` + `rt1_instanceCreationCount` + `reminderTime` + template/instance status/trashed). Series driven through the PRODUCTION e2e bundle (shipped CLI, `make-repeating`/`add-repeating` ui-vector via the baked L3-AX grant). Fixtures fully synthetic (`RRX-*`). Branch `mg/rrx1-rc-reminder`; drivers [`rrx1-setup.sh`](../../lab/scripts/rrx1-setup.sh) / [`rrx1-create.sh`](../../lab/scripts/rrx1-create.sh) / [`rrx1-create-rc.sh`](../../lab/scripts/rrx1-create-rc.sh) / [`rrx1-advance.sh`](../../lab/scripts/rrx1-advance.sh) / [`rrx1-clear.sh`](../../lab/scripts/rrx1-clear.sh) / [`rrx1-clearop.sh`](../../lab/scripts/rrx1-clearop.sh) / [`rrx1-recert.sh`](../../lab/scripts/rrx1-recert.sh); artifacts (gitignored) `lab/artifacts/rrx1-lab/`.

Codec reminders: `reminderTime = hour<<26 | minute<<20` (18:00 = 1207959552, 09:00 = 603979776, 08:00 = 536870912); packed dates `y<<16|m<<12|d<<7`; `ia`/`sr`/`ed` are unix-epoch seconds; the year-4001 "forever" `ed` sentinel = 64092211200.

---

## HEADLINE VERDICTS

1. **`--ends-after N` writes `rc=N` AND OMITS the `ed` key entirely. `rc` is the CONFIGURED TOTAL and is IMMUTABLE — it NEVER decrements** (neither per spawn nor per completion). The app counts spawns in the template's `rt1_instanceCreationCount` and ends the series by **clearing the cursor `rt1_nextInstanceStartDate` → NULL** once `icCount == rc`. The rule blob is byte-unchanged at exhaustion (`rc` still N, no `ed`).
2. **Exhaustion end-state (both ends-after and ends-on): a FIXED template with `next` (cursor) = NULL.** Template is NOT trashed, `status=0`, `paused=0`; spawned instances persist (accumulate). A past `--ends-on` is **"born already ended"**: cursor NULL from creation, `icCount=0`, ZERO instances.
3. **The read model's `remainingCount === 0 → ended` branch was UNREACHABLE and WRONG.** The decoder mapped `rc=0→null` and `rc=N→N`, so it could never emit 0; and an exhausted ends-after series decodes with `occurrenceCount = N` (not 0), never `endDate`. Exhaustion is a CURSOR signal, not a count signal. Fixed in `recurrence.ts` (see §Fix).
4. **On 3.22.12 a repeating template's rule-level reminder IS a real `reminderTime` COLUMN value** — on BOTH the template AND every spawned instance (current occurrence and later spawns) — with **NO time key in the `rt1_recurrenceRule` blob.** This DIRECTLY CONTRADICTS RCLEAR (golden-v1/3.22.11: `reminderTime` NULL on template + pre-spawned instances). Oddities §8b corrected.
5. **The clear-refusal STANDS, for a corrected reason.** Even though the template now carries a `reminderTime`, NO automation surface clears a template's rule reminder in place: the Shortcuts `set-detail Reminder Time=""` is a **silent no-op** (proxy exit 0, column unchanged), the AppleScript de-schedule is **refused (error 301)**, and the URL bounce CRASHES (§1). So `todo.clear-dated-reminder` must **refuse a repeating template outright** — previously H-NO-REMINDER masked this (template `reminderTime` was NULL); now that the column carries a value the shipped op verify-failed, so an explicit refusal was added.

---

## Q1 — `--ends-after` / `--ends-on` count exhaustion (rc semantics)

Six daily/1 series, all driven at pinned 2026-07-05 through the shipped CLI, then the clock advanced one day at a time 07-06 → 07-09 (warm relaunch + Upcoming/Today nudge each step, per the ANCH2 lesson — a single multi-day jump does not retro-spawn and trips the /tmp cleaner).

- **EA** `add-repeating daily/1 --ends-after 3`, never completed.
- **EB** `add-repeating daily/1 --ends-after 3`, EVERY spawned occurrence completed (decrement disambiguation).
- **EO** `add-repeating daily/1 --ends-on 2026-07-08`.
- **EP** `add-repeating daily/1 --ends-on 2026-07-03` (a PAST date).

### rc-decrement law + exhaustion end-state (EA / EB)

| clock | EA rc | EA icCount | EA next (cursor) | EA live instances | EB (completed-each) rc / icCount / next |
|---|---|---|---|---|---|
| 07-05 (create) | **3** | 1 | 2026-07-06 | 07-05 | 3 / 1 / 07-06 |
| 07-06 | **3** | 2 | 2026-07-07 | 07-05, 07-06 | 3 / 2 / 07-07 (both occ completed → rc unchanged) |
| 07-07 | **3** | 3 | **NULL** | 07-05, 07-06, 07-07 | 3 / 3 / **NULL** (occ completed → rc unchanged) |
| 07-08 | **3** | 3 | NULL (icStart advances to 07-09, but cursor stays NULL) | **still 3 — NO 4th spawn** | 3 / 3 / NULL |
| 07-09 | **3** | 3 | NULL | still 3 | 3 / 3 / NULL |

**Law.** `rc` is the CONFIGURED "ends after N" total, written once and NEVER changed — it held at 3 through all three spawns and two days past exhaustion, and completing every occurrence (EB) moved it identically to never completing (EA). The app spawns exactly N occurrences (`icCount` climbs 1→N), then **clears the cursor** (`rt1_nextInstanceStartDate → NULL`) and stops. Decrement is **per SPAWN in `icCount`, never in `rc`, and completion is irrelevant.** At exhaustion the rule blob is byte-identical (`rc=3`, no `ed`); the template is untouched (`trashed=0 status=0 paused=0`); prior instances persist (not GC'd). The GUI projection list is empty for the series (cursor NULL → no dated occurrence).

The EA/EB baseline blob (verbatim): `fa=1 fu=16 of=[{dy:0}] rc=3 rrv=4 tp=0 ts=0` — **no `ed` key**.

### ends-on exhaustion + "born already ended" symmetry (EO / EP)

- **EO (`--ends-on 2026-07-08`):** blob `ed=1783468800 (2026-07-08) rc=0`. Spawned occurrences 07-05…**07-08 inclusive** (icCount reached 4), then cursor → NULL at 07-08. `ed` stays in the blob. So an ends-on series spawns THROUGH and INCLUDING the end date, then goes cursor-NULL.
- **EP (`--ends-on 2026-07-03`, a past date):** blob `ed=1783036800 (2026-07-03) rc=0`, and from CREATION: `next=NULL, icCount=0, ZERO instances` — a template **born already ended** (characterizes ANCH1's UIC6-m observation). The template row is otherwise normal (`trashed=0 status=0 paused=0`).

Both ends-on end-states share the ends-after end-state's signature: a fixed template with a NULL cursor. `ed` is authoritative independently (a past `ed` is "ended" even if a cursor lagged), which is why the read model keeps BOTH signals.

---

## Q2 — repeat-rule reminder storage (RCLEAR vs ANCH2 reconciliation)

- **RW** `make-repeating weekly/1 --reminder 18:00` (rule-level reminder, driven via the repeat editor's reminder picker — the ANCH2 now-working drive). **Template `reminderTime = 1207959552 (18:00)`; the current occurrence (spawned at creation, 07-05) `reminderTime = 1207959552 (18:00)`; rule blob ALLKEYS = `ed,fa,fu,ia,of,rc,rrv,sr,tp,ts` — NO time/reminder key.**
- **RC** `make-repeating daily/1 --reminder 08:00`. Template + current instance `reminderTime = 536870912 (08:00)`; **every later daily instance spawned by clock advance (07-06, 07-07, 07-08, 07-09) also carries `reminderTime = 536870912 (08:00)`.** So the reminder materializes on the template AND on ALL instances (current and future spawns), always in the COLUMN, never in the blob.
- **RD** `add-repeating daily/1 --reminder 09:00`: template AND instances `reminderTime = NULL`. **Not a storage anomaly — the REM1 law.** `add-repeating`'s `--reminder` is the base created item's OWN reminder (the extended `AddRepeatingRuleFields` intentionally excludes a rule-level reminder — see `src/write/operations.ts`), and the promote-to-template DROPS a plain item's reminder (REM1, oddities §8l area). To get a rule-level repeat reminder via the CLI you must use `make-repeating --reminder`. (A latent gap worth flagging, not fixed here: `add-repeating --reminder` cannot express a rule-level repeat reminder.)

### Reconciliation with RCLEAR (§8b) and ANCH2

RCLEAR (golden-v1 / **Things 3.22.11**) reported a repeat-editor reminder writes NOTHING to `reminderTime` (template or pre-spawned instances) and adds no time key to the rule ("storage location unresolved"). On golden-v2 / **3.22.12** this is FALSIFIED for the column claim: RW/RC prove `reminderTime` IS a real template + instance column value. ANCH2's RC5 (`make-repeating weekly/1 --reminder 18:00 → reminderTime=1207959552`) measured the TEMPLATE row only; RRX1 extends it to the spawned instances (current and later) and confirms the blob carries no time key. The RCLEAR NULL is either a 3.22.11→3.22.12 behavioral change or an RCLEAR measurement artifact (RCLEAR predates the ANCH2 discovery that the reminder picker is drivable — its manual GUI set may not have committed, or it read the wrong row); golden-v1 is superseded so 3.22.11 cannot be re-probed. **The current-build reality (3.22.12, the shipping golden) is: repeat reminder = a `reminderTime` COLUMN value on template + all instances, no blob key.** What STILL stands from RCLEAR: the reminder is a repeat-RULE property from the user's POV (it is not in the rule blob but is materialized onto every instance), and it cannot be cleared in place on a template (below).

### Clear-refusal consequence check (DB-verified)

RCLEAR's refusal premise was "no `reminderTime` to clear on a template". That premise is falsified — the column now holds 18:00 — so the clear surfaces were re-tested against RW (a template WITH a committed reminder), all DB-verified:

| Surface | Command | Result | `reminderTime` after |
|---|---|---|---|
| Shortcuts | `things-proxy-set-detail {detail:"Reminder Time", value:""}` on the template | proxy runs, **exit 0** | **1207959552 (18:00) — UNCHANGED (silent no-op)** |
| AppleScript | `move to do id <template> to list "Inbox"` | **error 301** ("Cannot move to-do") | unchanged |
| URL | `update?id=<template>&when=…` | (not run — §1 crash, established) | — |
| shipped op | `things todo clear-reminder <template>` | **VERIFY FAILED (silent-noop), exit 3** | unchanged |

So there is STILL **no in-place automation clear** for a repeating template's rule reminder — the refusal STANDS. But the MECHANISM broke: with `reminderTime` now non-null, `H-NO-REMINDER` no longer fires, so the op routed repeating → Shortcuts → silent no-op → verify-fail (exit 3) instead of a clean refusal. **Fix (op change, DB-justified):** `todo.clear-dated-reminder` now refuses a repeating TEMPLATE outright with `blocked:H-REPEAT-SCHEDULE` ("its reminder is part of the repeat rule … change it in the app's repeat editor"), for every vector, before any dispatch — a reminderLESS template is still caught earlier by `H-NO-REMINDER`. Re-cert through the shipped fixed bundle: `things todo clear-reminder <RW>` → `BLOCKED (H-REPEAT-SCHEDULE)` exit 4.

---

## The fix (branch `mg/rrx1-rc-reminder`)

- **`src/model/recurrence.ts`** — (1) `RepeatRule.remainingCount` → **`occurrenceCount`** (the configured "ends after N" total; immutable; null = unlimited), with the header + field doc corrected to the RRX1 immutability law. (2) `templateStatus` now reads exhaustion from the CURSOR: `paused` → paused; a past `endDate` → ended; a **FIXED** rule with **no next occurrence** → ended (the app clears the cursor at exhaustion by count OR date); after-completion cursor-NULL stays `waiting` (a normal resting state), so the cursor test is fixed-gated. The dead `remainingCount === 0` branch is removed. Signature gains `nextOccurrence` (the CLI callers already pass full `RepeatingInfo`, so no call-site change).
- **`src/model/occurrences.ts`** — rename to `occurrenceCount`; the from-cursor projection cap is documented as the CONFIGURED TOTAL (it over-counts the tail by the already-spawned `icCount` for a partway ends-after series, because the pure rule math has no access to the template column — a bounded, benign over-estimate reachable only for horizon > 1, consistent with the file's best-effort-extrapolation contract; a tight fix would thread `icCount` into the projection — a read-model addition, see §Follow-ups).
- **`src/write/clear-reminder.ts`** — refuse a repeating TEMPLATE outright (evidence above); the generalized refusal subsumes the old forced-url-scheme block; dry-run + guard order preserved (reminderless template still → H-NO-REMINDER).
- **`src/write/repeat-rule.ts` / `src/write/promote-clone.ts`** — `remainingCount` → `occurrenceCount` (the reschedule-undo inverse's "ends: after N" mapping is unchanged in meaning — the total IS the "after N").
- Unit tests: `test/unit/recurrence.test.ts` gains the RRX1 blob fixtures (`ENDS_AFTER_3_DAILY`, `ENDS_ON_DAILY`, `ENDS_ON_PAST_DAILY`, verbatim byte shapes) + a `templateStatus` exhaustion matrix (exhausted ends-after → ended, active → waiting, past ends-on → ended, active ends-on → waiting, after-completion resting → waiting, paused wins). `test/engine/write-clear-reminder.test.ts` gains the template-with-reminder refusal (every vector/proxy state) + the reminderless-template H-NO-REMINDER case.

## Re-certification (fixed dist, shipped through the CLI on the rrx1-lab clone)

| cell | expected | observed |
|---|---|---|
| `todo show <EA>` (exhausted ends-after) | ended | `repeating: TEMPLATE, ended` ✓ |
| `todo show <EO>` (exhausted ends-on) | ended | `repeating: TEMPLATE, ended` ✓ |
| `todo show <EP>` (born-ended ends-on-past) | ended | `repeating: TEMPLATE, ended` ✓ |
| `todo show <RW>` / `<RC>` (active) | scheduled | `repeating: TEMPLATE, scheduled` ✓ |
| `upcoming --horizon 5` | EA/EB/EO/EP absent as dated occurrences; render as `‹ended›` resting rows; RC/RD/RW active | ✓ (`‹ended›` on all four bounded templates; active ones project) |
| `todo clear-reminder <RW>` | clean refusal | `BLOCKED (H-REPEAT-SCHEDULE)` exit 4 ✓ (was verify-fail exit 3) |

## Follow-ups (out of scope — a read-model addition, not covered here)

- **Projection tail over-count for a partway ends-after series (horizon > 1).** The true remaining = `occurrenceCount − rt1_instanceCreationCount`, and `icCount` is a template column not carried by the (rule-only) `RepeatRule`, so the pure projection over-estimates the tail by `icCount`. A tight fix threads the template's `icCount` into the projection (read one more column into the read path + clamp the horizon). Bounded/benign and only reachable at horizon > 1, so left as a documented limitation rather than an improvised read-model/wire change.
