# REMREV — does rescheduling an item with a STALE reminder REVIVE it, per surface?

Feeds a maintainer policy ruling: *"rescheduling something whose reminder already did its job should NOT revive the reminder; if a surface revives as a side-effect we correct it after-write unless the user explicitly opts in."* REMREV settles whether any write surface (URL / AppleScript / GUI When-picker) revives a **stale** reminder on reschedule, and the inverse hazard — whether a bare reschedule **destroys** a **live** future reminder. It also confirms the shipped write-side machinery (`effectiveReminder` auto-preserve + the §9n `reminderIsLive` no-resurrection guard, [src/write/commands.ts](../../src/write/commands.ts)) against the real app across all three surfaces.

ONE disposable offline Tart clone (`remrev-lab`, run **2026-08-06**, golden **`things-lab-golden-v2`** · **Things 3.22.12** (build 32212016) · macOS **15.7.7** Sequoia · DB schema **v26** · airgapped, **no cloud account**). Clock pinned **2026-07-05 12:00** BEFORE Things launched, then rolled **+1d → 2026-07-06 12:00** with the app CLOSED (RSIM-S small-increment law; clock-rolls in the VM ONLY, never the host) to **stale** the seeded reminders. Writes go ONLY through official surfaces (URL scheme, AppleScript `schedule`, the GUI When picker driven via the golden-v2 AXVM1 Accessibility grant — `Items ▸ When…` by-name menu click + synthesized keystrokes). Ground truth = guest read-only SQLite (raw bytes + decoded) + VNC framebuffer screenshots (the reminder **bell** and the When-popover **reminder row** are custom NSViews — invisible to the AX tree, BANNER1 oracle-limits). Fixtures fully synthetic (`RR-*`). Dates/reminders SEEDED via URL `when=` / `when=<date>@<time>` (the app packs the int) — **no hand-packed integers**. Date codec is the library's (`y<<16|m<<12|d<<7`; `reminderTime = hour<<26|minute<<20`): `07-05`=132805248, `07-06`=132805376, `07-08`=132805632, `07-10`=132805888, `07-12`=132806144; `18:00`=1207959552, `09:00`=603979776, `23:00`=1543503872. Script: [`lab/scripts/research-remrev.sh`](../../lab/scripts/research-remrev.sh) (subcommands `setup`/`caps`/`seed`/`roll`/`fix`/`gui-when` + verbs `url`/`rawurl`/`as`/`one`/`rows`/`full`/`sql`/`shot`/`esc`/`dbdump`/`pull`/`teardown`). Evidence (gitignored, synthetic): `lab/artifacts/remrev-lab/` (`report.txt`, `snaps/*.png`, `db-remrev-final.sqlite`, `dumps/remrev-final.dump`).

**Status: RAN + BANKED. Evidence only — NO wiring, NO CHANGELOG.** (The shipped write machinery already implements the correct policy; REMREV CONFIRMS it against the app and refines the app-behavior corpus.)

## Headline verdicts

- **No surface revives a stale reminder.** Rescheduling a §9n-stale-reminder to-do to a future date CLEARS the `reminderTime` byte on **every** surface — URL, AppleScript, and the GUI's own When picker. There is no revival to correct after-write; the app already does the right thing.
- **GUI canonicity: the GUI CLEARS (never revives).** GUI-verified mechanism: for a stale reminder the When popover shows **"+ Add Reminder"** (the empty state — §9n has already hidden the byte), so committing a reschedule writes *no* reminder → the byte is cleared. Clearing is therefore **app-canonical**; the URL and AppleScript surfaces agree with the GUI byte-for-byte.
- **RR-LIVE inverse hazard does NOT occur.** A bare reschedule (no `@time`) of a **live** future reminder to another future date PRESERVES the reminder byte-identically on all three surfaces — the When popover shows the existing **"🔔 Reminder 6:00 PM ✕"** row and carries it forward. No preserve-reminder compound is needed for the dated form.
- **Unified law (the app applies §9n at WRITE time):** a reschedule preserves the reminder **iff it was LIVE** (`startDate ≥ today`, i.e. still rendered per §9n) at reschedule time; a **STALE** reminder (`startDate < today`, GUI-hidden) is **dropped**. Proven independent of the Today→Upcoming (`start` 1→2) transition by the RR-DISC discriminator. The write side mirrors the read side (`reminderIsLive`).

