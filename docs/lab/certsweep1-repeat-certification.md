# CERTSWEEP1 — the queued guest-certification cells, driven through the shipped CLI

**Probed under: `things-lab-golden-v4` · Things 3.23 (build 32300036) · DB v27 · macOS 15.7.7 · guest clock pinned 2026-07-05 (a Sunday), NEVER rolled — no cell needs a spawn, so the 2026-07-18 trial wall is never approached.** Two disposable clones (`certsweep1-lab`, pass 1 = all twelve cells, pass 2 = the three cells pass 1 mis-drove plus the blast-radius cell it opened), both destroyed. All fixtures synthetic (`CS1-*`). Driver: [`lab/scripts/research-certsweep1.sh`](../../lab/scripts/research-certsweep1.sh):

```sh
TART_HOME=/Volumes/Workspace/tart bash lab/scripts/research-certsweep1.sh                       # all cells
TART_HOME=/Volumes/Workspace/tart CELLS="C2 C4 AC P1 P1B" bash lab/scripts/research-certsweep1.sh
```

**CERTIFICATION-ONLY campaign.** Nothing in `src/` was changed. The one defect it found is reported here and left standing.

---

## 0. Headline

Twelve cells, **eleven certified green and one red**, the red being a real shipped defect the cell was written to certify.

