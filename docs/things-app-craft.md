# Things 3 automation-surface craft — the engineering-appreciation catalog

The flattering twin of [things-app-oddities.md](things-app-oddities.md). Where the oddities doc is the report-ready bug list, this is the log of the genuinely **clever** engineering we found while probing the same surfaces — designs that handle a novel problem so cleanly most users would never notice there was a problem to handle, and the interesting edge cases this project routed through as a result. Every entry carries the same probe id / evidence pointer discipline as the oddities doc, so a note of appreciation to Cultured Code (or a design review of our own reader) can cite it precisely. This is craft, not bugs — anything that misbehaves belongs next door.

**Maintenance rule (part of every change):** record each newly discovered piece of app craft THE MOMENT it is found, with probe evidence — exactly as the oddities doc records each newly discovered bug/quirk.

**Environment / provenance.** Findings span two golden pins: the 3.22.11 campaigns (golden `things-lab-golden-v1`, probed 2026-07) and the 3.22.12 campaigns (golden `things-lab-golden-v2`, build 32212016, probed 2026-08-05). Each entry names its own version where it matters. Probe evidence is version-stamped and immutable per the [harness version-stamping policy](lab/harness.md); confirmations under a later golden live in the [assumption register](reference/assumption-register.md), never by editing the campaign docs. Companions: the [capability matrix](capability-matrix.md), the [reference compendium](reference/README.md), and [reference/timezones.md](reference/timezones.md) (the consolidated timezone-behavior map, most of whose entries are craft).

---

## 1. Derivation over storage — the render-time projection discipline

The load-bearing design choice, from which most of the rest follows: Things stores as little derived state as it can, and computes lists at **render time from the device wall-clock**. A day rollover, a timezone change, a completed-item sweep — none of them mutate a `TMTask` row. Whole categories of stale-state bugs are structurally impossible because there is no stored state to go stale.

### 1a. Logbook membership is a pure projection — no per-row "logged" bit

An item is *logged* (out of its live list, into the Logbook) when `status IN (2,3) AND stopDate ≤ boundary`, where `boundary = max(interval edge, manualLogDate)` from the `TMSettings` singleton. There is **no per-row swept flag**, and `log completed now` (the manual sweep) advances only `manualLogDate` — it **mutates zero task rows**. The elegance shows up in the corner cases:

- An item's `index`, `startBucket`, `reminderTime`, and every other column **survive the whole complete → sweep → reactivate cycle untouched**, because the sweep never wrote them in the first place — reopening a swept item drops it back into its live list in its original position with no repair pass needed.
- The same purity is what lets a single-app timezone shift stand in for a second synced device (§4): a rollover relaunch mutates only one opaque `TMMetaItem` day-cursor blob and **zero `TMTask` rows** (TIMEZ Z-ROLL-c).

Evidence: [reference/timezones.md](reference/timezones.md) §1 + [reference/glossary.md](reference/glossary.md) (log-boundary); plog1/A28/LOGNOW ([lab/plog1-research.md](lab/plog1-research.md)); HEADSORT/LOGSORT reopen-in-place observations ([lab/headsort-heading-lifecycle-reorder.md](lab/headsort-heading-lifecycle-reorder.md), [lab/logsort-logged-child-reorder.md](lab/logsort-logged-child-reorder.md)). Implementation mirror: [src/read/log-boundary.ts](../src/read/log-boundary.ts). (The one place the projection design bites — a stranded open child riding a logged project into the Logbook because the sweep can't reconcile it — is the oddities §6¾ report item; the projection is the *reason* no reconciliation pass exists to save it, which is itself the honest design trade-off.)

### 1b. Logbook day-grouping is viewer-local and render-time

The Logbook groups completed items by the local day of their `stopDate` UTC epoch, **computed in the viewer's current zone**. Two items completed at the same fixed instant group under "Today" in New York *and* under "Today" in Kiritimati (an 18-hour-ahead reinterpretation) — the `stopDate` bytes are byte-identical across every zone; only the bucketing moves. Because the day label is derived at render, never stored, the same synced instant labels itself correctly in every timezone with no per-device fix-up. [CERTIFIED byte+GUI]. Evidence: [reference/timezones.md](reference/timezones.md) §2, [lab/timez-evening-and-zones.md](lab/timez-evening-and-zones.md) Z-LOGVIEW (Things 3.22.12, golden-v2).

### 1c. Today-order reference-date cohorts — 18 months of coexisting cohorts, no launch normalization

Today's manual order is a two-level sort: `COALESCE(todayIndexReferenceDate, startDate, deadline) DESC, todayIndex ASC, uuid ASC` — items cluster into **entry-date cohorts** (the day each item entered Today), newest cohort on top, hand-ordered within a cohort. The craft is what the app *declines* to do: it **never normalizes `todayIndexReferenceDate` at launch**. A production library carries reference dates spanning **18 months** of coexisting cohorts, and the comparator still produces a stable, correct order over all of them — no migration, no daily rewrite, no "renumber Today" pass that would churn sync. (This is exactly the fact that broke our own naïve `(startBucket, todayIndex)` comparator until we matched the app's cohort model; live reconciliation then landed 393 = 393 exactly.) Evidence: [lab/today-order-research.md](lab/today-order-research.md); [atlas/schema-v26.md](atlas/schema-v26.md) (Today row); refined by [lab/banner1-research.md](lab/banner1-research.md) L5 (the stamp is the deadline/entry date, written at creation, invariant to a late first launch). Things 3.22.11, golden-v1.

### 1d. Evening is a date-anchored sub-placement of Today, so stale evening flags cannot present

