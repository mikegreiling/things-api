# TIMEZ — the evening substrate, cross-date/cross-zone evening writes, and zone-shifted derivations

Certifies the **two-devices-two-timezones** model: whether a remote-zone caller (whose local "today" is the app's *tomorrow*) can write **This-Evening on a non-today date**, how the app stamps `when=today` under a shifted zone, and how the app *derives* Today/Upcoming/Logbook placement when the viewer's local date moves relative to a stored `startDate`/`stopDate`. Feeds a planned `docs/reference/timezones.md`.

ONE disposable offline Tart clone (`timez-lab`, run **2026-08-05**, golden **`things-lab-golden-v2`** · **Things 3.22.12** (build 32212016) · macOS **15.7.7** Sequoia · DB schema **v26** · airgapped, **no cloud account**). Base clock pinned **2026-07-05 12:00** in a KNOWN base timezone **America/New_York** (UTC−4 DST → the pinned instant is **2026-07-05 12:00Z** exactly, a clean UTC-noon anchor for the zone math). Writes go ONLY through official surfaces (URL scheme, AppleScript, the golden's Shortcuts proxies). **Timezone changes use `systemsetup -settimezone`** (an official macOS surface); day-boundary rolls use `sudo date` (the RSIM-S small-increment recipe). All clock/TZ changes happen in the VM ONLY, never the host. Ground truth = guest read-only SQLite (raw bytes + decoded) + the AppleScript list oracle + VNC framebuffer screenshots (This-Evening / Upcoming / Logbook groupings are custom NSViews — BANNER1 oracle-limits). Fixtures fully synthetic (`TZ-*`). Script: [`lab/scripts/research-timez.sh`](../../lab/scripts/research-timez.sh) (subcommands `setup`/`zsub`/`zxdate`/`zxas`/`zxlist`/`zxsc`/`zxcompose`/`ztoday` + interactive verbs `tz`/`clock`/`relaunch`/`url`/`as`/`full`/`rows`/`sql`/`dbdump`/`shot`/`pull`/`teardown`). Date codec is the library's (`y<<16|m<<12|d<<7`; `reminderTime = hour<<26|minute<<20`) — **no hand-packed integers**: `07-04`=132805120, `07-05`=132805248, `07-06`=132805376. Evidence (gitignored, synthetic): `lab/artifacts/timez-lab/` (`report.txt`, `snaps/*.png`, `*.dump`, `state.env`).

**Status: RAN + BANKED. Evidence only — NO wiring, NO CHANGELOG.**

> **Honesty constraint — true two-device sync is BLOCKED (no cloud account, SYNC2).** Every cross-device claim below is MODELED from single-app zone-shift evidence + the no-row-mutation proofs (TIMEZ-ROLL-c). The load-bearing bridge: the app derives every list from the **device wall-clock** (TIMEZ-CLOCK) and mutates **no `TMTask` row** on rollover/zone change (TIMEZ-ROLL-c), and `startDate`/`stopDate` are stored as timezone-less packed-date / UTC-epoch values. So two synced devices holding byte-identical rows but running different local clocks would each *render* those rows through their own local date — which is exactly what a single app does when its clock/zone is moved. The zone-shift experiment is therefore a faithful stand-in for the second device; the one thing it cannot show is a genuine 3-way sync *merge* (that stays SYNC2-blocked).

## Verdict table

| Leg | Question | Verdict |
|---|---|---|
| **Z-SUB** | golden-v2 substrate re-confirm | **HOLDS.** URL `when=evening` on an anytime to-do → `start=1, startBucket=1, startDate=app-today`; `when=today` → `start=1, startBucket=0, startDate=app-today`. (Evening writes also stamp `todayIndexReferenceDate=132804992` = 2026-07-03, a fixed non-today reference; today writes stamp `tiRef=today`. Immaterial to placement, noted for completeness.) |
| **Z-XDATE(a)** URL `when=` sweep | does ANY `when=` string yield `startBucket=1` with `startDate ≠ today`? | **NO — and the parser splits three ways.** The **`evening` keyword forces `startDate:=app-today`** and discards any co-present ISO date (→ `sb=1`, today). The **word `tomorrow`+evening** lets the DATE win (→ `start=2`, tomorrow, **`sb=0`**, evening dropped). A **date+explicit-time** (`@HH:MM` / `THH:MM`) keeps the date + sets a reminder, `sb=0`. **No shape produces dated-evening.** Plus a parser bug: `<ISO-date>@evening` injects a **spurious reminder whose HH:MM is the date's YEAR digits** (oddity §9w). |
| **Z-XDATE(b)** AppleScript | can any AS write produce `sb=1` with `startDate≠today`? | **NO.** `schedule <todo> for <date>` sets `startDate` to any date but `startBucket` stays **0** (never evening); `activation date` is **read-only** (`-10006` on set); no `start bucket`/`today section`/`evening` property is settable (`-2740`/`-1700`). |
| **Z-XDATE(c)** AS list target | is there an Evening list to `move`/`reorder` into? | **NO.** `move … to list "This Evening"` and `… "Evening"` both **`-1728`** (no such list), zero DB delta; `reorder to dos in list "This Evening"/"Evening"` likewise `-1728`. `every list` = the closed P9a set (Inbox, Today, Tomorrow, Anytime, Upcoming, Someday, Later Projects, Logbook, Trash, +areas) — **no Evening list exists.** (Re-confirms SIT3 SPECLIST for the `move` verb + golden-v2.) |
| **Z-XDATE(d)** Shortcuts | does `set-detail Start = <evening/dated value>` work? | **NO — degrades to Anytime.** `things-proxy-set-detail {detail:"Start", value:"This Evening"|"Evening"|"Tomorrow"|"2026-07-06"|"Tomorrow Evening"}` all land `start=1` (Anytime), **`startDate` NULL, `sb=0`** — the text→When coercion fails silently (same class as the `set-detail Reminder Time`/`Parent` text-coercion deaths, scf). No date, no bucket. |
| **Z-XDATE(e)** compositions | can a two-step land dated-evening? | **NO — evening and a non-today date are MUTUALLY EXCLUSIVE.** schedule-tomorrow → `when=evening` **re-stamps `startDate:=today`** (tomorrow lost, `sb=1`); `when=evening` → `when=tomorrow` **resets `sb:=0`** (date wins). Holds for URL-then-URL, AS-then-URL, and the `list "Tomorrow"` reorder (which never confers a bucket). |
| **Z-TODAY** | which calendar day does `when=today` stamp from a shifted zone? | **The GUEST LOCAL calendar day.** Under `Pacific/Kiritimati` (UTC+14, local date 07-06), `when=today` stamped `startDate=2026-07-06` = the device local date. **App-host-clock law** (TIMEZ-CLOCK) — the model's cross-device bridge. |
| **Z-ROLL(a)** overdue evening | evening item viewed where local date > startDate | **Rolls back into Today PROPER.** After `settimezone Pacific/Kiritimati` (local 07-06) the evening item (`sb=1, startDate=07-05`) renders in a **flat Today with NO "This Evening" section** (snap `zroll-today-0706`); `startBucket`/`startDate` bytes **byte-identical** (REMSTALE §9n under a real zone shift). The 07-06-dated sweep rows arrived → banner "16 new to-dos". |
| **Z-ROLL(b)** future evening | evening item viewed where local date < startDate | **Stays in Today/Anytime — does NOT drop into Upcoming, no moon marker.** Rolled back to 07-04, the evening item (`start=1, sb=1, startDate=07-05`) is a member of `list "Today"` AND `list "Anytime"` but is **absent from the Upcoming 07-05 block** (snap `zroll-upcoming-0704`; AS oracle). The `start=1` materialization pins it to Today/Anytime a **day early**, without the evening section. A `start=2` future row (contrast) DOES render in Upcoming under its date. |
| **Z-ROLL(c)** purity | does day-rollover / zone-change mutate ANY row? | **NO `TMTask` mutation — the derivation is PURE.** A pure `settimezone` change (app closed) = **zero DB delta**. A rollover *relaunch* under the advanced local date mutated **exactly one opaque `TMMetaItem` BLOB** (the app's internal day-cursor: `…07ea7280…`→`…07ea7300…`) and **ZERO `TMTask` rows** (full-dump diff). |
| **Z-LOGVIEW** | Logbook day-grouping under a zone shift | **VIEWER-LOCAL, render-time.** Two items completed at `stopDate = 2026-07-05 16:00Z` group under **Today** in NY (Jul 5 noon local) and under **Today** in Kiritimati (Jul 6 06:00 local) — an 18-hour eastward jump moved the local completion day forward Jul 5→Jul 6 and the Logbook honored it (rather than freezing at Jul 5 / showing "Yesterday"). `stopDate` bytes **byte-identical** across all shifts. Grouping is a pure derivation from the fixed UTC epoch bucketed in the **viewer's current zone**. |

---

## The core answer — is there ANY dated-evening vector?

**NO.** Across every surface Things exposes, **`startBucket=1` (This-Evening) is inseparably bound to `startDate == the app's current local day`.** There is no write — URL, AppleScript, Shortcuts, or any two-step composition — that lands `startBucket=1` with a `startDate` other than the device's today. Evening is a *sub-placement of Today*, and "Today" is always the device wall-clock day (TIMEZ-CLOCK). The moment a non-today date is applied, the app clears the evening bucket (`sb:=0`); the moment the evening bucket is set, the app clamps the date to today.

This is the **TIMEZ-NODATE** law and it is the certification the maintainer wanted: the two-devices model does not need a dated-evening primitive because none exists on the platform — a remote-zone caller cannot express "evening on my local today = the app's tomorrow" as a single evening write; the app would either put it in *the app's* This-Evening (today) or schedule it plain-dated for tomorrow (no evening).

### Z-XDATE(a) — the URL `when=` vocabulary, exact rows

Each: a fresh anytime to-do, one `things:///update?id=…&when=<STR>`. `today`=2026-07-05, `tomorrow`=2026-07-06.

| `when=` string | `start` | `startBucket` | `startDate` | `reminderTime` | Net |
|---|---|---|---|---|---|
| `evening` | 1 | **1** | **07-05 (today)** | — | This-Evening today (control) |
| `2026-07-06@evening` | 1 | **1** | **07-05 (today)** | **1369440256 = 20:26** | evening TODAY; ISO date **discarded**; spurious year→time reminder |
| `evening 2026-07-06` | 1 | **1** | **07-05 (today)** | 1369440256 = 20:26 | same (order-independent) |
| `2026-07-06 evening` | 1 | **1** | **07-05 (today)** | 1369440256 = 20:26 | same |
| `tomorrow@evening` | **2** | 0 | 07-06 (tomorrow) | — | DATE wins, evening DROPPED (Upcoming, no bucket) |
| `evening@tomorrow` | **2** | 0 | 07-06 | — | same |
| `tomorrow evening` | **2** | 0 | 07-06 | — | same |
| `2026-07-06@20:00` | 2 | 0 | 07-06 | 1342177280 = 20:00 | plain scheduled-tomorrow + reminder, no bucket |
| `2026-07-06T20:00` | 2 | 0 | 07-06 | 1342177280 = 20:00 | same (ISO-T tolerated) |
| `someday@evening` | 2 | 0 | — | — | Someday, evening ignored |
| `anytime@evening` | 1 | 0 | — | — | Anytime, evening ignored |

Two disjoint parser behaviors for "a date + evening": the **literal word `tomorrow`** is consumed as the schedule date and `evening` is dropped (`start=2`, tomorrow, `sb=0`); an **ISO `YYYY-MM-DD`** is *discarded for scheduling* and `evening` wins (`sb=1`, today) while the ISO **year** leaks into a garbage reminder. Neither yields `sb=1 + startDate≠today`.

**The year→reminder misparse (oddity §9w), confirmed by varying the year:** `2027-07-06@evening` → `reminderTime=1370488832 = 20:27`; `1945-07-06@evening` → `1322254336 = 19:45`. The reminder HH:MM tracks the four-digit **year** (`20|26`→20:26, `20|27`→20:27, `19|45`→19:45) — the parser reads `2026` as a clock time `20:26` when the `evening` keyword tells it to look for an evening time, then stamps This-Evening-today anyway. A spurious reminder the user never asked for.

### Z-XDATE(b)/(c)/(d)/(e) — the other surfaces, all closed

- **AppleScript.** The sdef `activation date` is `access="r"` — a `set` throws `-10006 "Can't set activation date"`. The only date-writing verb is `schedule <todo> for <date>` (`cocoa key activationDate`), which sets `startDate` to any date but leaves `startBucket=0` (probed clean: `schedule … for ((current date)+1*days)` → `start=2, startDate=07-06, sb=0`). No `start bucket`/`today section`/`evening`/`scheduled bucket` property exists to set.
- **AS list target.** No Evening list — `move`/`reorder … to list "This Evening"` and `… "Evening"` both `-1728`, zero delta; `every list` is the closed P9a set.
- **Shortcuts `set-detail Start`.** Every text value (`This Evening`, `Evening`, `Tomorrow`, `2026-07-06`, `Tomorrow Evening`) coerces to nothing usable → `start=1` (Anytime), no date, no bucket. The Shortcuts Things "When" text-coercion is as dead here as it is for `Reminder Time`/`Parent` (scf).
- **Compositions.** `when=<date>` then `when=evening` → evening re-stamps `startDate:=today` (`sb=1`, tomorrow lost). `when=evening` then `when=<date>` → date wins, `sb:=0`. `list "Tomorrow"` reorder after a tomorrow schedule leaves `sb=0` (the tomorrow list carries a `todayIndex` sort, never a bucket). Every path collapses to one of the two mutually-exclusive states.

---

## Z-TODAY / Z-ROLL / Z-LOGVIEW — the zone-shift derivations

**TIMEZ-CLOCK (app-host-clock stamping).** `when=today` stamps the **guest device's local calendar day**: under `Pacific/Kiritimati` (UTC+14, local 07-06) `startDate=2026-07-06`; under base NY (local 07-05) `startDate=2026-07-05`. So the *same* `when=today` command yields *different* `startDate`s on two devices in two zones — each stamps its own local day. This is the whole cross-device model in one fact: "today", "this evening", "tomorrow", and the Upcoming/Logbook day-grouping are all computed against the **device wall-clock**, never a stored zone.

**TIMEZ-ROLL (rollover derivations, via real `settimezone` + clock-roll).**
- **(a) overdue evening** (viewer local date > `startDate`): eastward `settimezone` to local 07-06 collapses the 07-05 evening item into **flat Today, no This-Evening section** — the §9n stale-evening presentation, now shown under a genuine zone change; DB bytes untouched.
- **(b) future evening** (viewer local date < `startDate`): rolled back to 07-04, the evening item's `start=1` materialization **pins it to Today/Anytime a day early** (it is in `list "Today"`/`list "Anytime"`, ABSENT from the Upcoming 07-05 block, no moon marker). A `start=2` future row would instead sit in Upcoming under its date — the difference is `start`: `start=1` (the evening/Today commitment) never demotes to Upcoming, `start=2` (Someday+future) is the Upcoming representation.
- **(c) purity**: a pure `settimezone` with the app closed = zero DB delta; a rollover relaunch mutates only one opaque `TMMetaItem` day-cursor BLOB and **zero `TMTask` rows**. The derivation is pure with respect to user data — which is what lets the single-app zone-shift stand in for a second synced device (a device receiving these rows over sync would render them through its own clock without rewriting them).

**TIMEZ-LOGVIEW (viewer-local day-grouping).** The Logbook groups completed items by the **local day of their `stopDate` UTC epoch computed in the viewer's CURRENT zone**. Same items (`stopDate 2026-07-05 16:00Z`) → "Today" in NY (Jul 5 local) and "Today" in Kiritimati (Jul 6 local, an 18h-ahead reinterpretation of the fixed epoch); `stopDate` bytes never change. This certifies (byte + GUI) what the schema atlas held model-derived — "Logbook grouping into days happens at render time" — and pins it as *viewer-local*, the sweep/boundary analog for the Logbook viewer.

---

## Remote-zone caller capability table

For a caller whose device is **N hours ahead/behind** the reference such that their **local "today" = the app's tomorrow** (they want to write *their* today's evening, which the app sees as a non-today date). Per vector — CAN it express *dated evening* (This-Evening on a date ≠ the device's own today)?

| Vector | Dated-evening? | What actually happens | Mitigation for the remote caller |
|---|---|---|---|
| URL `when=evening` | **NO** | `sb=1` + `startDate:=` **the caller's device today** | If the caller's DEVICE clock/zone is their own, "evening" already means *their* evening — set the device zone correctly (TIMEZ-CLOCK). There is no way to target *another* zone's evening. |
| URL `when=<date>@evening` (ISO) | **NO** | evening TODAY; ISO date discarded; spurious year→time reminder (§9w) | Do not use — silently drops the date and adds a garbage reminder. |
| URL `when=tomorrow@evening` / `tomorrow evening` | **NO** | plain scheduled **tomorrow** (`start=2`), evening dropped (`sb=0`) | This is the closest honest primitive: it schedules the item for the next day **without** evening. Accept "dated, not evening". |
| URL `when=<date>@HH:MM` | **NO** (but dated + reminder) | `start=2`, that date, `reminderTime=HH:MM`, `sb=0` | The usable substitute for "evening on date D": schedule D with an evening-hour **reminder** (e.g. `@18:00`) — dated + a time cue, no evening bucket. |
| AppleScript `schedule … for <date>` | **NO** | `startDate` set, `sb=0` always | Same as a plain dated URL write; no evening. |
| AppleScript list `move`/`reorder "This Evening"` | **NO** | `-1728`, no such list | Not a surface. |
| Shortcuts `set-detail Start = …` | **NO** | text coerces to Anytime (`start=1`, no date/bucket) | Not a surface for dating or evening. |
| any two-step composition | **NO** | evening ⇔ non-today date are mutually exclusive (evening re-stamps to today; a date resets the bucket) | No composition escapes the invariant. |

**Summary for a caller N hours ahead (their today = app tomorrow):**
- **CAN**: schedule for the app's tomorrow (= their today) as a plain dated item, optionally with an evening-hour **reminder** (`when=<tomorrow>@18:00`) as an evening *cue*. Write `when=today`/`when=evening` and have it land on **their device's** today/evening **iff the device's own clock/zone is theirs** (TIMEZ-CLOCK) — the correct fix is device-zone-correctness, not a dated-evening write.
- **CANNOT**: produce `startBucket=1` (a true This-Evening item) on any day other than the writing device's own current day. "This Evening" is definitionally *this device, this day's* evening; it cannot be addressed for a remote zone or a future date on any surface.

**Summary for a caller N hours behind (their today = app yesterday):** symmetric. An evening item another device wrote for *its* today will, on the behind device, appear as a **plain Today/Anytime item a day early** (no evening section, no moon — Z-ROLL-b), not in Upcoming; once the behind device's clock catches up to that date it presents as normal This-Evening while `startDate==that device's today`, then rolls into Today-proper the next day (Z-ROLL-a). No row is ever rewritten by these transitions (Z-ROLL-c).

---

## App oddities filed

- **§9w (new)** — `things:///update?when=<YYYY-MM-DD>@evening` (and `evening <date>` / `<date> evening`) **discards the date, stamps This-Evening TODAY, and injects a spurious `reminderTime` whose HH:MM is the date's four-digit YEAR** (`2026`→20:26, `2027`→20:27, `1945`→19:45). The natural-language `when=` parser, told to find an "evening" time, misreads the ISO year as a clock time. A user asking for "evening on a date" gets neither the date nor a wanted reminder. (Z-XDATE(a).)
- **Note (not a new bug — consolidates §9n under a zone shift):** the This-Evening / stale-evening presentation (§9n) and the Logbook/Upcoming day-grouping are **viewer-local render-time derivations from the device wall-clock**, and neither a day-rollover nor a `settimezone` change mutates any `TMTask` row (only an opaque `TMMetaItem` day-cursor BLOB updates on relaunch). Recorded here (TIMEZ-ROLL-c / TIMEZ-LOGVIEW) and in the assumption register.

## Reproduce

```sh
VNCDO=<vncdotool> TART_HOME=/Volumes/Workspace/tart \
  bash lab/scripts/research-timez.sh setup        # clone golden-v2 + boot(--vnc-experimental) + airgap + base TZ + pin 07-05 + helpers
  bash lab/scripts/research-timez.sh zsub          # Z-SUB substrate control
  bash lab/scripts/research-timez.sh zxdate        # Z-XDATE(a) URL when= vocabulary sweep
  bash lab/scripts/research-timez.sh zxas          # Z-XDATE(b) AppleScript schedule / activation-date
  bash lab/scripts/research-timez.sh zxlist        # Z-XDATE(c) move/reorder to an Evening list
  bash lab/scripts/research-timez.sh zxsc          # Z-XDATE(d) Shortcuts set-detail Start
  bash lab/scripts/research-timez.sh zxcompose     # Z-XDATE(e) two-step compositions
  bash lab/scripts/research-timez.sh ztoday Pacific/Kiritimati   # Z-TODAY cross-zone stamping
  # Z-ROLL / Z-LOGVIEW driven with the interactive verbs:
  bash lab/scripts/research-timez.sh dbdump roll-base
  bash lab/scripts/research-timez.sh tz Pacific/Kiritimati ; bash lab/scripts/research-timez.sh relaunch
  bash lab/scripts/research-timez.sh dbdump roll-tz-relaunch ; bash lab/scripts/research-timez.sh pull roll-base ; …  # diff dumps
  bash lab/scripts/research-timez.sh url 'things:///show?id=today' ; bash lab/scripts/research-timez.sh shot zroll-today-0706
  bash lab/scripts/research-timez.sh relaunch 070412002026 ; bash lab/scripts/research-timez.sh url 'things:///show?id=upcoming' ; bash lab/scripts/research-timez.sh shot zroll-upcoming-0704
  # Z-LOGVIEW: complete TZ-LOG-A/B, `log completed now`, screenshot Logbook in NY then Kiritimati
  bash lab/scripts/research-timez.sh teardown
```

All headless legs need no Accessibility; the GUI legs use the VNC framebuffer (`--vnc-experimental`). Timezone/clock changes are VM-only. Fixtures are synthetic `TZ-*`; the golden is never mutated (disposable clone).