## Per-surface verdict table

Stale fixtures seeded `add?when=2026-07-05@18:00` (start=1, startDate 07-05, reminderTime 18:00), then rolled to 07-06 → §9n-stale. Live fixtures seeded `add?when=2026-07-10@18:00` (start=2, startDate 07-10 future, reminderTime 18:00) → still live at 07-06.

| Surface | Reschedule vector | STALE-reminder byte | Bell after | LIVE-reminder byte (RR-LIVE) |
|---|---|---|---|---|
| **URL** | `update?when=<future date>` | **CLEARED** (18:00 → NULL) | none — no revival | **PRESERVED** (18:00 kept) |
| **URL** | `update?when=<date>@09:00` | replaced with the **new** 09:00 reminder (explicit) | bell = the new reminder | — |
| **URL** | `update?when=today` | **CLEARED** (and `startDate` stayed stale 07-05, `start`=1) | none | — |
| **AppleScript** | `schedule … for <future date>` | **CLEARED** (18:00 → NULL) | none — no revival | **PRESERVED** (18:00 kept) |
| **GUI** | `Items ▸ When…` picker, type a future date | **CLEARED** (18:00 → NULL) | none — no revival | **PRESERVED** (18:00 kept) |
| **Shortcuts** | Edit-Items *When* | not probed (scoped out) — see below | — | — |

---

## RR-FIX — control: the §9n stale collapse under golden-v2

Pre-roll (clock 07-05, `startDate == today`) all five stale fixtures rendered a **🔔 bell** in Today (`snaps/preroll-today.png`). After the roll to 07-06 (`startDate` 07-05 now `< today`) every stale fixture collapsed to a plain Today row with **no bell** (`snaps/fix-today.png`) while its `reminderTime`=1207959552 stayed **byte-identical** across the roll — the §9n law (oddities §9n / SIT3 REMSTALE) reproduces on **golden-v2 / Things 3.22.12**. The read-model check holds: `reminderIsLive(07-05, 07-06)` = false (stale, dead), `reminderIsLive(07-10, 07-06)` = true (live).

## RR-URL — the URL scheme reschedule

| fixture | vector | before | after |
|---|---|---|---|
| RR-SF-URLD | `update?when=2026-07-08` | start=1 sd=07-05 **rem=18:00** | start=2 sd=07-08 **rem=NULL** (cleared) |
| RR-SF-URLT | `update?when=2026-07-08@09:00` | start=1 sd=07-05 rem=18:00 | start=2 sd=07-08 **rem=09:00** (new, explicit) |
| RR-SF-TODAY | `update?when=today` | start=1 sd=07-05 rem=18:00 | start=**1** sd=**07-05** (unchanged) **rem=NULL** (cleared) |

- **`when=<date>` CLEARS the stale reminder** (the §9n write-time drop) and moves the row to Upcoming (`start` 1→2, `startDate`→07-08). No revival: the row shows no bell on 07-08.
- **`when=<date>@<time>` sets a NEW reminder** (09:00 = 603979776), overwriting the stale one — an explicit reminder, not a revival. On 07-08 this row alone renders a bell (in-frame in `snaps/gui-*-popover.png`, "8 Wednesday" block).
- **`when=today` sub-finding:** on a stale-`startDate` Today member (`start=1`) `when=today` is a **schedule no-op** (BANNERACK: `startDate` stays 07-05, `start` stays 1 — the app treats an already-Today row as already-today) YET it still **clears the reminder** and bumps `userModificationDate`. So the reminder drop is not gated on the schedule actually moving; the write consults the reminder's (dead) presentation state regardless.

## RR-AS — the AppleScript `schedule` reschedule

`schedule to do id <RR-SF-AS> for ((current date) + 2 * days)` (→ 07-08): start=1 sd=07-05 **rem=18:00** → start=2 sd=07-08 **rem=NULL**. AppleScript `schedule` **CLEARS** the stale reminder exactly like the URL vector. **No revival** — the GUI shows no bell on the rescheduled row.

## RR-GUI — the GUI's own When picker (canonicity verdict)

