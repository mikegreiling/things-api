# CNCAC2 — the after-completion deadline, lifted and certified through the shipped verb

**Version stamp:** `things-lab-golden-v4` · Things **3.23** (CFBundleVersion **32300036**, direct-download channel) · macOS **15.7.7 (24G720)** · `Meta.databaseVersion` **27** · airgapped clone, guest clock pinned **2026-07-05 12:00 (a Sunday)** and never rolled (the 2026-07-18 trial wall is never approached) · AXVM1 accessibility grant baked · both #597 lab escapes exported. Campaign run 2026-08-28, unattended, over **one** clone in two passes (see §2). Immutable snapshot per the [harness](harness.md) version-stamping policy.

Driver: [`lab/scripts/research-cncac2.sh`](../../lab/scripts/research-cncac2.sh) (cells selected by `CELLS=…`; `REUSE=1` attaches to a live clone). Fixtures fully synthetic (`CNCAC2-*`). Artifacts: `lab/artifacts/cncac2-lab{,-pass2}/` (gitignored) — `report.txt`, per-gesture full-row snapshots in `snap/`, per-command CLI output in `log/`.

**DB oracle:** every gesture is bracketed by a **full-row snapshot** of every `TMTask` column for the fixture's rows (`rowsnap.py` → `uuid⇥column⇥value`, packed dates decoded, blobs hashed), diffed field by field. Beep sentinel armed per drive (report-only per [BEEPSEN1](beepsen1-beep-sentinel.md)).

Predecessors: [cncac1-after-completion-checkoff.md](cncac1-after-completion-checkoff.md) §9 (the app's dialog offers `Add deadlines` under `after completion`; the hand-built fixture's laws), [dblspawn1-preserved-instance.md](dblspawn1-preserved-instance.md) (the deadline belongs to the RULE, not the seed), [nextpop1-deadlined-promote.md](nextpop1-deadlined-promote.md) (the 3.23 deadlined promote, certified 8/8 three days earlier).

**Result: 28 assertions, 0 failures** — after a first pass that found a shipped regression standing between the campaign and its own question (§2).

---

## 0. Headline

1. **The cell is CLEAN, and the refusal is lifted.** `things todo add-repeating --after-completion --deadline <date>` drives end to end through the shipped verb and lands exactly CNCAC1 §9's shape: rule `tp=1 fu=256 fa=1 ts=-3 of=[]`, template `deadline = 4001-01-01` (the sentinel), seed occurrence `startDate 2026-07-05 / deadline 2026-07-08` (§3).
2. **`--start-days-earlier 3` lands a BYTE-IDENTICAL rule** — same 553-byte blob, same `sha256:0e84bb08dad511aa` — so the two spellings of the geometry are the same rule, and refusing one while accepting the other was never defensible (§4).
3. **The deadline RIDES the series, it does not stop at the seed.** Completing the seed anchors the series (`acRef := 2026-07-05`) and derives the start-shifted cursor `next = 2026-07-09` (anchor + interval − `ts`); `Create Next Copy` then mints an occurrence dated 07-09 **carrying its own derived deadline 2026-07-12**. CNCAC1 §9.2's law, reproduced on a series the SHIPPED verb built (§5).
4. **The premise of the queued item was half wrong, and the wrong half was worse.** `--start-days-earlier` with `--after-completion` was refused outright; a concrete `--deadline` with `--after-completion` was **not refused at all** — it fell through the rule-kind diversion and stayed on the SEED, so the caller got exactly one deadlined occurrence and a deadline-free series, silently (§1).
5. 🔴 **A SHIPPED REGRESSION found by the positive control: since v0.19.2, EVERY deadlined repeat drive aborts mid-dialog and leaves the Repeat sheet standing.** The dialog classifier requires *no direct text field*, but ticking `Add deadlines` reveals the `and start [n] days earlier` field as a direct child of the shell — so the drive re-classified **its own** Repeat sheet as `other` the instant it ticked the box, and the per-step focus guard refused the very next keystroke hop. Measured live: `"sheetKind":"other" … "sheetControls":"cb:2 pu:1 bt:2 gp:1 tf:1"`. Fixed here (§2).
6. **Zero alert beeps across all four drives** — including the FIXED-rule deadlined control, where [CERTSWEEP1](certsweep1-repeat-certification.md) §the-beep-finding measured one beep per fixed-rule promote 3/3. Recorded as a non-reproduction, not a refutation (§6).
7. **A false disclosure fires on every after-completion promote** (`the series was created and already has a materialized occurrence, which this rule shape is not expected to produce yet`). Not introduced here, not in this campaign's scope, and wrong: an after-completion promote ALWAYS preserves its seed as the series' only occurrence — CNCAC1 §7.1, which the sentence itself cites (§7).