"This Evening" (`startBucket=1`) is **inseparably bound to `startDate == the device's current local day`** on every surface — evening is a sub-placement of *Today*, and Today is always the wall-clock day. An evening item whose day has passed does not linger as a stale evening entry: it **rolls back into flat Today** (no "This Evening" section), and a future-dated evening item pins into Today/Anytime a day early rather than waiting in Upcoming. The design consequence is that an evening flag can never accumulate as a wrong-day artifact in the *presentation* — the render always re-derives placement against today. (The underlying `startBucket=1` byte is left in place when the day goes stale rather than cleared — see oddities §9n — but the render-time anchoring means it never *shows* as evening on the wrong day; the honest cost is that a reader keying on the raw column must suppress it exactly as the GUI does.) The same invariant is why no headless surface can write a dated-evening row (`startBucket=1` with a non-today `startDate`) — evening and a non-today date are mutually exclusive by construction (TIMEZ-NODATE). Evidence: [atlas/schema-v26.md](atlas/schema-v26.md) (`startBucket`, "This Evening expires daily"); [reference/timezones.md](reference/timezones.md) §4/§5, [lab/timez-evening-and-zones.md](lab/timez-evening-and-zones.md) Z-ROLL / TIMEZ-NODATE (Things 3.22.12, golden-v2); oddities §9n.

### 1d. Reminder liveness is ONE law, applied identically at read AND write time

The §9n stale-reminder rule (oddities §9n) has a flattering twin. A reminder renders (its bell + When-popover row) **only while `startDate ≥ today`**; once `startDate` goes strictly past, the app hides the bell but never *passively* clears the byte — pure render-time projection, again (§1). The craft is that the app applies the **same liveness predicate at WRITE time**: rescheduling a to-do carries its reminder forward **iff it was live**, and drops it if it was already stale — uniformly across URL, AppleScript, and the GUI's own When picker. So a reschedule cleanly garbage-collects exactly the dead reminders (the ones the GUI has already hidden) and preserves exactly the live ones the user can still see, with **no revival on any surface** and **no destroy of a live reminder** on a bare reschedule. It is visible right in the When popover: a stale reminder shows the empty **"+ Add Reminder"** affordance (so a committed reschedule writes no reminder → byte cleared), a live one shows the existing **"🔔 Reminder 6:00 PM ✕"** row (carried forward). The GUI is the canonical reference here and the two headless surfaces match it byte-for-byte — read-time and write-time liveness are the same law, which is exactly why this project can gate both its reader and its reschedule ops on the one `reminderIsLive(startDate, today)` predicate ([src/read/stage.ts](../src/read/stage.ts), consulted by [src/write/commands.ts](../src/write/commands.ts) `effectiveReminder`). [CERTIFIED byte+GUI]. Evidence: [lab/remrev-stale-reminder-reschedule.md](lab/remrev-stale-reminder-reschedule.md) (REMREV, Things 3.22.12, golden-v2); the passive-hide half is [lab/sit3-arrival-evening-lists.md](lab/sit3-arrival-evening-lists.md) REMSTALE + oddities §9n.

---

## 2. Guard rails that keep history from corrupting

The flip side of the projection design: where a derived boundary *could* be rewound by a setting or a clock, the app pins it at the moment of change so history cannot retroactively move.

### 2a. The settings-flip stamp guard — no preference change can rewind the Logbook boundary

The Logbook boundary is `max(interval edge, manualLogDate)`. The trap this avoids: flipping "Move completed items to Logbook" between Immediately / Daily / Manually could, naïvely, move the boundary *backward* and dump years of logged history back into the live lists. It cannot, because switching the setting **stamps `manualLogDate` at flip time** — the `max()` floor ratchets forward and never rewinds. A user toggling the preference sees no retroactive resurrection of old completed items. [CERTIFIED]. Evidence: [reference/timezones.md](reference/timezones.md) §1 (settings-flip stamp guard); observed during the HEADSORT/LOGSORT AX flips ([lab/headsort-heading-lifecycle-reorder.md](lab/headsort-heading-lifecycle-reorder.md), [lab/logsort-logged-child-reorder.md](lab/logsort-logged-child-reorder.md)). (One transition — Daily→Manually — is the single [UNPROBED] corner, flagged in timezones §1.)

### 2b. Cursor-keyed repeat materialization — a device ahead in time/zone never spawns a duplicate