Selected RR-SF-GUI (`things:///show?id=…` + activate), opened the When popover via the AX by-name menu click `Items ▸ When…`, typed `July 8, 2026`, pressed Return: start=1 sd=07-05 **rem=18:00** → start=2 sd=07-08 **rem=NULL**. **The GUI CLEARS the stale reminder.**

**GUI-verified mechanism (`snaps/gui-UuNazmTgni72wScFZyx3om-popover.png`):** the stale reminder's When popover shows the **"+ Add Reminder"** empty affordance — the app has already discarded the stale byte at the presentation layer (§9n), so the popover model carries *no* reminder. Committing a new date therefore writes "no reminder" and the DB byte is cleared. This is the canonical reference: **clearing is app-canonical**, and the headless URL/AS surfaces match it byte-for-byte. (The maintainer's live-prod oracle — the popover "reads simply Today, no reminder row" — is the same empty state.)

> Mechanics note: `V key "super-s"` (Cmd-S) proved unreliable under vncdotool — the modifier dropped and the bare `s` leaked into Quick Find ("sjuly 8, 2026"). The reliable path is the AXVM1 by-name menu click `Items ▸ When…` (the tdrag arm4-drive path), then type + Return.

## RR-LIVE — the inverse hazard (does a bare reschedule DESTROY a live reminder?)

| fixture | vector | before | after |
|---|---|---|---|
| RR-LF-URL | `update?when=2026-07-12` | start=2 sd=07-10 **rem=18:00** | start=2 sd=07-12 **rem=18:00 (KEPT)** |
| RR-LF-AS | `schedule … for +6 days` (07-12) | start=2 sd=07-10 rem=18:00 | start=2 sd=07-12 **rem=18:00 (KEPT)** |
| RR-LF-GUI | When picker → `July 12, 2026` | start=2 sd=07-10 rem=18:00 | start=2 sd=07-12 **rem=18:00 (KEPT)** |

**No destroy.** All three surfaces PRESERVE a live future reminder across a bare reschedule (byte-identical). **GUI-verified mechanism (`snaps/gui-Jx9MsLdeuZdXcf82xTg9iq-popover.png`):** the live reminder's When popover shows the existing **"🔔 Reminder 6:00 PM ✕"** row (contrast the stale popover's "Add Reminder" empty state), so the reschedule carries it forward to the new date. This CONFIRMS ORD-6/R21 ("bare `when=<date>` preserves `reminderTime`") — and now pins that preservation as **liveness-gated**: it holds for a live reminder; a stale one is dropped.

## RR-DISC — the discriminator: liveness, not the Today→Upcoming transition

To rule out "the clear is really about *leaving Today* (`start` 1→2)" rather than *staleness*, one extra fixture: `RR-DISC-TODAY` = `add?when=today@23:00` at clock 07-06 → **live** reminder on a **Today** row (`start`=1, `startDate`=07-06=today, rem=23:00). Rescheduled forward via `update?when=2026-07-12`: `start` **1→2**, `startDate` 07-06→07-12, **rem=23:00 KEPT** (byte-identical).

A live reminder survives the `start` 1→2 transition. So the governing variable is **reminder liveness (§9n `startDate ≥ today`)**, NOT the Today→Upcoming/`start` transition. The RR-SF rows cleared because their reminder was *stale*, not because they left Today.

## Reconciliation with the shipped machinery + the corpus