---

## 1. What was actually shipped, before the lift

The queued item ([up-next](../up-next.md), CNCAC1 §9.1) described *"the after-completion+deadline refusal"*. There were two behaviors, not one, and only the first was a refusal:

```ts
if ((add.deadline !== undefined || startDaysEarlier !== undefined) && afterCompletion !== true) {
  ({ rule, seedDeadline } = mapDeadlineOntoRule(baseRule, add.when, add.deadline, startDaysEarlier));
} else if (startDaysEarlier !== undefined) {
  throw new RangeError(
    "--start-days-earlier applies only to a fixed-schedule deadline — an after-completion repeat " +
      "has no calendar start to count back from; drop --after-completion or --start-days-earlier",
  );
}
```

- `--after-completion --start-days-earlier N` → **refused**, on the belief that an after-completion repeat "has no calendar start to count back from".
- `--after-completion --deadline <date>` → **accepted, and mis-wired**. Both conditions are false, so the mapping never runs and `seedDeadline` keeps the caller's date: the deadline lands on the SEED row and the RULE is deadline-free. One deadlined occurrence; every later mint deadline-free; nothing said. The shipped JSDoc even documented it as intentional — *"after-completion series keep the seed's one-off deadline instead"*.

Both rest on the same false belief, from opposite ends: that an after-completion series has nothing to hang a per-occurrence deadline on. It has exactly what every other rule kind has — **each occurrence's own start** — which is what the offset is measured from. The app has always known this; CNCAC1 §9.1 watched its dialog offer `Add deadlines` under `after completion` and honor a 3-day offset.

The PROJECT verb's refusal is a different claim (RSIM-P P4: a project seed is DELETE-fate and its instance is minted deadline-free) about a rule kind this campaign did not probe for projects. It stands, untouched — see §8.

---

## 2. Pass 1 — the positive control failed, and it was ours

The campaign's control cell is the same command **minus** `--after-completion`: a fixed weekly deadlined `add-repeating`, the arm [NEXTPOP1](nextpop1-deadlined-promote.md) certified 8/8 on this same golden three days earlier. It failed:

```
VERIFY FAILED (silent-noop): transport failed (exit 1): ui drive stopped at "start 3 days earlier"
  (refused to run "start 3 days earlier": the dialog this command opened is no longer the one in
  front (expected repeat, found other) — it was closed or replaced while the command was running,
  so nothing was sent).
Completed: … → the Repeat dialog → frequency = weekly → interval = 1 (already set) → measure the
  Repeat dialog's shape (next-popup) → weekdays = wednesday → let the first-occurrence pop-up
  absorb the rule → Add deadlines.
```

The sheet was left standing, and every subsequent cell in the pass refused `blocked:environment` — *a dialog is already open in Things* — so the run reported 3 passed / 21 failed without ever reaching its own question.

**The dialog was the Repeat dialog, in perfect health.** An AX dump of the standing sheet shows the whole control set present and `Add deadlines` ticked, with the offset field revealed:

```
--- AXSheet child 30 --- @[239,220 545x293]
  [1] AXTextField  | val=0            | id=_NS:8   | @[428,439 34x24]      <- "and start [n] days earlier"
  [2] AXStaticText | val=days earlier | id=_NS:143 | @[467,443 92x20]
  [4] AXCheckBox   | ttl=Add reminders | val=0 | id=_NS:135
  [5] AXCheckBox   | ttl=Add deadlines | val=1 | id=_NS:129               <- ticked, by our own step
  [6] AXGroup      | id=_NS:60  (the cadence group: Every [1] weeks on [Wednesday], Next:, Ends:)
  [8] AXPopUpButton| val=weekly | id=_NS:29
  [9] AXButton     | ttl=OK    [10] AXButton | ttl=Cancel
```

And the shipped window-state census, run against that live sheet, names the defect exactly (`things ui-state` as the verb stood at v0.19.4, the dist this campaign shipped; folded into `things rescue status` by #644 the same day):

```json
{"detail":"Things is frontmost; an unrecognized dialog is open in Things (attached)",
 "state":{"sheetOpen":true,"sheetKind":"other","sheetForm":"attached","sheetDepth":1,
          "sheetControls":"cb:2 pu:1 bt:2 gp:1 tf:1", …}}
```

`tf:1`. The structural discriminator in `src/write/vectors/ui-state.ts` is

```applescript
else if nCb is 2 and nPu is 1 and nBt is 2 and nGp is 1 and nTf is 0 then
```

— **exactly zero direct text fields**. That is the deadlines-OFF shape, and only that shape. The [CGRD1](cgrd1-precommit-audit.md) §B census had already measured the other one and it is quoted verbatim in `ui-recipes.ts` beside the offset field's own targeting: *"the shell carries 0 direct text fields with deadlines OFF and exactly 1 with them ON"*. The two facts had simply never met.

**The mechanism, end to end.** `Add deadlines` is an element-addressed hop, so it passes through the per-step focus guard untouched — and it changes the shell's census from `tf:0` to `tf:1`. The very next step, `start N days earlier`, is a `set-row-field`: keystroke-class, therefore guarded, therefore re-censused. The census now reads `tf:1`, the classifier answers `other`, `judgeFocusGuard` sees `expected repeat, found other`, and the step is refused fail-closed. **The drive is defeated by its own previous step**, deterministically, on every rule kind, on every verb that drives a start-offset.

**Provenance.** The `nTf is 0` clause and the `expectedSheet` invariant both arrive in `c950cd8` — *"GUI drives: refuse instead of degrading — focus guards, an audited cleanup ladder, ui-state, and the ghost clone closed (#627)"*, 2026-08-27 — and that commit is contained in `v0.19.2`, `v0.19.3` and `v0.19.4`. So the regression is **shipped**, and it postdates NEXTPOP1's 2026-08-25 certification by two days, which is why the deadlined arm was green then and broken now. It is invisible to unit tests: `test/unit/ui-state.test.ts` asserted the `nTf is 0` clause appears **verbatim in the script**, so the test pinned the bug rather than catching it.

**Fix:** the Repeat sheet carries **at most one** direct text field (`(nTf is 0 or nTf is 1)`) — 0 with deadlines off, exactly 1 with them on. Nothing else in the discriminator moves.

Pass 2 re-ran every cell on the SAME clone, after dismissing the sheet, deleting pass 1's orphaned seed and re-shipping the rebuilt dist. That makes the two passes a clean A/B on one variable: **28 passed, 0 failed.**

> **The doctrine this is an instance of.** [CNCAC1](cncac1-after-completion-checkoff.md) §1.2's lesson, generalized in [harness.md](harness.md): *a negative result from an oracle that has never been shown a positive is not evidence*. Here the positive control did its whole job — the cell under test would have failed identically, and without the control the campaign would have reported "the after-completion deadline drive does not work" and lifted nothing.

---

## 3. Cell AC — the guard-lifted cell

`things todo add-repeating 'CNCAC2-AC' --when 2026-07-05 --deadline 2026-07-08 --after-completion --frequency weekly --interval 1 --dangerously-drive-gui`

```
ok todo.add-repeating uuid=BUJukgJFxaH6F2L73x8jNv (vector=ui, tier=3, verified)
  landed: the series repeats every week after each occurrence is completed, with a deadline 3 days later
EXIT=0
```

Two rows inserted, nothing else touched (205 fields compared across the run's five surviving rows, no change on any):

```
INSERTED row 4YdyJ4csKiXHP4uNyNZy7Q       <- the seed, relinked as the series' occurrence
  status = 0 ; start = 1
  startDate = 132805248(2026-07-05)        <- the requested --when, verbatim
  deadline  = 132805632(2026-07-08)        <- DERIVED by the app: start + 3
  rt1_repeatingTemplate = BUJukgJFxaH6F2L73x8jNv
  rt1_instanceCreationCount = 0

INSERTED row BUJukgJFxaH6F2L73x8jNv       <- the template
  status = 0 ; start = 2
  deadline = 262213760(4001-01-01)         <- THE SENTINEL: this template deadlines its instances
  rt1_recurrenceRule = blob:sha256:0e84bb08dad511aa:len553
  rt1_instanceCreationStartDate = 132805376(2026-07-06)
  rt1_instanceCreationCount = 1
  (no rt1_nextInstanceStartDate — born cursor-less)
```

The rule blob, verbatim off the row:

```xml
bytes=553
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>ed</key><real>64092211200</real>
	<key>fa</key><integer>1</integer>
	<key>fu</key><integer>256</integer>
	<key>ia</key><real>0.0</real>
	<key>of</key><array/>
	<key>rc</key><integer>0</integer>
	<key>rrv</key><integer>4</integer>
	<key>sr</key><real>1783209600</real>
	<key>tp</key><integer>1</integer>
	<key>ts</key><integer>-3</integer>
</dict>
</plist>
```

| assertion | result |
|---|---|
| CLI exit 0 | **PASS** |
| the rule is AFTER-COMPLETION (`tp=1`) | **PASS** |
| the cadence is weekly/1 (`fu=256 fa=1`) | **PASS** |
| the start offset landed on the RULE (`ts=-3`) | **PASS** |
| the template carries the 4001 deadline sentinel | **PASS** |
| the template is born cursor-less (`next=None`, CNC1 §5 birth shape) | **PASS** |
| the seed occurrence starts on `--when` (2026-07-05) | **PASS** |
| the seed occurrence carries the DERIVED deadline (2026-07-08) | **PASS** |
| exactly ONE live occurrence (no double-book) | **PASS** (1) |

> **`ts` + the sentinel, exactly as CNCAC1 §9.1 measured by hand.** Two details worth naming because they are what a reader would check. The rule blob's `of` is an **empty array**, not the nominal `{wd:0}` CNCAC1's hand-built fixture carried — the shipped recipe never touches the anchor pop-ups on an after-completion rule (`deriveFixedAnchor` returns an empty patch), and the dialog leaves `of` empty when nothing addressed it. The decoder ignores `of` on an after-completion rule either way ([repeat-rule.ts](../../src/write/repeat-rule.ts) UIC6-e), so the two shapes are equivalent, and the read path's `deadlined` flag comes from the template's deadline column, never from `ts` ([recurrence.ts](../../src/model/recurrence.ts): *a deadlined `ts=0` after-completion template exists*). And `ts=-3` reached the blob through the app's own field, driven by the recipe's `start 3 days earlier` step — the step pass 1 could never reach.

**Zero beeps** (`BEEP-SENTINEL [run]: 0 alert beep(s) in the window (allowed 0; 12:04:41 → 12:04:53, 1 marks) — clean`).

---

## 4. Cell SDE — the same geometry named from the other end

`--start-days-earlier 3` in place of `--deadline 2026-07-08` — the spelling the lifted refusal named explicitly:

```
ok todo.add-repeating uuid=QtFNYRRkukYL76h9DVQ5Bn (vector=ui, tier=3, verified)
  landed: the series repeats every week after each occurrence is completed, with a deadline 3 days later

template rule: tp=1 fu=256 fa=1 ts=-3 rc=0 of=[] next=None icStart=2026-07-06 icCount=1 tmplDeadline=4001-01-01
occurrence VEqCFLSCaCWHEv5rdPF2bS: start=2026-07-05 deadline=2026-07-08 status=0
```

| assertion | result |
|---|---|
| CLI exit 0 | **PASS** |
| the rule is AFTER-COMPLETION (`tp=1`) | **PASS** |
| the start offset landed (`ts=-3`) | **PASS** |
| the template carries the 4001 deadline sentinel | **PASS** |
| the occurrence starts on `--when` | **PASS** |
| the occurrence is due `--when + 3` | **PASS** |

> **`rt1_recurrenceRule = blob:sha256:0e84bb08dad511aa:len553` — the SAME hash as the AC cell's.** Not "equivalent", not "the same fields": the two commands wrote byte-identical rule blobs. `--deadline <date>` and `--start-days-earlier <n>` are one geometry named from two ends, which is what the shipped agreement check has always said; accepting one on an after-completion rule while refusing the other was arbitrary in the strictest sense, and both arms of the diversion are gone.

---

## 5. Cell MINT — the deadline rides the series

The question the seed alone cannot answer: does a LATER occurrence carry a deadline, or was the seed's a one-off?

**Leg 1 — complete the seed through the shipped verb** (`things todo complete 4YdyJ4cs…`, `vector=url-scheme, tier=0, verified`):

```
CHANGED 4YdyJ4cs.status               : 0 -> 3
CHANGED 4YdyJ4cs.stopDate             : None -> 1783253111.927371
CHANGED 4YdyJ4cs.userModificationDate : 1783253087.346396 -> 1783253111.927407
CHANGED BUJukgJF.rt1_afterCompletionReferenceDate : None -> 132805248(2026-07-05)
CHANGED BUJukgJF.rt1_nextInstanceStartDate        : None -> 132805760(2026-07-09)
CHANGED BUJukgJF.todayIndexReferenceDate          : None -> 132805760(2026-07-09)
(rows in both: 2; fields compared: 82)
```

| assertion | result |
|---|---|
| the completion ANCHORED the series (`acRef = 2026-07-05`) | **PASS** |
| the derived cursor is anchor + interval − `ts` (07-05 + 7 − 3 = **07-09**) | **PASS** |

**Leg 2 — `Items ▸ Repeat ▸ Create Next Copy`** (the app's own gesture, driven from the menu):

```
INSERTED row QHp7wgY5BF2kCKWG43RczY
  status = 0 ; start = 2
  startDate = 132805760(2026-07-09)        <- the cursor
  deadline  = 132806144(2026-07-12)        <- DERIVED: start + 3
  rt1_repeatingTemplate = BUJukgJFxaH6F2L73x8jNv ; rt1_instanceCreationCount = 0

CHANGED BUJukgJF.rt1_afterCompletionReferenceDate : 2026-07-05 -> None
CHANGED BUJukgJF.rt1_instanceCreationCount        : 1 -> 2
CHANGED BUJukgJF.rt1_nextInstanceStartDate        : 2026-07-09 -> None
CHANGED BUJukgJF.todayIndexReferenceDate          : 2026-07-09 -> None

series rows:
  4YdyJ4cs  status 3  start 2026-07-05  deadline 2026-07-08  stopped 1783253111.92737
  QHp7wgY5  status 0  start 2026-07-09  deadline 2026-07-12
```

| assertion | result |
|---|---|
| the mint lands on the derived cursor (`start=2026-07-09`) | **PASS** |
| the mint carries its OWN derived deadline (`start + 3` = 2026-07-12) | **PASS** |

> **CNCAC1 §9.2 reproduced on a series the SHIPPED verb built.** The cursor of a deadlined after-completion series is **not** the anniversary of the completion: the interval lands on the DUE date and the cursor is the START, `ts` days earlier. The composite's template delta is CNCAC1 §4's honest bookkeeping — the pending occurrence now exists, so anchor and cursor clear and `icCount` bumps. Every occurrence of this series, seed and successor alike, is due three days after it appears. That is the shape the maintainer asked for, and it is now reachable in one command.

---

## 6. Cell CTRL — the positive control, and a beep non-reproduction

The fixed-rule twin, run first in every pass:

```
ok todo.add-repeating uuid=XzPYce9AbXeDfqv6QDz4KU (vector=ui, tier=3, verified)
  landed: the series repeats every week; the first occurrence is 2026-07-05, with a deadline 3 days later

rule: tp=0 fu=256 fa=1 ts=-3 rc=0 of=[{wd=3(Wed)}] next=2026-07-12 icStart=2026-07-12 icCount=1 tmplDeadline=4001-01-01
occurrence XMGcMC77EJvqA7exX3jkZB: start=2026-07-05 deadline=2026-07-08 status=0
```

Six assertions, all PASS. Note the geometry NEXTPOP1 certified, intact: the anchor is derived from the DUE date (Wednesday 07-08) while the instance START lands on the requested `--when` (Sunday 07-05), and the cursor names the next DUE date.

> **Zero beeps, on all four drives.** [CERTSWEEP1](certsweep1-repeat-certification.md) measured **one** alert beep per fixed-rule promote, 3/3, against 0/2 for after-completion promotes, and proposed the calendar-anchor/`Next:` leg as the source. This campaign's fixed-rule arm drove that whole leg (weekday pop-up, `settle-occurrences`, the deadline checkbox and the offset field) and beeped **zero**. Recorded as a NON-REPRODUCTION, matching [ACFUT1](acfut1-after-completion-future-anchor.md)'s: the beep is real (BEEP1 validated the oracle positively) but it is not deterministic per drive, so no law about it can rest on a single campaign's count. The per-step bisect CERTSWEEP1 queued is still the way to settle it.

---

## 7. Cell REF — the refusals that survive the lift

Both drive nothing and create nothing (`SELECT count(*) … title LIKE 'CNCAC2-REF%'` = **0**):

```
$ things todo add-repeating 'CNCAC2-REF1' --when someday --deadline 2026-07-08 --after-completion …
error: a repeating --deadline or --start-days-earlier needs a concrete --when date (the deadline
offset is measured from each occurrence's start) — schedule the series on a YYYY-MM-DD --when, or
drop --deadline / --start-days-earlier                                                      EXIT=1

$ things todo add-repeating 'CNCAC2-REF2' --when 2026-07-05 --deadline 2026-07-08 --start-days-earlier 5 --after-completion …
error: --deadline (2026-07-08) puts each occurrence's due date 3 days after its start (--when
2026-07-05), but --start-days-earlier says 5 — these disagree. Drop one, or make them agree
(--start-days-earlier 3, or --deadline 2026-07-10).                                         EXIT=1
```

| assertion | result |
|---|---|
| a keyword `--when` is still refused (the offset needs a concrete start) | **PASS** |
| a disagreeing `--deadline` / `--start-days-earlier` pair is still refused | **PASS** |
| the REF cells created NOTHING | **PASS** (0) |

> The lift removes the rule-KIND diversion and nothing else. The geometry's own refusals — a concrete `--when` on or before the deadline, and agreement when both spellings are given — now apply uniformly to both rule kinds, because they were always about the geometry rather than the calendar.

---

## 8. Verdict per cell

| cell | question | verdict |
|---|---|---|
| **REF** | do the geometry's refusals survive the lift? | **YES** — both refuse with zero mutation, and neither ever mentioned the rule kind |
| **CTRL** | does a deadlined drive work at all in this clone? | **PASS 2: YES** (6/6). **PASS 1: NO** — and the failure was ours, not the app's (§2) |
| **AC** | `--after-completion --deadline <date>`, end to end | **CLEAN, 9/9** — `tp=1 ts=-3`, the 4001 sentinel, seed due `--when + 3`, one live occurrence |
| **SDE** | the `--start-days-earlier` spelling | **CLEAN, 6/6** — a byte-identical rule blob |
| **MINT** | does the deadline ride the series, or stop at the seed? | **IT RIDES** — completion anchors + derives the start-shifted cursor 07-09; the CNC mint is dated 07-09 and due 07-12 |

---

## 9. What this campaign changes elsewhere

| document | change |
|---|---|
| `src/write/promote-clone.ts` | the rule-KIND diversion in `runAddRepeatingTodo` is **deleted** — one mapping serves both rule kinds; `landedRuleEcho` states the deadline on an after-completion series too |
| `src/write/vectors/ui-state.ts` | the Repeat-sheet discriminator accepts **0 or 1** direct text fields (§2) — the shipped-regression fix |
| `test/unit/ui-state.test.ts` | the verbatim-clause test pinned the bug; it now asserts the deadline-mode census is accepted |
| `src/write/operations.ts` | the `TodoAddRepeatingParams` deadline JSDoc no longer claims after-completion series "keep the seed's one-off deadline" |
| [capability-matrix.md](../capability-matrix.md) | the after-completion deadline row and the classifier regression |
| [reference/README.md](../reference/README.md) | CNCAC2 index entry |
| `CHANGELOG.md` | both user-visible changes under `## Unreleased` |

## 10. Open cells this campaign did NOT close

1. **The PROJECT verb's `--after-completion --deadline` refusal stands, unprobed.** Its ground is a different claim from the one falsified here — RSIM-P P4: an after-completion project's seed is DELETE-fate and its instance is minted deadline-free, so an un-mapped deadline vanishes. But the fix that landed for to-dos maps the deadline onto the RULE, where a DELETE-fate seed cannot lose it, and §5 shows a rule-level deadline reaching a minted occurrence. The refusal is therefore *plausibly* obsolete for the same reason the to-do one was — and plausibly is not evidence. One project cell settles it; nothing here did.
2. 🔴 **A FALSE disclosure on every after-completion promote.** Both after-completion drives returned:

   > *warning: the series was created and already has a materialized occurrence, which this rule shape is not expected to produce yet (CNCAC1 §7.1 (a never-completed series has `next = NULL`); REPX1 §2.5) — re-read the series to check it will not double-book*

   The citation is right and the inference is wrong: §7.1 says a never-completed after-completion series has no CURSOR, not that it has no OCCURRENCE — it has exactly one, the preserved seed, which is the shape §3's row delta shows and the shape §7.1 itself photographs. The spawn-expectation map (#635) conflates the two, so the warning fires on every correct after-completion promote and tells the caller to go check for a double-book that cannot form ([DBLSPAWN1](dblspawn1-preserved-instance.md) exempts after-completion by construction). Not introduced by this change, not ruled, not touched.
3. **Whether the `nTf` regression reached any OTHER guarded surface.** The fix restores the classifier; what this campaign did not do is walk every keystroke-class step of every recipe against every dialog mode looking for a second census the discriminator does not describe. The `ui-state` census is now the single structural authority for three consumers (the per-step guard, `rescue`, the `ui-state` verb), which makes such a walk worth one sitting.
4. **The beep.** §6's 0/4 does not refute CERTSWEEP1's 3/3; it makes the count non-deterministic, which is a different and worse problem than a known source. The per-step bisect stands.