* **The CNC template-mutation composites are certified in a guest** — all four arms (`todo complete` with and without an open occurrence, `todo cancel`, `todo update --exception`) reproduce [CNC1 §6](cnc1-template-mutations.md) / [REPX3 §1.2](repx3-chooser-residuals.md) **field for field** through the shipped CLI, and **both refusals refuse with zero mutation**. The template's `umd` and its rule blob are byte-untouched on every arm.
* **`todo complete <after-completion series>` drives end to end** — the arm no cell had ever run. Its fixture was built by the **shipped `todo make-repeating --after-completion`**, which settles a queued question: the [CNCAC1 §9.1](cncac1-after-completion-checkoff.md) validation refusal is keyed on the **deadline combination only**; a plain after-completion promote is not refused.
* **`resume-repeat` after a CNC'd pause leaves the series PERMANENTLY STALLED** ([oddities §19](../things-app-oddities.md) extended). Resume flips `rt1_instanceCreationPaused 1→0` and derives *nothing*: the series comes back unpaused with **no anchor and no cursor**, so it will never spawn again on its own.
* **Both residual `umd` cells are closed and the reparent-bump law HOLDS.** `project.dissolve-heading` BUMPS every surviving child; `project.move-heading-to-project` BUMPS the heading (and leaves the child alone). `dissolve-heading` also drove end to end for the first time on 3.23 (post-#589): heading hard-deleted, three children re-homed with their `index` byte-identical.
* 🔴 **DEFECT — every DATED `add-repeating` is broken on BOTH verbs.** `things todo add-repeating <title> --when <ISO date>` and `things project add-repeating <title> --when <ISO date>` exit **2** with `usage: params.next: not a parameter of "todo.add"/"project.add"` and create nothing. Undated calls succeed. Introduced by **#552**; see §7.
* **The shipped fixed-rule promote recipe raises exactly one alert beep per drive** — closing the gap [BEEP1 §6.1](beep1-numeric-field-beep.md) left explicitly open ("nothing drove, so their 0 counts are not evidence"). The answer is not zero. An after-completion promote raises none.

| pass | cells | assertions | beeps |
|---|---|---|---|
| 1 | C1 C2 C3 C4 R1 R2 AC RES TS1 TS2 P1 P2 | 49 pass / 20 fail (18 of the fails a driver bug, §1.1) | **1** (P2) |
| 2 | C2 C4 AC P1 P1B | 31 pass / 2 fail (both the §7 defect) | **2** (P1B) |

The beep oracle's positive control (three deliberate `osascript -e beep` calls) read exactly **3** on both clones before any cell was judged.

---

## 1. Method, and the pass that had to be re-run

One clone per pass: airgapped (default route deleted, a failed ping asserted), clock pinned to 2026-07-05 **before Things is ever launched**, one warm launch+quit, then the production `dist/` shipped into the guest and driven as `things`. The DB oracle is a **full 41-column `TMTask` row snapshot** for every row matching the fixture's title, diffed either side of each gesture, with packed dates decoded and blobs hashed. The beep sentinel is reset per cell, marked per gesture and asserted at the end of the cell in report-only mode ([`lab/guest/beep-sentinel.sh`](../../lab/guest/beep-sentinel.sh)).

**Fixture provenance is deliberate and differs by cell.** The fixed-rule series (C1–C4, R1, R2) are built the **REPX2/REPX3/CNC1 way** — `things:///add?title=…&when=2026-07-05`, then `Items ▸ Repeat…` → *weekly* → OK — *not* because the shipped promote is unavailable (it is available, since the #597 write escape) but because `make-repeating` is promote-via-CLONE: it mints a new row, trashes the original and can drop a preserved future instance, so a promote-built fixture would not be byte-comparable with the CNC1/REPX3 evidence being certified against. The after-completion fixtures (AC, RES) go through the **shipped promote** on purpose — that is itself a cell (§4).

### 1.1 The driver bug pass 1 shipped, named

Pass 1 called the three MINTING composites without `THINGS_API_UI_DIRECT=1`. The mint leg is a ui-vector op (`todo.create-next-copy`), so all three returned a clean, correct refusal and changed nothing:

```
{"code":"blocked:environment","message":"this operation drives the Things window, and GUI-driving
 is granted only to the helpers, and no helper is answering on this machine — no occurrence was
 created, so nothing was changed", "remediation":"run `things helpers setup --gui` …"}
EXIT=4
    (no field changed on any surviving row)
```

Eighteen of pass 1's twenty failures are that, and pass 2 re-ran the three cells with the escape. The refusal is worth keeping on the record for two reasons: it is the **fail-closed direction** working exactly as [harness.md §The lab escapes](harness.md) describes (a forgotten prefix shows up as a red cell, never a wedged VM), and the detail string **names the composite's own contract** — *"no occurrence was created, so nothing was changed"* — which is the phrasing `mintPendingOccurrence` exists to guarantee.

It also produced one incidental certification nobody asked for: **C1 needs no GUI at all.** The non-minting arm ran green *without* either escape, reporting `vector: url-scheme, tier: 0`. Checking off a repeating to-do that already has an unfinished copy is a quiet URL write on a shipped host with no GUI tier granted.

---

## 2. Cells C1–C4 — the composites, through the shipped verbs

All four fixtures are the same shape: a to-do dated 2026-07-05 promoted to **every 1 week** by the dialog, which at birth reads

```
tp=0 fu=256 fa=1 ts=0 rc=0 of=[{wd=0(Sun)}] blob=4a52076bf786
next=2026-07-12  icStart=2026-07-12  icCount=1  paused=0  acRef=None
+ one live instance dated 2026-07-05, status 0
```

### 2.1 C1 — `todo complete <series>` WITH an open materialized occurrence (6/6)

```json
{"op":"todo.complete","uuid":"Ttz8vKrAqydyUpUV2EWj31","observed":{"status":"completed"},
 "vector":"url-scheme","tier":0,
 "occurrence":{"templateUuid":"DHhWCUKVgQphiZDuWeBLtT","occurrenceUuid":"Ttz8vKrAqydyUpUV2EWj31",
               "minted":false,"date":"2026-07-05"},
 "warnings":["checked off the 2026-07-05 occurrence of \"CS1-C1-OPEN\"",
             "the next occurrence is 2026-07-12"]}
```

```
CHANGED Ttz8vKrA.status               : 0 -> 3
CHANGED Ttz8vKrA.stopDate             : None -> 1783252870.862718
CHANGED Ttz8vKrA.userModificationDate : 1783252843.072064 -> 1783252870.862745
(the template: byte-identical across all 41 columns)
```

Nothing minted, the pre-existing occurrence resolved, the template untouched — and, per §1.1, no GUI involved. The disclosure carries no irreversibility note, correctly: there is nothing `undo` cannot reach.

### 2.2 C2 — the same verb WITHOUT one: mint + complete + advance (9/9)

The seed occurrence is resolved directly first, so the series has a cursor and no open copy. Then `todo complete <template>`:

```
INSERTED row PaQtaEf94fF5LQ4sMnyhHt
  status = 3 ; start = 2 ; startDate = 2026-07-12 ; stopDate = 1783252872.3586512
  creationDate = 1783252872.223184 ; userModificationDate = 1783252872.358679
  rt1_repeatingTemplate = CLBHT4Lb… ; rt1_instanceCreationCount = 0

CHANGED CLBHT4Lb.rt1_instanceCreationCount     : 1 -> 2
CHANGED CLBHT4Lb.rt1_instanceCreationStartDate : 2026-07-12 -> 2026-07-13   <- consumed slot + 1
CHANGED CLBHT4Lb.rt1_nextInstanceStartDate     : 2026-07-12 -> 2026-07-19   <- next RULE date
CHANGED CLBHT4Lb.todayIndexReferenceDate       : 2026-07-12 -> 2026-07-19
```

`occurrence.minted = true`, `occurrence.date = "2026-07-12"`. The template's `userModificationDate` (`1783252859.631604`) and its rule blob (`4a52076bf786`) are **byte-identical** either side. That is [REPX3 §1.2](repx3-chooser-residuals.md)'s four-field cursor delta exactly, reached from the shipped verb.

### 2.3 C3 — `todo cancel <series>` (6/6)

Identical delta, `status = 2` on the minted row with its `stopDate` set (`HCUn8tpX…`, 2026-07-12), template cursor → 07-19, `icStart` → 07-13, `icCount` → 2, blob untouched. Cancel is completion's shape on a fixed rule, as CNC1 §6 measured.

### 2.4 C4 — `todo update <series> --when 2026-07-15 --exception` (8/8)

2026-07-15 is a Wednesday: off-rule, and not a slot the weekly rule will fire on.

```
INSERTED row Ce1vjt9bhC6K9AwpZjXbGG
  status = 0 ; start = 2 ; startDate = 2026-07-15 ; todayIndexReferenceDate = 2026-07-15
  creationDate = 1783252905.683562 ; userModificationDate = 1783252905.832635
  rt1_instanceCreationCount = 0

CHANGED B6Ge52e8.rt1_instanceCreationCount     : 1 -> 2
CHANGED B6Ge52e8.rt1_instanceCreationStartDate : 2026-07-12 -> 2026-07-13
CHANGED B6Ge52e8.rt1_nextInstanceStartDate     : 2026-07-12 -> 2026-07-19
CHANGED B6Ge52e8.todayIndexReferenceDate       : 2026-07-12 -> 2026-07-19
```

Set that beside REPX3 §1.2's `Make Exception` and it is **the same four template fields with the same four values**, and a minted row carrying the same `status`/`start`/`startDate`/`icCount`. The single documented difference is present and is the expected one: **`userModificationDate` is set on the minted row** (the chooser leaves it unset), which SYNCX1 measured to be the winning side of Things Cloud's merge arbitration. The composite is the safe direction.

One copy observation, neither wrong nor obviously right: the result names the occurrence by its **pre-move** date — `"date":"2026-07-12"`, and the warning reads *"changed only the 2026-07-12 occurrence"* — while the row it hands back now sits on 07-15. It identifies which occurrence was taken out of the series, which is the useful fact; it is not the date of the row the caller will find.

### 2.5 Beeps

C1–C4 counted **0** beeps each, over both the dialog-built fixtures and the composite drives.

---

## 3. Cells R1 / R2 — the refusals refuse, and nothing moves

### 3.1 R1 — an exception aimed at a LIVE SLOT (4/4)

Cursor 07-12; the rule's next own slot after the mint is **07-19**. `todo update <template> --when 2026-07-19 --exception`:

```
{"code":"blocked:environment","message":"\"CS1-R1-SLOT\" already lands on 2026-07-19 — moving this
 occurrence there would leave two copies on that day, and the app does not merge them",
 "remediation":"pick a day the series does not already land on, or change the whole series with
 `things todo reschedule-repeat <ref>`"}
EXIT=4
    (no field changed on any surviving row)
```

Untrashed series rows after: **1** — the mint never happened. The refusal fires ahead of the ui-capability gate, so a caller on a machine with no GUI tier still gets the *collision* refusal rather than an environment one: the more useful of the two.

### 3.2 R2 — a cursor-less (PAUSED) series, on BOTH composites (8/8)

Seed occurrence resolved, then `todo pause-repeat`: `paused 0→1`, `next 2026-07-12 → None` (REPX1 §5.3's law, reconfirmed). Then both verbs, back to back:

```
todo complete <template>                       → EXIT=4
todo update <template> --when 2026-07-15 --exception → EXIT=4
both: "this repeating to-do is paused, so it has no upcoming occurrence to work on"
      remediation: "resume it first with `things todo resume-repeat <ref>`"
    (no field changed on any surviving row)   <- across BOTH refusals
```

The paused branch of `noPendingRefusal` is the one a user can actually reach, and it names the one command that changes the state. Zero beeps.

---

## 4. Cell AC — `todo complete <after-completion series>`, end to end (7/7)

**The fixture settles a queued question first.** The brief allowed for the [CNCAC1 §9.1](cncac1-after-completion-checkoff.md) validation refusal to block the promote; it does not. `things todo make-repeating <uuid> --frequency weekly --interval 1 --after-completion --dangerously-drive-gui` **succeeds** (`vector: ui`, `tier: 3`), minting

```
tp=1 fu=256 fa=1 of=[] blob=44961aadf17d  next=None  icStart=2026-07-06  icCount=1  acRef=None
```

— [CNC1 §5](cnc1-template-mutations.md)'s birth shape. **The §9.1 refusal is keyed on the deadline COMBINATION** (`--after-completion` with `--deadline` / `--start-days-earlier`), not on `--after-completion` itself; that refusal stands and is **not lifted** by this campaign.

Completing the seed occurrence gives the series [CNCAC1 §1.1](cncac1-after-completion-checkoff.md)'s shape — `next=2026-07-12 acRef=2026-07-05`, **no open occurrence**, which is precisely the state the composite must mint into. Then the never-driven arm:

```json
{"op":"todo.complete","observed":{"status":"completed"},"vector":"url-scheme","tier":0,
 "occurrence":{"templateUuid":"15FpNBTkeZuHqvyEFGYne7","occurrenceUuid":"3gdWd3t2QUzXAknt8LZYBm",
               "minted":true,"date":"2026-07-12"},
 "warnings":["checked off the 2026-07-12 occurrence of \"CS1-AC\" (created just now, because the
              series had no unfinished copy)",
             "the next occurrence is 2026-07-12 — this series counts from each completion, so
              resolving it now restarted the interval from today",
             "`things undo` restores this occurrence's own change; it cannot remove the occurrence
              that was created for it, and the series has already moved on to its following date"]}
```

```
INSERTED row 3gdWd3t2QUzXAknt8LZYBm
  status = 3 ; start = 2 ; startDate = 2026-07-12 ; stopDate = 1783252924.7813401
CHANGED 15FpNBTk.rt1_instanceCreationCount : 1 -> 2
(and NOTHING else — cursor still 2026-07-12, acRef still 2026-07-05, umd unmoved, blob unmoved)
```

The **net** template delta of the whole composite is one column, `icCount`. That is coherent with [CNCAC1 §4](cncac1-after-completion-checkoff.md)'s column-by-column reading — CNC clears anchor and cursor, the completion restores both from the resolution day, and at a clock pinned to the original anchor day the two cancel exactly. The three-part disclosure is right, including the from-completion sentence, which is the one an agent needs in order not to read `next=2026-07-12` as "unchanged, therefore nothing happened".

Zero beeps; app alive; zero crash reports.

---

## 5. Cell RES — `resume-repeat` after a CNC'd pause: the series is left STALLED

The one state [CNCAC1 §8](cncac1-after-completion-checkoff.md) opened and did not close. Fixture: the §4 after-completion series with a completed history (`next=2026-07-12 acRef=2026-07-05 icCount=1`).

**Step 1 — pause.** `next → None`, `acRef` **retained** at 2026-07-05, `paused → 1`.

**Step 2 — `Items ▸ Repeat ▸ Create Next Copy`,** driven from the menu (the shipped composite refuses this state — §3.2 — so the gesture under test has to be the app's own). The submenu on a paused after-completion template enumerates:

```
Edit Rule…, (sep), Show Previous Copy, Create Next Copy, (sep), Pause, Stop
```

> Note the item reads **`Pause`**, not `Resume`, on this fixture — CNCAC1 §8 recorded `Resume` in that slot on its own paused fixture. Not chased here; recorded as an inconsistency for whoever next audits that submenu.

Pressing it reproduces oddities §19 exactly:

```
INSERTED row Gh4CX4Nfa4fu5MKw8pYFt8  status = 0  start = 2  startDate = 2026-07-12
CHANGED RjxddgY1.rt1_afterCompletionReferenceDate : 2026-07-05 -> None
CHANGED RjxddgY1.rt1_instanceCreationCount        : 1 -> 2
(rt1_instanceCreationPaused stays 1; the template's umd is NOT bumped)
```

**Step 3 — the measurement. `things todo resume-repeat`:**

```
drove 3 step(s): reveal the target in Things → bring Things to the foreground → Items ▸ Repeat ▸ Resume
EXIT=0
CHANGED RjxddgY1.rt1_instanceCreationPaused : 1 -> 0
CHANGED RjxddgY1.userModificationDate       : 1783253070.680402 -> 1783253086.6699061
(and nothing else)

after resume: tp=1 … next=None  icStart=2026-07-06  icCount=2  paused=0  acRef=None
```

> **Resume derives nothing.** It flips one flag. A series that entered the pause with an anchor comes out of it with **neither an anchor nor a cursor** — because the CNC in between consumed the anchor — and an after-completion rule's entire schedule derives from that anchor. The series is now unpaused, believed live by every surface that reads `paused`, and **structurally incapable of ever spawning again**. It is [oddities §19](../things-app-oddities.md)'s hazard one step further along: §19 records that the CNC defeats the pause and eats the anchor; this records that the obvious remedy — resume — does not repair it, and that nothing tells the user.
>
> The state is presumably recoverable by resolving the occurrence the CNC minted (completion is what anchors an after-completion series, REPX1 §2.5) — **inferred, NOT measured**, and worth one line in a future sitting. The user-visible point stands either way: the only route back is through a row the user did not ask for, and there is no signal at all.

Zero beeps across all four gestures of the cell; app alive; zero crash reports.

---

## 6. Cells TS1 / TS2 — the two heading ops, and the two residual `umd` cells

Both are first-class certifications of ops that could not resolve their first click target before #589 ([HXPC1 §B0](hxpc1-picker-assert.md)).

### 6.1 TS1 — `project dissolve-heading`, end to end (6/6) + the surviving-children `umd` cell

Fixture: `CS1-DISS-PROJ` with heading `CS1-DISS-HEAD` and three children at indices `-509 / -226 / 0`.

```
drove 4 step(s): reveal the heading's project → foreground → open the heading's ellipsis menu
                 ("More. CS1-DISS-HEAD") → ellipsis menu ▸ Delete
EXIT=0

DELETED row Anwz7VZGGHjQ7iFJazyujU                          <- the heading, HARD-deleted
CHANGED GFBTw78R.heading : Anwz7VZG… -> None
CHANGED GFBTw78R.project : None -> SVybnxEH…
CHANGED GFBTw78R.userModificationDate : 1783253092.04128 -> 1783253101.1613579
CHANGED Keu5sUy1.heading / .project / .userModificationDate  (same shape)
CHANGED Xn3Qpsfu.heading / .project / .userModificationDate  (same shape)
```

| assertion | result |
|---|---|
| the heading is GONE (untrashed count 0) | **PASS** — and it is a hard delete, not a trash, matching DISS1 |
| all three children survive untrashed | **PASS** (3) |
| the children re-parent to the project | **PASS** (3) |
| no child still points at the heading | **PASS** (0) |
| the children's ORDER is preserved | **PASS** — `index` values `-509 / -226 / 0` are byte-identical either side |

> **`umd` cell (timestamps §2c): dissolve-heading BUMPS every surviving child.** Three for three, all within 1 ms of each other. The reparent-bump law (WG-2) predicted this and is now **measured**, not predicted. Note what that means for a `umd`-keyed watcher: dissolving a heading looks exactly like editing all of its children.

### 6.2 TS2 — `project move-heading-to-project`, the heading `umd` cell (3/3)

```
drove 6 step(s): reveal the source project → foreground → open the heading's ellipsis menu
                 ("More. CS1-MHP-HEAD") → ▸ Move… → narrow the picker to "CS1-MHP-DEST"
                 → commit the picker on the "CS1-MHP-DEST" row
EXIT=0

CHANGED Lm9xi7G2.project              : 4pNozQr4… -> SoHHme6Y…
CHANGED Lm9xi7G2.userModificationDate : 1783253107.668087 -> 1783253120.918715
CHANGED 4pNozQr4.untrashedLeafActionsCount / .openUntrashedLeafActionsCount : 1 -> 0
CHANGED SoHHme6Y.untrashedLeafActionsCount / .openUntrashedLeafActionsCount : 0 -> 1
```

> **`umd` cell: move-heading-to-project BUMPS the heading — and ONLY the heading.** The child that travels with it (via the intact heading FK) keeps its `userModificationDate` **byte-identical** (`1783253107.6683` either side). So the two cells resolve differently in an instructive way: the row whose FK is rewritten bumps; a row that merely rides along does not. Both projects' cached leaf counters move, `umd`-silently.

Zero beeps on both cells.

---

## 7. 🔴 The defect: every DATED `add-repeating` refuses, on BOTH verbs

Cell P1 was written to certify the ANCH2 `next` fix (#549) for `project add-repeating --when <future date>`. It cannot, because the verb no longer runs:

```
$ things project add-repeating CS1-P1-ADD --when 2026-07-10 --frequency weekly --interval 1 \
      --dangerously-drive-gui --json
{"ok":false,"kind":"error","error":{"code":"usage","message":"params.next: not a parameter of
 \"project.add\" — accepted parameters are title, notes, area, when, deadline, todos, items,
 createdAt, completedAt"}}
EXIT=2
```

Cell **P1B** fixes the blast radius, and it is wider than the cell:

| call | result |
|---|---|
| `project add-repeating --when 2026-07-10 --frequency weekly --interval 1` | **EXIT=2** `params.next: not a parameter of "project.add"` |
| `project add-repeating` **without** `--when` | **EXIT=0** — series minted, `next=2026-07-12 icStart=2026-07-12 icCount=1` |
| `todo add-repeating --when 2026-07-10 --frequency weekly --interval 1` | **EXIT=2** `params.next: not a parameter of "todo.add"` — **0 rows created** |
| `todo add-repeating` **without** `--when` | **EXIT=0** |
| `project make-repeating` on a dated project (cell P2) | **EXIT=0** — unaffected |

**The mechanism**, traced from the message:

1. `--when <ISO date>` on either `add-repeating` verb is mapped to the rule field `next` by `RULE_FLAG_MAP` (`src/cli/commands/repeat-flags.ts`, since #492 — the field that drives the Repeat dialog's *Next:* control).
2. `addRepeatingRuleFieldsFromOpts` strips `reminder` / `deadline` / `startDaysEarlier` from that bag but **not `next`**, so `next` reaches `runAddRepeatingTodo` / `runAddRepeatingProject` inside the params.
3. Those orchestrators split the bag with `splitAddRepeatingRule`, whose exhaustive key map `ADD_RULE_KEYS` covers `AddRepeatingRuleFields` — which has **no `next`**. So `next` lands in the **ADD** half.
4. The add half becomes the create leg's params, and `todo.add` / `project.add` reject unknown parameters by design.

`next` was never wanted there in the first place: `addRepeatingViaCreate` **re-derives** the drive date from `addParams["when"]` (deadline-shifted) a few lines later, and #552's own comment says so — *"the ONE field that is deliberately re-derived rather than copied is `next`"*.

**Introduced by #552** (`a1a8898`, 2026-08-23, *"the update field chain is ONE exhaustive registry"*), which replaced both orchestrators' hand-written `addParams` literal — a literal that had simply never listed `next` — with `{ ...add }` from the new exhaustive split. The refactor was right; the key map is one entry short of the vocabulary the CLI actually emits. Every dated `add-repeating` on both surfaces has been broken since.

**Severity:** fails closed and loudly — exit 2, a usage error, **zero rows created** (asserted: `count(*) FROM TMTask WHERE title='CS1-P1B-TODO'` = 0). Nothing is corrupted; the flagship dated-series verb is simply unusable on both surfaces. Not fixed here — this is a certification-only campaign and the promote path is under concurrent change.

> **Why the simulator did not catch it.** Both verbs are unit-covered against the simulator, which is entered *below* the CLI flag mapper: the tests construct the params bag directly and never emit the spurious `next`. The defect lives exactly in the seam between the CLI's rule-flag map and the library's rule/add split, which is the one place neither side's tests look.

### 7.1 P2 — `project make-repeating` on a DATED project (3/3), which is unaffected

A project created at `when=2026-07-14` (a Tuesday), then `project make-repeating --frequency weekly --interval 1`:

```
drove 13 step(s): reveal the container (things:///show?id=someday) → foreground → select the project
  row → Items ▸ Repeat… → the Repeat dialog → frequency = weekly → interval = 1 → measure the
  dialog's shape (next-popup) → weekdays = tuesday → Next (first occurrence) = 2026-07-14
  → audit the dialog against the requested rule → press "OK"
EXIT=0

tp=0 fu=256 fa=1 ts=0 rc=0 of=[{wd=2(Tue)}] next=2026-07-14 icStart=2026-07-14 icCount=0
```

**The landed first occurrence is the project's own date**, and YANCH1's anchor derivation put the weekly rule on Tuesday to match — so the #549 fix is certified on the `make-repeating` half of the item. The `add-repeating` half stays open behind §7.

---

## 8. The beep census — and BEEP1's open gap, closed

Per-cell counts (report-only mode; the oracle's positive control read 3/3 on both clones):

| cell | beeps | what drove |
|---|---|---|
| C1 C2 C3 C4 R1 R2 AC RES TS1 TS2 | **0** each | dialog-built fixtures, all four composites, both refusals, the CNC menu press, pause/resume, both heading-ellipsis recipes |
| P1 | 0 | nothing drove (§7) |
| **P2** — `project make-repeating`, dated weekly | **1** | the shipped fixed-rule promote recipe |
| **P1B** — `project add-repeating` + `todo add-repeating`, undated weekly | **1 each** | the same recipe |

> **The shipped promote recipe beeps once per fixed-rule drive.** [BEEP1 §6.1](beep1-numeric-field-beep.md) recorded that `todo make-repeating` / `todo add-repeating` could not be driven in a clone at all, so *"their 0 counts are not evidence"* and the composite's beep behavior was covered only "by shared primitive". With the #597 write escape they drive, and the count is **3 for 3 non-zero** on fixed rules (`project make-repeating`, `project add-repeating`, `todo add-repeating`) against **2 for 2 zero** on after-completion rules (`todo make-repeating --after-completion`, both passes).
>
> The split points at the calendar-anchor / *Next:* leg: an after-completion drive touches neither (no weekday pop-up, no first-occurrence field), and it is the only arm that stays silent. Consistent with BEEP1's second source — the dialog rebuilding its control group after a frequency switch — but **not localized to a step**: the sentinel attributes to the mark, and the mark here wraps the whole verb. Isolating it needs a per-step mark inside the recipe, which is a follow-up, not a result.
>
> This is a user-audible defect in a shipped recipe: the drive succeeds, the series lands, and the user hears an error tone.

---

## 9. Verdict per cell

| cell | verdict |
|---|---|
| **C1** `todo complete <series>`, open occurrence present | ✅ **CERTIFIED** 6/6 — no mint, template byte-unchanged, `vector: url-scheme` `tier: 0` (no GUI needed) |
| **C2** `todo complete <series>`, mint arm | ✅ **CERTIFIED** 9/9 — CNC1 §6 / REPX3 §1.2 delta exactly |
| **C3** `todo cancel <series>` | ✅ **CERTIFIED** 6/6 |
| **C4** `todo update --exception` | ✅ **CERTIFIED** 8/8 — REPX3 §1.2 field for field + the one expected `umd` difference |
| **R1** live-slot refusal | ✅ **CERTIFIED** 4/4 — exit 4, zero mutation, no mint |
| **R2** cursor-less (paused) refusal, both composites | ✅ **CERTIFIED** 8/8 — exit 4 both, zero mutation |
| **AC** after-completion check-off | ✅ **CERTIFIED** 7/7; fixture via the shipped `--after-completion` promote (the §9.1 refusal is deadline-keyed) |
| **RES** resume after a CNC'd pause | ✅ **MEASURED** — resume flips one flag; the series is left unpaused with no anchor and no cursor (§5) |
| **TS1** `project.dissolve-heading` | ✅ **CERTIFIED** 6/6 end to end (first drive post-#589) + `umd` **BUMP** on all children |
| **TS2** `project.move-heading-to-project` | ✅ **CERTIFIED** 3/3 + heading `umd` **BUMP**, travelling child `umd` **SILENT** |
| **P1** `project add-repeating --when` | 🔴 **DEFECT** — exit 2, `params.next` usage error (§7) |
| **P1B** blast radius | ✅ characterized — both verbs, dated calls only (§7) |
| **P2** `project make-repeating` on a dated project | ✅ **CERTIFIED** 3/3 — first occurrence = the project's own date |

---

## 10. What this campaign changes elsewhere

* [reference/timestamps.md](../reference/timestamps.md) §2c — both residual `umd` cells move from **UNMEASURED** to **PROBED → BUMP**; the travelling-child silence is new.
* [capability-matrix.md](../capability-matrix.md) — `project.dissolve-heading` loses its "the corrected drive is NOT yet driven end to end" caveat; `project.move-heading-to-project` and the four template-mutation composite arms gain their guest certification.
* [things-app-oddities.md](../things-app-oddities.md) §19 — extended with the resume half (§5).
* [reference/assumption-register.md](../reference/assumption-register.md) — the CNC composite laws and the pause-clears-cursor law gain a `3.23 (CERTSWEEP1, golden-v4)` confirmation.
* **Open, for the maintainer:** the §7 defect (needs a fix + a regression test at the CLI→library seam), the §8 promote beep, the AC/C2 result reporting `tier: 0` for a composite that drove the GUI at tier 3 (the audit summary records ui/3; the returned result carries the status leg's), and the `Pause`-vs-`Resume` submenu label inconsistency in §5.