- **The shipped write side is CONFIRMED correct against the app.** `effectiveReminder` ([src/write/commands.ts](../../src/write/commands.ts)) auto-preserves a live reminder across a bare `when=` reschedule and — via the §9n `reminderIsLive` guard — returns `null` (no re-append) for a stale one so it is NOT resurrected. REMREV shows the *raw app* already: (a) drops the stale byte on a dated/`today` reschedule (so the library's no-resurrect matches the app — the byte was going to clear anyway), and (b) preserves a live byte on a dated reschedule (so the library's auto-preserve re-append is a harmless same-value no-op for the dated form). The two load-bearing outcomes (stale→clear/no-resurrect; live→preserve) are now app-confirmed across URL, AS, and GUI.
- **Refines the "bare `when=` CLEARS" belief.** The `effectiveReminder` comment cites "a bare `when=` CLEARS an existing reminder (R07/R20)". REMREV pins this per-spelling: `when=<date>` does **not** clear a **live** reminder (it preserves — R21), and clears a **stale** one; `when=today` cleared the (stale) reminder here (schedule no-op) — its effect on a *live* reminder is un-probed (the auto-preserve re-append makes it safe either way); `when=evening` clears (R07/§9n manufacture note, certified elsewhere; not re-probed here). The blanket "bare when= clears" is really the *keyword* forms + the *stale* dated form; the *dated live* form preserves.
- **Refines §9n's "nothing ever clears the stale byte".** §9n established that no **passive** event clears a stale `reminderTime` (day-rollover/arrival, banner OK). REMREV adds: an **explicit reschedule write** DOES clear it — a reschedule is the one operation that garbage-collects a stale reminder byte (because it rewrites the schedule from the app's *presented* reminder state, which §9n has emptied).
- **The §9n stale state IS manufacturable against the app via a clock-ROLL.** Register row RD-1 notes a stale-`startDate` row is "unmanufacturable headlessly at the pinned clock" (past-date URL writes clamp to today, BANNERACK) — true for a **single-pinned-clock `lab:regress`** run, but REMREV (like SIT3 REMSTALE) reproduces it with a **seed-then-roll** harness step (seed a reminder for day D, quit, roll the VM clock to D+1). So RD-1's write-side no-resurrection can be locked against the *actual app* by a roll/UI certification, not only by unit pins.

## Shortcuts — scoped out (rationale)

The Shortcuts *Edit-Items ▸ When* path (`things-proxy-set-detail`) was **not probed**: it re-prompts consent per run for the mutating classes (oddities §5j; it rides a human consent-absorb sitting, never `lab:regress`), so it is not "cheap". It ultimately drives the same app scheduling primitive as the URL/AS/GUI surfaces — all three of which agree — so it is expected to inherit the identical §9n write-time liveness law. A dedicated consent-absorb confirmation is a low-value residual.

## App oddities / craft filed

- **§9n addendum (reschedule is the write that clears a stale reminder; the app applies §9n liveness at write time).** An explicit reschedule (`when=<date>`/`today`, AppleScript `schedule`, GUI When picker) CLEARS a stale `reminderTime` and PRESERVES a live one — the same `startDate ≥ today` liveness the GUI uses to hide/show the bell, now applied at WRITE time, uniformly across surfaces. Recorded in [things-app-oddities.md](../things-app-oddities.md) §9n.
- **Craft entry (write-time liveness = read-time liveness).** The app's reschedule carries forward exactly the reminders it would still *render* and drops exactly the ones it has already *hidden* — a single coherent liveness law spanning read and write, visible in the When popover's "Reminder 6:00 PM ✕" vs "Add Reminder" states. Recorded in [things-app-craft.md](../things-app-craft.md).

## Reproduce

```sh
VNCDO=/abs/path/to/vncdo TART_HOME=/Volumes/Workspace/tart \
  bash lab/scripts/research-remrev.sh setup     # clone golden-v2 + boot + airgap + pin 07-05 + warm
  bash lab/scripts/research-remrev.sh caps       # de-risk AX + VNC
  bash lab/scripts/research-remrev.sh seed        # RR-SF-* (stale-to-be) + RR-LF-* (live) fixtures
  bash lab/scripts/research-remrev.sh roll        # quit + clock -> 07-06 + relaunch (stale the seeds)
  bash lab/scripts/research-remrev.sh fix         # RR-FIX control: bell gone, bytes kept
  bash lab/scripts/research-remrev.sh url 'things:///update?id=<u>&when=2026-07-08'   # RR-URL
  bash lab/scripts/research-remrev.sh as  'tell application "Things3" to schedule to do id "<u>" for ((current date) + 2 * days)'  # RR-AS
  bash lab/scripts/research-remrev.sh gui-when <u> 'July 8, 2026'    # RR-GUI (canonicity)
  bash lab/scripts/research-remrev.sh one <u>     # read a single byte row anytime
  bash lab/scripts/research-remrev.sh teardown
```

Fixtures are synthetic `RR-*`; the prod REMSTALE repro is described only from the maintainer's observation, never copied.
