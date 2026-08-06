# Timezones — the timezone-sensitive-behavior reference

The consolidated map of every place a timezone (the app host's, a synced second device's, or a `things-api` consumer's `THINGS_TZ`) changes what Things stores, derives, or renders — with our known limitations and mitigation strategies. One section per behavior. Read this whenever a date label, a Today/evening write, a Logbook grouping, or a cross-device disagreement looks "off by a day."

**The load-bearing fact, up front:** Things stores `startDate`/`deadline` as **timezone-less packed integers** and `stopDate`/`creationDate` as **UTC epochs**, and derives *every* list (Today, This Evening, Upcoming, Logbook, overdue) at **render time from the device wall-clock** — it mutates **no `TMTask` row** on a day rollover or a zone change. So the same bytes render as different calendar days on two devices whose clocks differ, and no single stored stamp can satisfy every viewer. Everything below follows from that.

## Certification legend

Each section is tagged with the strength of its evidence:

- **[CERTIFIED]** — probed on the real app (byte-level DB + GUI/AS oracle) in a disposable VM, evidence banked and version-stamped.
- **[MODEL-DERIVED]** — deduced from certified primitives (the wall-clock derivation + row-purity proofs) but not directly probed in the exact scenario (usually because it needs true two-device sync, which is SYNC2-blocked — see the last section).
- **[UNPROBED]** — a named corner we have *not* yet confirmed; flagged so it is never mistaken for certified.

**Probe provenance.** The certified sections rest on two campaigns, both probed **2026-08-05** under **Things 3.22.12** (build 32212016), macOS 15.7.7, DB schema v26, golden `things-lab-golden-v2`, airgapped (no cloud account): the evening/zone campaign [lab/timez-evening-and-zones.md](../lab/timez-evening-and-zones.md) (#407, verdicts `Z-*` / `TIMEZ-*`) and the pinned-zone workaround campaign [lab/timez2-pinned-zone-workaround.md](../lab/timez2-pinned-zone-workaround.md) (#409, verdicts `T2-*`). Version *confirmations* under a later golden belong in the [assumption register](assumption-register.md), never by editing those immutable snapshots. Companion: the [glossary](glossary.md) log-boundary and `stopDate` entries; the [capability matrix](../capability-matrix.md); app quirks in [things-app-oddities.md](../things-app-oddities.md) §9n/§9w/§9x.

---

## 1. The log boundary (which resolved items are "logged")

**[CERTIFIED]** — evidence: [glossary](glossary.md) log-boundary entry; plog1/A28/LOGNOW; HEADSORT/LOGSORT flip observations; the Daily→Manually corner closed by RESID1 R-DAILYMAN ([lab/resid1-batched-residuals.md](../lab/resid1-batched-residuals.md)). Implementation: [src/read/log-boundary.ts](../../src/read/log-boundary.ts).

An item is *logged* (moved into the Logbook, out of its live list) when `status IN (2,3) AND stopDate ≤ boundary`, where `boundary = max(interval edge, manualLogDate)` from the `TMSettings` singleton. `logInterval` ∈ `0 = Immediately` · `1 = Daily` · `4 = Manually` (no weekly/monthly — oddities §8c). There is **no per-row "swept" bit** and the sweep **mutates zero task rows** — "logged" is a pure projection, which is why an item's `index` survives the whole complete → sweep → reactivate cycle.

Timezone sensitivity:

- **Daily edge is the VIEWER'S local midnight.** Under `logInterval = 1`, the interval edge is midnight *of the evaluating device's local day*. Our implementation threads the consumer zone so the edge is the CONSUMER'S local midnight (`THINGS_TZ`), not the host's — `dayBoundInstant(localToday(now, zone), "start", zone)`. Because nothing is written when a day passes, **two synced devices in different zones can legitimately disagree about Logbook membership at the same instant** ([MODEL-DERIVED] for the cross-device case — not yet cross-device probed; the single-device zone-threading is code-certified). `logInterval = 0` (Immediately, the golden default) is zone-independent: the boundary is `now`.
- **Settings-flip stamp guard [CERTIFIED].** Flipping the Settings interval **stamps `manualLogDate` at flip time** (observed during HEADSORT/LOGSORT AX flips), so changing the setting can never rewind the boundary and dump logged history back into live views.
- **The Daily→Manually forward-sweep corner [CERTIFIED] — the flip does NOT forward-sweep (RESID1 R-DAILYMAN, 2026-08-06, golden-v2 / 3.22.12).** The earlier prediction (a Daily→Manually flip stamps `manualLogDate` at flip time, forward-sweeping the day's still-pending window) is **FALSIFIED**. Probed directly: `logInterval` 0→1 (Immediately→Daily) stamps `manualLogDate` at flip time (the guard fires on *leaving Immediately*, whose boundary is `now`); three to-dos completed AFTER that stamp are pending; the subsequent 1→4 (Daily→Manually) flip leaves `manualLogDate` **byte-identical** (no re-stamp), so the pending window stays UNSWEPT (**preserved**). Refined law: **the Settings-flip stamp fires specifically when leaving "Immediately"; `manualLogDate` is otherwise a monotonic high-water mark advanced only to prevent a boundary rewind** — a Daily→Manually transition carries it forward unchanged and does not sweep the day's pending completions. Evidence: [lab/resid1-batched-residuals.md](../lab/resid1-batched-residuals.md) leg 3.

**Mitigation:** set `THINGS_TZ` to the consumer's actual zone so "logged today" matches what that consumer sees; do not assume Logbook membership is a global truth across devices.

## 2. Logbook day-grouping (which day a completed item files under)

**[CERTIFIED]** — evidence: [lab/timez-evening-and-zones.md](../lab/timez-evening-and-zones.md) **Z-LOGVIEW** (#407); this certifies byte+GUI what the schema atlas held model-derived.

The Logbook groups completed items by the **local day of their `stopDate` UTC epoch, computed in the VIEWER'S CURRENT zone** — a pure render-time derivation. Two items completed at `stopDate = 2026-07-05 16:00Z` group under **Today** in New York (Jul 5 noon local) *and* under **Today** in Kiritimati (Jul 6 06:00 local — an 18-hour-ahead reinterpretation of the same fixed epoch). The `stopDate` bytes are **byte-identical** across every zone shift; only the bucketing moves.

**Our rendering follows suit (mitigation + limitation closed).** The membership math (which items are in the Logbook) is already zone-correct in [src/model/clock.ts](../../src/model/clock.ts). But a JavaScript `Date`'s `getMonth`/`getFullYear`/`getDate` silently format in the **host** zone, so the TTY Logbook's month/year block headings and the blue logged-date chip used to mislabel a completion near local midnight for a `THINGS_TZ` consumer whose zone differs from the host. This is **fixed**: both `renderLogbook`'s block heading and `loggedDate` now resolve the `stopDate` instant's calendar day through the consumer zone via `instantDateIso(instant, zone)` ([src/model/dates.ts](../../src/model/dates.ts)), matching the app's viewer-local grouping. Locked by a two-direction regression fixture (a `stopDate` near local midnight rendered under a zone 14h ahead vs 11h behind lands in the correct — and different — month) in [test/cli/render.test.ts](../../test/cli/render.test.ts) ("logbook render-zone audit").

## 3. `when=today` / `when=evening` stamp the WRITING device's local day

**[CERTIFIED]** — evidence: [lab/timez-evening-and-zones.md](../lab/timez-evening-and-zones.md) **Z-TODAY / TIMEZ-CLOCK** (#407); reconfirmed symmetric in [lab/timez2-pinned-zone-workaround.md](../lab/timez2-pinned-zone-workaround.md) **T2-ENV / T2-REVERSE** (#409).

`when=today` stamps `startDate` = the **writing device's local calendar day** (the app-host clock). Under `Pacific/Kiritimati` (UTC+14, local 07-06) a `when=today` write stamped `startDate = 2026-07-06`; under base New York (local 07-05) the *same* command stamped `2026-07-05`. "today", "this evening", "tomorrow", and the Upcoming/Logbook day-grouping are all computed against the **device wall-clock**, never a stored zone.

**Consequence for a remote-zone caller.** A `things-api` consumer whose `THINGS_TZ` differs from the app host **cannot re-target its own local day** with `when=today` — the write lands on the *app host's* today, because the app host's clock is what stamps it. There is no `when=` argument that says "today in zone X." The correct fix is device-zone-correctness: `when=today`/`evening` mean *this device's* today/evening, so if the caller's evening is what matters, the app must run on a device whose clock is the caller's (or use the §7 pinned-zone workaround).

The write-side cross-midnight behavior (a `when=today` write that straddles the host's local midnight) is on the probe list but behaviorally follows the same law.

## 4. The dated-evening impossibility (TIMEZ-NODATE) + remote-zone caller table

**[CERTIFIED]** — evidence: [lab/timez-evening-and-zones.md](../lab/timez-evening-and-zones.md) **Z-SUB / Z-XDATE(a–e) / TIMEZ-NODATE** (#407).

Across **every** surface Things exposes, `startBucket = 1` (This Evening) is **inseparably bound to `startDate == the app's current local day`.** There is no write — URL, AppleScript, Shortcuts, or any two-step composition — that lands `startBucket = 1` with a `startDate` other than the device's today. Evening is a *sub-placement of Today*, and "Today" is always the device wall-clock day (§3). Apply a non-today date and the app clears the evening bucket (`sb := 0`); set the evening bucket and the app clamps the date to today.

This means a remote-zone caller whose local "today" is the app's *tomorrow* **cannot express "evening on my local today"** as a single evening write — the app would either put it in the app's This-Evening (today) or schedule it plain-dated for tomorrow (no evening). The two states — evening, and a non-today date — are mutually exclusive on every headless surface.

Per-vector capability, for such a caller (their local today = the app's tomorrow):

| Vector | Dated-evening? | What actually happens | Mitigation for the remote caller |
|---|---|---|---|
| URL `when=evening` | **NO** | `sb=1` + `startDate :=` the caller's device today | If the device clock/zone is the caller's own, "evening" already means *their* evening — set the device zone correctly (§3). No way to target another zone's evening. |
| URL `when=<date>@evening` (ISO) | **NO** | evening TODAY; ISO date discarded; spurious year→time reminder (oddities §9w) | Do not use — silently drops the date and adds a garbage reminder. |
| URL `when=tomorrow@evening` / `tomorrow evening` | **NO** | plain scheduled **tomorrow** (`start=2`), evening dropped (`sb=0`) | The closest honest primitive: schedules the item for the next day **without** evening. Accept "dated, not evening." |
| URL `when=<date>@HH:MM` | **NO** (dated + reminder) | `start=2`, that date, `reminderTime=HH:MM`, `sb=0` | The usable substitute for "evening on date D": schedule D with an evening-hour **reminder** (e.g. `@18:00`) — dated + a time cue, no evening bucket. |
| AppleScript `schedule … for <date>` | **NO** | `startDate` set, `sb=0` always | Same as a plain dated URL write; `activation date` is read-only (`-10006`); no `start bucket`/`evening` property is settable. |
| AS list `move`/`reorder "This Evening"` | **NO** | `-1728`, no such list | Not a surface — no Evening list exists in the closed list set. |
| Shortcuts `set-detail Start = …` | **NO** | text coerces to Anytime (`start=1`, no date/bucket) | Not a surface for dating or evening. |
| any two-step composition | **NO** | evening ⇔ non-today date are mutually exclusive | No composition escapes the invariant. |

**The `<date>@evening` year→reminder misparse (oddities §9w)** is worth calling out: `2026-07-06@evening` injects a spurious `reminderTime` whose HH:MM is the date's four-digit YEAR (`2026`→20:26, `2027`→20:27, `1945`→19:45) — the natural-language parser, told to find an evening time, misreads the ISO year as a clock time, then stamps This-Evening-today anyway. Never construct this shape.

**Summary.** A caller N hours ahead **CAN** schedule for the app's tomorrow (= their today) as a plain dated item, optionally with an evening-hour reminder as a cue, and **CANNOT** produce a true `startBucket=1` This-Evening item on any day but the writing device's own current day. A caller N hours behind sees an evening item another device wrote for *its* today as a **plain Today/Anytime item a day early** (no evening section, no moon) until their own clock catches up (§5).

## 5. Cross-zone rendering asymmetries (Z-ROLL)

**[CERTIFIED]** — evidence: [lab/timez-evening-and-zones.md](../lab/timez-evening-and-zones.md) **Z-ROLL(a/b/c)** (#407), via a real `settimezone` + clock-roll; DB bytes untouched throughout (only an opaque `TMMetaItem` day-cursor blob steps on a relaunch — no `TMTask` mutation).

When the viewer's local date moves relative to a stored evening item's `startDate`, the *presentation* changes even though nothing is written:

- **(a) Overdue evening — rolls back into flat Today.** An evening item (`sb=1, startDate=07-05`) viewed where the local date is now 07-06 (viewer's date > startDate) renders in a **flat Today with NO "This Evening" section** — the stale-evening presentation (§9n) under a real zone shift. Bytes byte-identical.
- **(b) Future evening — pins into Today/Anytime a day EARLY, not Upcoming.** The *same* evening item viewed where the local date is 07-04 (viewer's date < startDate) is a member of `list "Today"` AND `list "Anytime"` but is **absent from the Upcoming 07-05 block** — no moon marker. The `start=1` materialization pins it to Today/Anytime a day early. (Contrast: a `start=2` future row *does* render in Upcoming under its date — the difference is `start`, not `startBucket`.)
- **(c) Purity.** A pure zone change with the app closed is a **zero DB delta**; a rollover relaunch mutates only one opaque `TMMetaItem` day-cursor blob and **zero `TMTask` rows**. This purity is exactly what lets a single-app zone-shift stand in for a second synced device (§8).

**Mitigation / limitation:** these asymmetries are the app's own render behavior, not ours to fix — our reads report membership honestly per the consumer zone. The practical takeaway: an evening-bucketed item is a *Today* commitment that will appear a day early on a behind viewer and collapse into plain Today on an ahead viewer; it never waits in Upcoming.

## 6. Date-only → noon in the effective zone, and the effective-zone chain

**[CERTIFIED substrate · house convention]** — evidence: [lab/backdt-project-backdating-and-flips.md](../lab/backdt-project-backdating-and-flips.md) **B-DATEONLY** (#404); design: [resolution-timestamp-surface.md](../design/resolution-timestamp-surface.md) §5.

Both date-writing substrates lose intent at the day edges: `things:///json` **rejects** a bare date (no time), and an AppleScript date literal stamps **midnight**. Midnight can slip a day when re-read in another zone; **noon cannot** (noon decodes to the intended calendar date in every zone). So the engine normalizes any **date-only** value (from `--created-at` / `--completed-at`, or any date-only input) to **noon in the effective zone** — `zonedWallInstant(iso, 12, 0, 0, zone)` ([src/model/dates.ts](../../src/model/dates.ts)). The caller named a calendar *date*, so the caller's zone is the best proxy for intent, and noon maximizes the window in which every viewer reads back the intended day.

**The effective-zone resolution chain** (the same chain reads use for `meta.clock`):

1. a **per-call `tz`** (the MCP `tz` argument) — wins;
2. else **`THINGS_TZ`** (the CLI/MCP process env);
3. else the **embedding `zone` option** (a library caller's `ClockScopedRead`/write zone);
4. else the **process-local zone** — which *is* the app host's zone for a local CLI on the same Mac.

Invalid zones **fail closed** (an unknown IANA name throws `ClockError`, never a silent fall-back to the host). Because Logbook day-grouping is viewer-local anyway (§2), no single stamp satisfies every viewer — noon-in-the-caller's-zone is the honest maximizer.

## 7. The pinned-zone relaunch workaround — EVIDENCE-BACKED but NOT WIRED

**[CERTIFIED evidence · DEFERRED — not built]** — evidence: [lab/timez2-pinned-zone-workaround.md](../lab/timez2-pinned-zone-workaround.md) **T2-ENV / T2-EVE / T2-SIDEFX / T2-DEDUPE / T2-REVERSE** (#409). Parked behind [up-next.md](../up-next.md) §7 item 2 (disruptiveness deployment profiles).

TIMEZ proved dated-evening is impossible on every single surface (§4). TIMEZ2 certified the one mechanism that produces it — **quit Things → relaunch under a different effective timezone (so the app's "today" is the day the caller wants) → perform the evening write → quit → relaunch normally** — and priced its side effects. It is **fully evidence-backed but deliberately NOT wired into `things-api`**: app-restart cycles are untenable on a daily-driver workstation running Things alongside the tool, so it is deferred behind the parked **disruptiveness deployment profiles** item (a future `workstation` vs `dedicated-host` capability profile gating disruptive mutation classes). Documented here so the capability is not lost and so the price is on record.

```
quit Things
TZ=<ahead-zone> open -a Things3          # app adopts the pinned zone; system zone untouched
things:///update?id=<u>&when=evening      # → dated-evening on the shifted "today"
quit Things
open -a Things3                           # normal relaunch under the real zone
```

What the evidence establishes:

- **Per-process pin works [CERTIFIED, T2-ENV].** `TZ=<zone> open -a Things3` (and direct-exec of the app binary) **pin** the app's effective zone with the **system zone untouched** (Foundation's default zone honors `TZ` on Darwin). **`launchctl setenv TZ` does NOT** — an ssh session's launchd domain differs from the Aqua session's, so a GUI app spawned by LaunchServices never inherits it.
- **It produces the otherwise-impossible row [CERTIFIED, T2-EVE].** Under the ahead-pinned app, `when=evening` lands `startBucket=1` with `startDate` = the shifted day — a true dated-evening row, byte-identical after the reset (the derivations are pure).

The side-effect bill (the exact price beyond the intended row):

| # | Effect | Permanent? | Notes |
|---|---|---|---|
| 1 | The single `TMMetaItem` day-cursor blob advances to the shifted day, then steps back on the reset | **No** (self-correcting) | Round-trips cleanly; the backward step is tolerated with zero data effect. |
| 2 | Any repeating template whose next-instance date falls on the shifted day **materializes its instance early** and advances its cursor + counter | **YES** — the reset does NOT undo it | The real cost: a daily repeat pulls tomorrow's instance forward permanently (umd-silent). Cursor-keyed **dedupe** means no duplicate when the real clock later arrives (T2-DEDUPE). |
| 3 | A shared per-template "horizon" packed-date column advances on all repeat templates | Persists (bookkeeping) | umd-silent; benign. |
| 4 | **Nothing else** — no `start 2→1` promotions, no reminder machinery, no user-row re-ranks, no `TMTask` rewrites | — | The shifted launch does not touch user data beyond materializing due repeat instances. |

Preconditions & caveats a caller must be told:

1. **Quit first.** The pin only applies to a **fresh spawn**; `TZ=… open` on an already-running app silently no-ops (activation only).
2. **A repeat due on the shifted day is pulled forward permanently** (bill #2) — pick a shifted day with no repeat due, or accept the early instance (it self-dedupes when the real clock arrives — oddities §9x).
3. **The dated-evening row renders a day EARLY on the writing device** — `start=1` puts it in flat Today/Anytime immediately, NOT held in Upcoming (Z-ROLL-b). It presents as a proper This-Evening item only once *this* device's own clock reaches the target date. Inherent to `startBucket=1` (evening is a sub-placement of Today); unavoidable while keeping the evening bucket.
4. **No reminder is attached** (the evening bucket carries none) — a silent Today member until viewed.

**Net:** operationalizable and low-cost for a caller who genuinely needs a dated This-Evening item, but gated behind a deployment profile because the quit/relaunch cycle disrupts a live workstation.

## 8. The two-synced-devices model — certified vs SYNC2-blocked

**[MODEL-DERIVED bridge · one CERTIFIED-blocked hole]** — evidence: the purity + wall-clock laws below are CERTIFIED; genuine 3-way sync merge is blocked by SYNC2 (no cloud account in the lab).

**True two-device sync is BLOCKED (no cloud account — SYNC2).** Every cross-device claim in this doc is **modeled** from single-app zone-shift evidence plus the no-row-mutation proofs. The load-bearing bridge, all certified:

- the app derives every list from the **device wall-clock** (§3, TIMEZ-CLOCK);
- it mutates **no `TMTask` row** on a rollover or a pure zone change (§5c, Z-ROLL-c) — only an opaque day-cursor blob;
- `startDate`/`deadline` are stored **timezone-less** and `stopDate`/`creationDate` as **UTC epochs**;
- the repeat engine's dedupe key is a **stored row value** that sync replicates (§7, T2-DEDUPE).

So two synced devices holding **byte-identical rows** but running different local clocks each *render* those rows through their own local date — which is exactly what a single app does when its clock/zone is moved. The zone-shift experiment is therefore a faithful stand-in for the second device.

**What this model certifies (with high confidence):**

- Two devices in different zones can legitimately disagree about **Today membership, This-Evening presentation, Upcoming placement, and Logbook day-grouping** — none of it rewrites a row, so nothing "conflicts."
- An evening item written on device A appears on a behind device B as a plain Today/Anytime item a day early (§5b), and rolls into flat Today on an ahead device (§5a) — no row is rewritten by these transitions.
- A repeat instance materialized early on one device dedupes on the advanced cursor when another device's clock reaches that day (§7) — no duplicate.

**The one thing the model CANNOT show [SYNC2-blocked]:** a genuine **3-way sync merge** of two *independently* materialized instances (e.g. both devices materialize the same repeat occurrence before syncing). That requires a live cloud account and stays blocked. Note separately that Things Cloud conflict resolution for *content* fields is a **timestamp-ordered 3-way merge, not last-writer-wins** (SYNC2, [lab/headless-research.md](../lab/headless-research.md)) — relevant if two zones edit the same field, but orthogonal to the derivation behaviors above (which never write on rollover).

**Mitigation:** treat Today/evening/Logbook membership as **per-viewer**, never global; set `THINGS_TZ` to the consumer's real zone; and remember that a "disagreement" between two devices about which day something is in is correct behavior, not corruption.

---

## Quick reference — what to set, what to expect

- **Set `THINGS_TZ`** (or MCP `tz`) to the consumer's actual IANA zone whenever the CLI/MCP host is not in that zone — it makes Today/evening/Upcoming/Logbook boundaries *and* the rendered date labels evaluate for the consumer's calendar. Invalid zones fail closed.
- **`when=today`/`evening` writes stamp the app HOST's day**, not `THINGS_TZ` — device-zone-correctness is the only real fix (§3); a remote zone's evening is unreachable without the deferred §7 workaround.
- **A date-only completion/creation stamp lands at noon** in the effective zone (§6) — robust across viewers.
- **Logbook labels and the logged-date chip now render in the consumer zone** (§2) — the host-zone formatting bug is fixed and regression-locked.
- **Dated-evening is impossible on every headless surface** (§4) — use a dated item + evening-hour reminder as the honest substitute.