When a device's effective "today" runs ahead (a pinned-ahead timezone, a fast clock, or a manual time-travel), the repeat engine materializes the next instance early **and advances the template's next-instance cursor and instance counter past that day**. The cleverness is the dedupe: when other devices — or the real day — later reach that date, the engine **dedupes on the advanced cursor** rather than re-materializing, so **no duplicate instance is ever created**. The cursor is a stored row value that Cloud sync replicates, so the guarantee holds across devices, not just within one. This is quiet multi-device timezone safety: the price is one instance pulled permanently forward (it is not rolled back when the clock reverses — oddities §9x), but never a double. Evidence: [lab/timez2-pinned-zone-workaround.md](lab/timez2-pinned-zone-workaround.md) T2-DEDUPE / T2-SIDEFX (Things 3.22.12, golden-v2); [reference/timezones.md](reference/timezones.md) §7 (bill #2), §8; oddities §9x.

### 2c. Deadline-nag suppression stores the *dismissed deadline*, so it re-arms if the deadline moves

Dismissing an overdue-deadline nag does not set a boolean "dismissed" flag — it stores the **dismissed deadline value** in `deadlineSuppressionDate`, and Today-membership suppression requires `deadlineSuppressionDate IS NULL OR < deadline`. The consequence is self-correcting: if the user later pushes the deadline *further out*, the stored suppression date is now `< deadline`, so the nag **re-arms automatically** — no separate "un-dismiss" step, and no way for a dismissal to silently swallow a genuinely new deadline. (In a live library all 12 deadline items absent from Today carried `deadlineSuppressionDate = deadline` exactly — the model closed the "deadline alone should pull into Today" reconciliation to 393 = 393.) Evidence: [atlas/schema-v26.md](atlas/schema-v26.md) (Today row: "stores the dismissed deadline; suppression requires `>= deadline`"); [lab/today-order-research.md](lab/today-order-research.md) (F-DL suppression: "a later deadline re-arms the nag"); oddities §8e (the dismissal is itself a reschedule side-effect, not a button). Things 3.22.11, golden-v1.

### 2d. Making an item repeat preserves the source in place whenever it holds finished work — a terminal element flips destruction to preservation

`make-repeating` normally *replaces* the source (hard-delete the old row, mint a fresh template + instance — identity replacement, §8g). But the app quietly makes an exception whenever the source carries **finished work**: if the subtree contains a **terminal element** — a completed/canceled child, or a **checked (completed) checklist item** anywhere — the source row is instead **kept and relinked in place as the current-occurrence instance** (only the template is minted fresh), so the completed history rides along on a surviving row rather than being destroyed. It generalizes cleanly across granularity — a checked checklist item counts the same as a completed child, and it preserves even alongside open siblings — unifying with the two structural preserve triggers (a to-do deadline; a project's nested repeater). The design intent is coherent: don't throw away a row that records something the user actually finished. Evidence: [lab/srcfate-reconciliation-sweep.md](lab/srcfate-reconciliation-sweep.md) (SF matrix, 14 cells 2/2; `replacedUuid=null` on every preserve); reconciles [lab/rsim-results.md](lab/rsim-results.md) §RSIM-R/T/U. Things 3.22.12, golden-v2.

### 2e. Convert-to-Project is lossless — checklist items become real sub-to-dos, notes ride along

Converting a to-do into a project doesn't discard the to-do's checklist (which a project can't hold) — it **promotes each checklist item into a real child to-do** of the new project, in order, and carries the notes across. Nothing the user typed is dropped in the transform; a flat checklist becomes a structured project the moment it outgrows a single to-do. (The row itself is an identity replacement — new project uuid, conversion-wall-clock creationDate — so external references to the old to-do dangle, the one caveat.) Evidence: [lab/srcfate-reconciliation-sweep.md](lab/srcfate-reconciliation-sweep.md) (CVT: 2 checklist items → 2 child to-dos, `TMChecklistItem` consumed, notes preserved). Things 3.22.12, golden-v2.

---

## 3. Cross-surface consistency and deep idempotency

Where a behavior is reachable from several surfaces (GUI, URL scheme, AppleScript, Shortcuts), the app is often more internally consistent than its documentation would suggest.

### 3a. Resolution-kind flips preserve `stopDate` on every surface, and re-resolving is a true no-op

Flipping an item between completed and canceled — in either direction, on a to-do or a project — **preserves `stopDate` byte-identically** on *every* write surface: URL `update`/`update-project`, AppleScript `set status`, and the GUI all behave identically (status changes, the completion instant is retained, `userModificationDate` bumps). Two further consistency properties make this deep rather than incidental: the flip is **sweep-invariant** (it behaves the same whether or not the item has crossed the Logbook boundary), and **re-resolving an already-resolved item is a true no-op — not even a `userModificationDate` bump.** So automation can re-assert a completion idempotently without generating a spurious sync delta, and the completion instant is never accidentally reset by a canceled↔completed correction. Evidence: [lab/backdt-project-backdating-and-flips.md](lab/backdt-project-backdating-and-flips.md) B-FLIP / B-FLIP2; [reference/README.md](reference/README.md) (BACKDT row: "Resolution FLIPs PRESERVE stopDate on every surface … re-complete = true no-op"). Things 3.22.12, golden-v2.

### 3b. `userModificationDate`-bump discipline — placement re-ranks stay silent, state changes bump

The app curates `userModificationDate` (`umd`) precisely enough to be usable as a sync-noise minimizer: a **pure placement re-rank** — a GUI drag within an Upcoming day-block, or the private `reorder` command writing a row's `todayIndex`/`index` — is **`umd`-silent** (byte-verified: one row, one column, `umd` untouched), while every genuine field write (`when=`, `deadline=`) and every containment reparent **does** bump it. The line is drawn where it matters: reordering is treated as non-user-modifying, so re-sorting a big list does not flood the sync change-log, whereas a real state change is always recorded. The reopen-on-reorder cases sharpen this — the `umd`-bump count per reorder equals exactly the number of members whose *status* actually changed (swept to-dos / archived headings that got reopened), never the number merely repositioned. (The one caveat this discipline imposes on us: a watcher diffing on `umd` alone will miss a pure re-rank — noted so our own change-detection doesn't rely on it.) Evidence: oddities §9r; [lab/tdrag-ax-residuals.md](lab/tdrag-ax-residuals.md) TDRAG-1/2/3 (Things 3.22.12, golden-v2); the `umd`-count laws in [lab/headsort-heading-lifecycle-reorder.md](lab/headsort-heading-lifecycle-reorder.md) / [lab/logsort-logged-child-reorder.md](lab/logsort-logged-child-reorder.md).

### 3c. The open-child reopen invariant is a coherent self-healing guard

Adding or moving an *open* child into a resolved (completed/canceled/logged) project — or, identically, under an archived heading — silently **reopens the container** (`status 3→0` + `stopDate→NULL`, byte-identical to the AppleScript un-archive). Read as a bug in isolation (oddities §5b/§5o) it is a surprising side effect; read as a system property it is a genuine invariant: through every ordinary add/move/reopen surface, the app **refuses to let an actionable item be stranded inside a resolved container** — the illegal (resolved-parent + open-child) state is simply not reachable, because any write that would produce it heals the parent instead. It is even protective for our own resolvers: `resolveHeadingRef` carries no status filter, yet cannot strand a child under an invisible archived heading, precisely because landing the child reopens the section (HEADARC — no PLOG1 cousin). The invariant has exactly one gap — GUI **Put Back** of a trashed open child, the single surface that skips the reopen — and that gap is the oddities §6¾ report item; the craft is that every *other* surface upholds the invariant uniformly. Evidence: oddities §5b/§5o/§5q; [lab/headarc-archived-heading-moves.md](lab/headarc-archived-heading-moves.md) (all four headless surfaces reopen with the identical byte delta); oddities §6¾ / [lab/headarc2-residual-captures.md](lab/headarc2-residual-captures.md) (the Put-Back gap).

### 3d. `set modification date` is a surgical, durable, reversible escape hatch — the complement to the umd-bump discipline

The AppleScript `modification date` property of a to-do/project is a genuinely writable, precise single-column setter, and the app treats it with real discipline: writing it changes **only** `userModificationDate` (full-row byte-diff on to-dos, projects, and logged rows shows every other column — `creationDate`, `stopDate`, `status`, `start*`, `cachedTags` — byte-identical), the written value **sticks across an app relaunch** (the app never opportunistically re-stamps it back to "now"), it accepts arbitrary past AND future instants, and it survives subsequent unrelated activity untouched. Paired with the umd-bump discipline (3b — placement re-ranks stay silent, real edits bump), this gives automation a complete **capture-and-restore** story: read `umd`, make a genuine edit (which bumps `umd`), then set `modification date` back to the captured value — leaving only the intended change, with the sync/`changes`-timeline tripwire returned to where it was. The one honest limit is resolution: the AppleScript `date` type is second-granular, so a restore lands on the floored second (a sub-second `.xxx` fraction cannot be reproduced) — always ≤ the original, which is the safe direction for a `changes --since` query. This is what makes a timeline-silent bulk tag-apply feasible (the umd cost that 3b's discipline does NOT spare — a tag write bumps every member; TAGMOD-T1). Evidence: [lab/tagmod-tag-area-umd.md](lab/tagmod-tag-area-umd.md) T5 (surgical byte-diffs, relaunch durability, the floored-second restore, the real set-tags→restore recipe); the umd-silent creation-date sibling in [lab/backdt-project-backdating-and-flips.md](lab/backdt-project-backdating-and-flips.md).

### 3e. Suspending a repeating series is non-destructive and reversible — Pause preserves the rule, Resume re-anchors instead of flooding

The two ways to stop a repeating series are both careful about not losing or dumping data. **Pause** (`Items ▸ Repeat ▸ Pause`) writes only `rt1_instanceCreationPaused 0→1` and clears the generation cursor `rt1_nextInstanceStartDate → NULL`, leaving the **rule blob and the anchor `rt1_instanceCreationStartDate` byte-unchanged** — so a paused series is fully recoverable, nothing about the schedule definition is discarded. **Resume** then **re-anchors to today**: it spawns *today's* occurrence and sets `next = today+1`, deliberately **NOT** replaying the periods skipped while paused — the user gets a clean pick-up, not a flood of back-dated occurrences. Even the cruder path is reversible: **trashing a repeating template** clears its cursor, but the GUI **Put Back in Inbox** restores the template AND its cursor (the series resumes), so a mis-trashed schedule is recoverable from the Trash. (The contrast that makes Resume's restraint visible: Put-Back restores the *old* past-dated cursor, so a template trashed-then-restored across several days WOULD back-fill on next launch — whereas Resume, the purpose-built control, re-bases on the resume day and never floods.) Evidence: [lab/serdel-series-removal.md](lab/serdel-series-removal.md) S2/S3 (pause byte-set, resume re-anchor spawn, Put-Back cursor restore). Things 3.22.12, golden-v2.

---

## 4. Sync designed as a merge, not a race

### 4a. Things Cloud is a timestamp-ordered 3-way merge, not last-writer-wins

Live-probed conflict resolution (two clones, one throwaway account) shows Cloud ("Syncrony") resolves **per-attribute**, and same-field text conflicts (notes, title) as a **timestamp-ordered 3-way merge** with a `--` separator — *not* last-writer-wins. Concurrent edits to the same field on two devices converge with **nothing dropped**; checklists merge as a **union**; a delete-vs-edit race loses no data. For a task manager whose whole value is trusting that a note typed on the phone won't be clobbered by an edit on the Mac, choosing merge semantics over the far simpler LWW is a real, user-invisible investment. It also composes cleanly with the derivation discipline above: because rollovers and zone changes write no rows (§1), two synced devices in different zones can legitimately *disagree about which day something is in* without that ever registering as a sync conflict — the disagreement is pure render, there is nothing to merge. Evidence: [lab/headless-research.md](lab/headless-research.md) §SYNC2; [reference/README.md](reference/README.md) (SYNC2 row); [reference/timezones.md](reference/timezones.md) §8. (The independently-materialized-repeat-instance corner is now verified — see 4c.)

### 4b. `userModificationDate` is merged data, not a protected sync clock

A subtle robustness choice, live-probed against the durable account (SYNC2B): Things Cloud carries `userModificationDate` as **ordinary per-attribute synced data** — a device can write a row's `umd` to an *older* value (even years back) and that lower value **propagates to every device and survives the round-trip**, never rejected, clamped, or re-bumped by the server. Most sync engines special-case a modification timestamp as a monotonic Lamport-style clock to break ties; Things instead lets the *content* changes ride the sync change-log independently, so `umd` is free to be a plain user-facing field. That is exactly what makes the `--preserve-modified` lever sound across sync — a mutation still reaches the other devices while its `umd` restore keeps it off the modification-date timeline everywhere — with the merge only re-bumping `umd` when the SAME row is genuinely edited on two devices at once (the §4a max-merge, which fails safe). Evidence: [lab/sync2b-durable-account.md](lab/sync2b-durable-account.md) SY-2/SY-2M.

### 4c. Independently-materialized repeat occurrences deduplicate across devices

The corner 4a left open, now verified and made precise (SYNC2B SY-3, refined by SYNC3 SY-3b). When two devices are each advanced past a repeating template's occurrence day **while disconnected from one another**, each independently materializes that occurrence — and, the crux, **each mints the IDENTICAL instance uuid for it** (`U8NHn3sSbJx5rGUmVrgRGB` on both, for the same template + occurrence day). The instance uuid is **deterministic** from the template lineage and the occurrence, not a per-device random id, so the two devices are not creating "two rows that must be deduped" — they are independently creating *the same row*. That is the real craft: the occurrence is given a canonical identity up front, which makes a duplicate structurally impossible rather than something a reconciler has to detect and clean up after the fact. On reconvergence there is simply an add/add on one uuid, resolved by Things Cloud's ordinary **per-attribute 3-way merge** — scalars to the greater value (`creationDate`/`userModificationDate` → MAX), free-text (`notes`) to a union — no duplicate, no ghost, no merge UI. For a multi-device user whose phone and Mac both roll into a new day before they next sync, this is the difference between "one to-do" and "two identical to-dos to reconcile by hand" every single day. (The surviving `creationDate` is `MAX(local-midnight)` — the later/western device's — and the SY-3 winner-tiebreak residual is now resolved: value-based, independent of reconnect order and device. §1/§4-zone craft explains why each device's midnight differs.) Evidence: [lab/sync2b-durable-account.md](lab/sync2b-durable-account.md) SY-3; [lab/sync3-dedupe-tiebreak.md](lab/sync3-dedupe-tiebreak.md) SY-3b.

### 4d. A one-time exception replicates across devices with no exception-specific sync code — and the user's edit outranks the other device's derivation

4c's deterministic occurrence identity has a second payoff that only shows up when the two devices *disagree*, and SYNCX1 drove exactly that disagreement. A `Make Exception` on device A does two things: it advances the template's cursor and watermark past the consumed slot, and it mints that slot's occurrence at the chosen date. Both halves are ordinary synced data — REPX3 §1.3 measured the template delta as **field-for-field identical to what an ordinary clock spawn of that slot writes**, and the minted row carries the **slot's** deterministic uuid even though it is dated a week away from the slot. Neither half is marked as "an exception".

That is the whole design, and it is why it works. A second Mac that receives the change does not have to understand anything: its spawner's only question is whether the slot is behind the watermark, and it now is, so **it produces nothing** when its clock reaches the vacated day (measured against two untouched controls spawning normally on the same clock roll). And a second Mac that got to the slot *first*, while disconnected, has already created a row with **the same uuid** — so reconvergence is an add/add on one record rather than two rows needing a reconciler, exactly as in 4c.

The interesting part is which side that merge keeps. The two claimants are asymmetric in a way that matters:

```
device A (Make Exception)   startDate 2026-07-14   creationDate 1783252967.59 (gesture)    umd 1783252967.597
device B (clock spawn)      startDate 2026-07-07   creationDate 1783382400.0  (midnight)   umd NULL
after the merge, on BOTH    startDate 2026-07-14   creationDate 1783252967.59              umd 1783252967.597
```

B's row was the **later arriver** (it stayed offline until after A had pushed) and carried the numerically **larger** `creationDate`, and it lost anyway — every contested attribute took A's value. What separated them is `userModificationDate`: a clock spawn is a derived materialization and is born unstamped, while an exception is a user edit and stamps it. So the merge's arbitration says *the person's deliberate act beats the machine's derivation*, regardless of which device is later or reconnects last — the same instinct as 4a's refusal of last-writer-wins, applied to a conflict between a human edit and an automatic one. For a two-Mac user this is the difference between "the appointment I moved stays moved" and "my laptop quietly put it back". (It also sharpens 4c's tiebreak: SY-3b's `creationDate` → MAX was measured on two *unstamped* spawns, i.e. a tie in the primary key; when the two sides' `umd` differ, `creationDate` follows the winner and can move down.) Evidence: [lab/syncx1-exception-sync.md](lab/syncx1-exception-sync.md) §2/§3. Things 3.23.

---

## 5. Ordering craft

The private `_private_experimental_ reorder` command and the `when=`/`deadline=` bounce family are, on the container surfaces, more principled than "experimental" suggests. (The *aggregate* specifiers — `list "Anytime"`, `list "Upcoming"`, `area` — carry the destructive side effects catalogued in oddities §9c/§9f/§9g; those are the bugs. This section is only the parts that are clean.) §5c is the GUI-side ordering primitive that outclasses all of them — and whose only flaw is that nothing tells the user it exists (oddities §20).

### 5a. `list "Tomorrow"` is a clean one-call, exact-order, minimum-write day sorter

`_private_experimental_ reorder to dos in list "Tomorrow" with ids "…"` re-ranks the entire next-day group on `todayIndex` in the **exact sent order**, in a single call, and — unlike its sibling `list "Upcoming"` — **preserves each row's `startDate`** (no destructive re-date). It accepts a scheduled area-less **project** uuid inline and re-ranks it in position (projects inherit `to do` in the sdef), and preserves `start`/`startBucket`/container FKs on every row. It is the one surface that turns "sort tomorrow exactly like this" into a single minimum-write dispatch rather than a park-sort-restore compound. Evidence: [reference/novel-paths.md](reference/novel-paths.md) #47; [lab/ordfin2-followups.md](lab/ordfin2-followups.md) Arm 2; the opposite-placement-law contrast with `list "Upcoming"` in [lab/ptmpl-project-templates.md](lab/ptmpl-project-templates.md) PTMPL-C. Things 3.22.11–3.22.12.

### 5b. The container-specifier reorder is deterministic and state-preserving, with a coherent anchor-stack protocol

On a *container* specifier (`reorder to dos in project id …` / `area …`) the command is deterministic and faithful — it re-ranks `index` (or `todayIndex`, date-preservingly) into the exact requested order and preserves the container FK. Its front-insert geometry is internally consistent enough to build exact-order protocols on: the `when=` bounce **front-inserts** a loose/area-direct member at the group `index` minimum and **back-inserts** a container child at the group end, both fully deterministic and both preserving `start`, the container FK, `reminderTime`, and `deadline` — so a reverse-order (front-insert) or forward-order (back-insert) leg sequence lands any target order exactly. `list "Someday"` even carries a distinct but coherent **anchor-stack** model (the call's original top item never moves; to-dos stack ascending, someday projects descending), which is unusual but self-consistent across the two-call protocol. The determinism is the craft — it is precisely what the aggregate specifiers lack. Evidence: [reference/novel-paths.md](reference/novel-paths.md) #1 (the private reorder + anchor-stack), #37 (SOMEBNC front/back-insert split), #48 (DAYBNC); [lab/reordgaps-results.md](lab/reordgaps-results.md) (SOMEBNC / BOUNCE2-h); oddities §9h (the containment-dependent re-entry direction, recorded there as an *inconsistency* note — clean and deterministic, just not uniform).

### 5c. The keyboard reorder writes ONE row — a sparse-index insertion that renumbers nothing and carries the subtree for free

With a heading row selected, `⌘↑`/`⌘↓` move it one slot and `⌘⌥↑`/`⌘⌥↓` move it to the top/bottom of the project's heading list. What makes it the cleanest ordering primitive we have measured anywhere — headless or GUI — is what the write consists of: **the moved row's `index` and nothing else.**

```
title  uuid8     idx        (after one ⌘↑ on K3, third of five)
K1     2d9pRAci  -497
K3     F8qma36g  -357   <- the only row rewritten (was -81)
K2     HnJhsJkd  -235
K4     LVC1TPST  -39
K5     3P9vmFQf  0
```

The app does not re-sequence the list; it picks a value in the gap between the two rows it is landing between and writes that. `index` is a sparse signed space precisely so that this is always possible, and the design pays off three times over. **No sibling heading is renumbered, and neither is any loose to-do in the project** — contrast the `when=` bounce, which achieves its placement by rewriting every row it did *not* move (BOUNCE2 §9h), and the private container reorder, which restates the whole order. **The moved heading's children are not touched at all** — byte-identical `index` values and a NULL project FK across the move, following the heading through its intact FK exactly as the cross-project move does (HEADXPROJ) — so reordering a section never disturbs the order *inside* it. And because one step is one row, each step is independently verifiable and independently reversible: the inverse chord is an exact inverse, which the bounce protocol conspicuously is not (its recovery leg front-inserts too, so an aborted bounce perturbs the order further rather than restoring it).

The boundary behaviour is equally deliberate. A chord with nowhere to go is **declined — zero delta and one alert beep**, not a wrap, not a silent no-op, and not a nudge into the neighbouring bucket. Validated 1:1: ten `⌘↑` chords fired at a bottom-selected heading produced four moves and exactly six beeps. A heading driven past the project's loose block captures nothing (the loose to-do's heading FK stays NULL), so the gesture cannot accidentally change membership. The one place a chord *does* change membership is a headed **child** driven past its bucket edge, which crosses into the adjacent heading with its `index` preserved — and that is the right answer too, since it is precisely what dragging the row does; it is a hazard for a *driver* (which must fence its chords at the bucket edge), not a defect in the app.

The bounded credit: this is the mechanism, not the affordance. Nothing in the app advertises the chords — no menu item, no context-menu item, no AX action, no key equivalent anywhere in the menu bar — which is the [oddities §20](things-app-oddities.md) report item. The engineering underneath is excellent and the way in is a secret. Evidence: [lab/headord1-heading-order.md](lab/headord1-heading-order.md) §1/§2 (HEADORD1, 2026-08-25; cells 1e / 1g1–1g4 / 1i2 / 1i3, null-controlled). Things 3.23, golden-v4.

## 6. Repeat craft in the 3.23 dialog

### 6a. `Create Next Copy` is a clean "spawn the pending occurrence now" — with the same bookkeeping the clock does

Things 3.23 adds `Items ▸ Repeat ▸ Create Next Copy` on a template. One press materializes the instance the cursor is pointing at AND advances the series exactly as the date's arrival would: the new row lands with the cursor's own `startDate` and its `rt1_repeatingTemplate` FK set, `rt1_instanceCreationStartDate` steps to the next occurrence, and `rt1_instanceCreationCount` increments. No dialog, no confirmation, no divergence between the manual path and the automatic one — the same state machine, just triggered by hand. It is the affordance a user who wants "do next week's one today" previously had to fake by editing dates. Evidence: [lab/rdlg2-323-recipe-cert.md](lab/rdlg2-323-recipe-cert.md) §5.2. Things 3.23.

### 6b. The occurrence pop-up is bounded, lazily generated, and semantically tagged

The redesigned `Next:` control (whose *cost* is oddities §11) is, as a piece of engineering, careful: rather than rendering an unbounded date list it shows a window of the rule's own occurrences and hangs the rest off cascading `More…` submenus, generated only as each level is reached — the AX tree shows populated levels ahead of the pointer and zero-frame placeholders beyond, about ten years out. Every occurrence item carries a shared `AXIdentifier` (`nextDateOptionAction:`) distinguishing it from the separator (`_popUpItemAction:`), which is a genuinely accessible way to say "these are the data rows" without depending on their localized titles. The preview line beside the rule (`",  7/12/26,  7/19/26, …"`) updates live as the rule is edited, so the dialog answers "what will this actually do?" before OK is pressed. Evidence: [lab/rdlg2-323-recipe-cert.md](lab/rdlg2-323-recipe-cert.md) §1.1. Things 3.23.

### 6c. The weekday set is stored deduplicated, so a transient duplicate row cannot corrupt a rule

The weekly dialog lets two rows name the same weekday, and the app simply collapses them on commit — the stored rule holds a SET. That is what makes a deterministic weekday drive possible without a remove gesture at all: overwrite surplus rows with a duplicate of a wanted day and the committed rule is exactly the wanted set. A dialog that instead stored the row list verbatim would have made every set-shrink a fragile removal dance. Evidence: [lab/rdlg2-323-recipe-cert.md](lab/rdlg2-323-recipe-cert.md) §2.4 + cell C12; [lab/vmq1-probe-closeout.md](lab/vmq1-probe-closeout.md) §2. Things 3.22.14 + 3.23.

### 6d. Checking off a future occurrence mints it just-in-time — one click, one coherent row, no phantom state

Things 3.23's Upcoming renders a repeating series as a single projection row at its next occurrence day. That row is not a real to-do — no `TMTask` exists for it — and yet it carries an ordinary checkbox, indistinguishable in the accessibility tree from any materialized row's. Clicking it does the only thing that could be right: the app **mints the occurrence and completes it in the same gesture**, then advances the series exactly as the clock would have.

```
INSERTED  status=3  stopDate=<the click>  startDate=2026-07-06 (the projection day)
          start=2   rt1_repeatingTemplate=<template>   leavesTombstone=1
CHANGED   template  rt1_nextInstanceStartDate     2026-07-06 -> 2026-07-07
CHANGED   template  rt1_instanceCreationStartDate 2026-07-06 -> 2026-07-07
CHANGED   template  rt1_instanceCreationCount     1 -> 2
```

The craft is in what is *not* there. The completed occurrence is a fully-formed instance with a real FK and a real occurrence date, so the Logbook shows the right thing on the right day rather than a "completed projection" special case. The cursor advances by exactly one period — the same bookkeeping `Create Next Copy` (§6a) and the launch-time spawner perform, so three different triggers converge on one state machine. And the series' **currently pending** occurrence is left byte-identical: completing next Tuesday's copy early does not silently consume today's. Two settle windows and a relaunch later the state is unchanged. A design that instead recorded "occurrence N is done" as template-side metadata would have needed a parallel completion model, a parallel Logbook path, and a reconciliation step; minting the row is strictly simpler and strictly more consistent. Evidence: [lab/repx1-instance-semantics.md](lab/repx1-instance-semantics.md) §1.3. Things 3.23.

### 6e. A bulk repeat action is one transaction, applying the single-target bytes per row

`Items ▸ Repeat ▸ Pause` on a three-template selection writes exactly the bytes a single-target pause writes — `rt1_instanceCreationPaused 0→1`, cursor cleared to NULL, anchor and rule blob untouched — **on each row, with the three `userModificationDate` stamps landing inside 50 µs of one another**. No confirmation, no partial application, no aggregate-specific side effect, and `Resume` inverts it precisely. The multi-selection path is not a re-implementation of the single-item path; it is the same write, looped inside one transaction. (Contrast the reorder family's *aggregate* specifiers, whose list-scope behavior genuinely diverges from their container-scope behavior — §5.) Evidence: [lab/repx1-instance-semantics.md](lab/repx1-instance-semantics.md) §5.3. Things 3.23.

### 6f. The Make-Exception chooser CONSUMES the rule slot — a real one-time exception, and it only offers the branches the rule could actually express

Editing the schedule of a series' **projection row** (the pseudo-row Upcoming renders at the template's cursor day) raises a *Repeating To-Do* alert: `Make Exception` / `Update Rule` / `Cancel`. The craft is in what `Make Exception` then does — not "copy the to-do to the new date", which is what every automation surface produces (oddities §13), but a genuine **move of the occurrence out of the schedule**:

```
INSERTED  status=0  startDate=<the chosen day>  rt1_repeatingTemplate=<template>
CHANGED   template  rt1_nextInstanceStartDate     2026-07-06 -> 2026-07-07   <- the slot is CONSUMED
CHANGED   template  rt1_instanceCreationStartDate 2026-07-06 -> 2026-07-07
CHANGED   template  rt1_instanceCreationCount     1 -> 2
```

When the clock reaches the vacated 07-06 slot, **nothing spawns** — measured against an identically-built series whose chooser was cancelled, which spawns on the same roll. The rule blob is untouched, the pending occurrence is untouched, and the series resumes its ordinary cadence at 07-07. One occurrence was moved; none was duplicated and none was lost. Getting that right needs the cursor and the materialized rows to be reconciled in exactly the way the instance-re-date path fails to (oddities §13) — the app has the machinery, it just does not reach it from the other row.

A second, quieter piece of care: **the chooser's branch set is a function of what the rule could express.** A calendar date offers three buttons ("…make a one-time exception, or update the repeating rule?"); a target the rule cannot name — the `Today` bucket, `Someday` — offers two, with copy that says so ("…make a one-time exception? This will not change its repeating rule."). Time-of-day makes no difference; five arms separate the variables. A dialog that offered `Update Rule` for "move this to Someday" would have had to either refuse on press or invent a meaning; not offering it is the honest design. (For a driver, the consequence is that the buttons must be addressed by title — `Cancel` is `action-button-3` in the three-button sheet and `action-button-2` in the two-button one.) Evidence: [lab/repx2-exception-chooser.md](lab/repx2-exception-chooser.md) §1.3/§1.5/§2.3. Things 3.23.

### 6g. The app's own ⌘Z fully reverses a just-in-time materialization — the cursor included

A projection check-off (§6d) writes in two places: it inserts a completed instance and it advances the series' cursor, watermark and count. Undo puts back **both**:

```
DELETED   the minted instance row                                  <- hard-deleted, not trashed
CHANGED   template  rt1_instanceCreationCount     2 -> 1
CHANGED   template  rt1_instanceCreationStartDate 2026-07-07 -> 2026-07-06
CHANGED   template  rt1_nextInstanceStartDate     2026-07-07 -> 2026-07-06
```

Net delta against the pre-gesture snapshot, after a relaunch: **no field changed on any surviving row**. The compound gesture has a true inverse, and it survives a restart — no tombstone residue, no "uncompleted" orphan sitting on a day the series never scheduled, no permanently skipped slot.

This is the entry with the sharpest lesson for us: it is a capability we structurally **cannot** match. Nothing on any official automation surface hard-deletes a single row (oddities §5i) and nothing writes the cursor columns backwards, so any op we built on this gesture would have to be irreversible and say so. The app can be this clean because it owns its own undo stack; we get to admire it. Evidence: [lab/repx2-exception-chooser.md](lab/repx2-exception-chooser.md) §4.3. Things 3.23.

### 6h. One natural-language date parser, shared by the GUI picker and the URL scheme

The 3.23 `When`/`Deadline` pickers are search fields, not calendars-first: typing filters to a single resolved row that names its own resolution (`in 11 days` → `Thu, Jul 16`), so the user always sees what the phrase became before committing. The same parser is evidently wired behind the URL scheme's `when=`: `things:///add?…&when=second tuesday in november` lands 2026-11-10, and `next thursday`, `in 3 days`, `july 9`, `next week` all resolve correctly — 6 of 6, none documented. A URL handler that accepted only its documented keywords plus ISO dates would have been perfectly defensible; routing it through the same parser the GUI uses means the two surfaces cannot drift. (For a *client* the read-back discipline is still mandatory — the resolution is clock- and locale-relative, and `next thursday` means the following week's, which is not everyone's first guess.) Evidence: [lab/repx2-exception-chooser.md](lab/repx2-exception-chooser.md) §1.2/§6.2. Things 3.23.

### 6i. One re-anchor implementation, reached from the GUI chooser and from the URL scheme — down to the byte

The `Update Rule` branch of the 3.23 repeating chooser and the URL scheme's dated `when=` on a template are not two code paths that agree; they are one. Give a daily series seeded 2026-07-05 a new anchor of 2026-07-09 through either route and the stored `rt1_recurrenceRule` is the **same 627-byte blob** (`sha256:b9a58999d5b4072c`), with the same five-column row delta around it. And "re-anchor" means the whole anchor, not a cursor pointer: a weekly Sunday rule moved to a Thursday becomes a Thursday rule, a monthly rule anchored on the 5th becomes anchored on the 17th, a yearly July-5 rule becomes a September-17 rule — the rule is recomputed from the target date rather than the cursor being nudged out of step with it, which is the difference between a series that has been rescheduled and one that has been left inconsistent. A deadlined rule keeps its deadline mode through the rewrite (the 4001-01-01 sentinel and the start offset both survive). The handler also short-circuits: asked to anchor a series to the date it is already anchored on, it writes nothing at all — no `userModificationDate` bump, no rule rewrite, no sync churn for a no-op edit. (Two things this entry deliberately does not admire: the same code path is *fatal* for a non-future target and for an after-completion rule — [oddities §1](things-app-oddities.md), [§15](things-app-oddities.md) — and the recomputation is destructive on a multi-weekday rule, [§16](things-app-oddities.md). The craft is the shared implementation and the idempotent short-circuit, not the envelope around them.) Evidence: [lab/reanch1-url-reanchor.md](lab/reanch1-url-reanchor.md) §2, §7. Things 3.23.

### 6j. Undo reverses BOTH chooser branches completely — down to restoring the rule's bytes and rewinding `userModificationDate`

§6g measured undo against a just-in-time check-off. Driven against the two branches of the *Repeating To-Do* chooser, it is just as complete, and in the `Update Rule` case it does something an undo very rarely bothers to do:

```
Make Exception, then ⌘Z
  DELETED  the minted exception row                                <- hard-deleted
  CHANGED  template  icCount 2 -> 1 ; watermark and cursor 07-07 -> 07-06 ; todayIndex and its ref date rewound
  and the slot is genuinely UN-consumed: rolling the clock onto it spawns normally,
  reissuing THE SAME uuid the deleted exception row had (instance uuids are slot-derived)

Update Rule, then ⌘Z
  CHANGED  template  rt1_recurrenceRule  sha256:b9a58999… -> sha256:3b34361c…   <- the ORIGINAL bytes, not an equivalent rule
  CHANGED  template  watermark + cursor + todayIndexReferenceDate  07-09 -> 07-06
  CHANGED  template  userModificationDate  1783252904.646 -> 1783252858.644477 <- REWOUND, not re-bumped
```

Both are durable across a relaunch, and both net to *no field changed on any surviving row* against the pre-gesture snapshot. Two details deserve the credit. Restoring the recurrence blob **byte-identically** means undo replays stored state rather than re-deriving a rule that merely behaves the same — the sync layer sees the original record, not a new one. And rewinding `umd` says the app models undo as *this edit did not happen*, rather than as a fresh compensating edit; that is the same lever our TAGMOD capture-and-restore recipe reaches for, applied by the app to itself.

The lesson from §6g still holds and gets sharper: an exception moves **two** independent cursor columns (one of which, `rt1_instanceCreationStartDate`, nothing shipped even reads), hard-deletes are unavailable to us, and no surface lets us restore a rule blob or rewind a template's `umd`. Evidence: [lab/repx3-chooser-residuals.md](lab/repx3-chooser-residuals.md) §4. Things 3.23.

### 6k. Upcoming says "Waiting" instead of inventing a date for a series that has none

An **after-completion** series has no calendar: its next occurrence is a function of a completion that may never happen, so there is genuinely no date to file it under. A list view that insists on sorting by day has to do *something* with such a row, and the tempting answers are all lies — park it on today, guess an interval from the last spawn, or hide it.

Things does none of them. While `rt1_nextInstanceStartDate` is NULL, Upcoming files the series in a trailing section headed **`Repeating To-Dos`**, outside the dated day-blocks entirely, and labels the row **`Waiting`**:

```
[38] AXRow  desc=Repeating To-Dos            <- a section header, not a date
[39] AXRow
       [4]  AXUnknown desc=‎CNCAC1-FRESH
       [10] AXUnknown desc=Waiting
```

The moment that occurrence is resolved the app anchors the series and derives a real cursor, and the same row moves into its proper day-block. So the rendering is a faithful function of the one column that carries the fact, with a distinct visual state for "no answer yet" rather than a fabricated one — the §1 derivation discipline applied to the hardest case it has, where the honest answer is *there isn't one*.

The credit is narrow and worth bounding: the row it draws there still carries a live checkbox, and checking it produces the [oddities §18](things-app-oddities.md) stranded copy. The *state modelling* is exactly right; only the affordance on top of it is not. Evidence: [lab/cncac1-after-completion-checkoff.md](lab/cncac1-after-completion-checkoff.md) §7.1/§7.4. Things 3.23.

---

## Edge cases this project routed through

Project-side context: the modeling problems the app's craft created for us. Brief by design — the app engineering above is the star; these are where we had to build to match it.

- **Dual-citizen ordering axes.** `index` and `todayIndex` are **independently writable** columns (`todayIndex` relative to `todayIndexReferenceDate`, re-sorted daily; `index` the flat sequence). A single row can be an ordered member of two axes at once — a deadline-forecast someday row carries a distinct non-zero `todayIndex` in its Upcoming day-block *and* a distinct `index` in its container, in opposite directions (oddities §9o). Our reader and reorder planner treat the axis as a function of the view, not the row. See [atlas/schema-v26.md](atlas/schema-v26.md) (`todayIndex`) and [lab/upcdl-deadline-axis.md](lab/upcdl-deadline-axis.md).
- **Heading lifecycle trinary.** A heading is not open-or-closed but **open / archived-unswept / archived-swept**, and the three states reorder, render, and reopen differently (HEADSORT). We model all three rather than collapsing to a boolean. See [lab/headsort-heading-lifecycle-reorder.md](lab/headsort-heading-lifecycle-reorder.md) and oddities §5o.
- **Repeating-template invisibility and the identity-replacement rule.** Templates are invisible to list reads but addressable by id (oddities §5e), their children look plain but are behaviorally template-owned (§8n), and "make repeating"/convert are **identity replacements** that mint a new uuid (§8g). We surface hidden-template content with an explicit marker (the `(↻ Project)` glyph on TTY, a flat `projectIsTemplate` sibling in JSON) so a search hit for the wrong twin is at least distinguishable — the fix oddities §8o asks Cultured Code for. See [lab/rsim-results.md](lab/rsim-results.md).
- **Multi-timezone modeling.** Because every list is derived against the device clock (§1) and no stored stamp satisfies every viewer, we thread the consumer's zone (`THINGS_TZ`/`tz`) through membership *and* label formatting, normalize date-only inputs to **noon in the effective zone** (robust across viewers where midnight slips a day), and fail closed on an invalid zone. See [reference/timezones.md](reference/timezones.md) §2/§6 and [src/model/dates.ts](../src/model/dates.ts).
