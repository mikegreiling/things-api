# FGRD1 — the GUI-drive focus/liveness hardening, certified (issue #620)

**Version stamp:** `things-lab-golden-v4` · Things **3.23** (CFBundleVersion **32300036**) · macOS **15.7.7** · databaseVersion **27** · guest clock pinned **2026-07-05 12:00** and never rolled (trial wall 2026-07-18) · one disposable airgapped clone, destroyed on teardown. Immutable snapshot per the [harness](harness.md) version-stamping policy.

Driver: [`lab/scripts/research-fgrd1.sh`](../../lab/scripts/research-fgrd1.sh) (`setup` / `ship` / `cells` / `cells2` / `cells3` / `cells4` / `cells5` / `teardown`). Every cell ran through the **production CLI** built from this branch and shipped into the guest (`dist/` + node + commander), with both lab escapes exported (`THINGS_API_UI_DIRECT=1 THINGS_API_WRITE_DIRECT=1`). Fixtures are fully synthetic (`FGRD1 alpha…golf`) plus the golden's own `LAB-AREA-A`.

**Beep sentinel: 0 across every pass** (five passes, allowed 0, clean each time).

---

## 0. What was under test

The field incident behind #620: a `make-repeating` drive completed its semantic AX steps, then died typing the interval with System Events error 1002; Escape did not dismiss the leftover Repeat sheet; a stranded clone resisted cleanup while the database showed it present; and the restored original came back in the Inbox with no schedule. The hardening under certification here is the whole seven-point scope — the osascript seam's refusal, the per-step focus guard, the audited cleanup ladder, the read-only census, the ghost-clone convergence, and the already-correct-value skip.

---

## 1. U — the read-only census, all four quadrants

`things ui-state --json`, with no keystroke, click or activation of its own.

| cell | screen | `sheetKind` | `thingsFrontmost` | `focusOwner` | sync warning |
|---|---|---|---|---|---|
| U1 | no dialog, Things front | `none` | true | `Things3 · AXTable` | — |
| U2 | no dialog, Finder front | `none` | false | `Finder · AXGroup` | — |
| U3 | Repeat dialog, Things front | **`repeat`** (`attached`, census `cb:2 pu:1 bt:2 gp:1 tf:0`) | true | `Things3 · AXPopUpButton` | present |
| U4 | Repeat dialog, Finder front | **`repeat`** (`attached`, same census) | false | `Finder · AXGroup` | present |

The dialog is identified from its CONTROL CENSUS, never a localized title — and the census reads identically whether Things owns the screen or not, which is the property the guard depends on. The payload carries role counts and element roles only: no control value, no window title, nothing a bug report could leak.

---

## 2. C — the app-wide AppleScript freeze (the "ghost clone", closed)

The field report's unexplained state was a clone the database showed open and untrashed while `things todo delete` answered *"AppleScript could not get that to-do ID"*. Measured here directly, with a hand-opened Repeat dialog and nothing else changed:

```
C4a  delete WITH the dialog open   → Things3 got an error: Can’t get to do id "…". (-1728)   trashed=0
C4b  the SAME delete, dismissed    → (no error)                                              trashed=1
```

**Verdict: there is no ghost.** An open modal dialog wedges Things' AppleScript object model app-wide — the row is perfectly present, and the app refuses to *address* it until the dialog goes away. This is [oddities §9cc](../things-app-oddities.md) (SESSGATE, 2026-08-16) reproduced on 3.23 through the Repeat sheet: no object cache, no pending-trash row state, no id-vs-uuid problem. The cleanup convergence therefore is not a retry-on-another-vector — it is *dismiss the dialog first*, which the cleanup ladder now does before the compound's AppleScript legs run, and which the failure copy names when a leg still cannot land.

**The first pass proved it so thoroughly that it contaminated its own later cells** — worth recording, because it is the same trap a user falls into. Pass one left the U3 dialog open and its Escape went to *Finder* (the very bug under test), so cells S1/T1/C2 never reached their drive: each died at its first AppleScript leg with the same −1728, exactly as the field incident's follow-up commands did. Pass two (`cells2`) dismisses with an activate-then-Escape-then-VERIFY loop between cells.

---

## 3. T — focus theft mid-drive (the headline cell)

`todo make-repeating --frequency weekly --interval 3 --dangerously-drive-gui`, with a guest-side closed loop that polls for the Repeat dialog's existence and activates **Finder** the instant it appears (never a sleep). Interval 3 is deliberate: the default 1 would be skipped by §5 and no keystroke would fire at all.

Result — the drive got through every ELEMENT-addressed step with Finder in front, and refused at the first keystroke:

```
ui drive stopped at "interval = 3" (refused to run "interval = 3": Finder is frontmost and
keyboard focus is on a AXGroup, so the input would go there instead of to Things — nothing was
sent. Leave Things in front while it is being driven, then run the same command again).
Completed: reveal … → bring Things to the foreground → confirm the target is selected …
→ Items ▸ Repeat… → the Repeat dialog → frequency = weekly.
the repeat dialog was closed with its own Cancel button, confirmed closed (Finder is frontmost
and keyboard focus is on a AXGroup when cleanup started).
```

- **Nothing was typed.** No keystroke hop was dispatched after the guard's refusal.
- **The abort names the focus owner** — the application AND the focused element's role.
- **The cleanup recovered without stealing focus back**: the dialog was closed by its own Cancel button (an element press works while the app is in the background), and a fresh census afterwards reads `sheetKind: none` with Finder still frontmost.
- **Zero mutation**: the target is not repeating, not trashed, its placement byte-identical, and exactly one copy of it exists — the disposable clone was moved to the Trash by the rollback.
- Beeps: 0.

---

## 4. P — the rollback puts the original back where it was

A to-do created with an area (`LAB-AREA-A`) and `when=today`, then failed the same way:

```
before  area=7Ck4hAXU36jyaBsy2Fkije | startDate=132805248 | start=1
after   area=7Ck4hAXU36jyaBsy2Fkije | startDate=132805248 | start=1     → RESTORED byte-identical
```

and the reported detail says what it did and why:

> the original to-do (uuid …) was restored from the Trash — a scripted restore returns a to-do to the Inbox with no schedule, so its area and its "when" (2026-07-05) restored; the disposable copy this command made (uuid …) was moved to the Trash

This closes the field report's "the restored original appeared in Inbox, unscheduled": that is not an app bug but the documented behavior of the only scriptable restore (`move … to list "Inbox"`, E15), which the compound now compensates for. The Inbox-native case is reported honestly too (`it was already in the Inbox, unscheduled` — cell T).

---

## 5. S — the already-correct value is not typed

`todo make-repeating --frequency daily --interval 1 --after-completion` on a fresh to-do. The completed-steps trail:

```
… → frequency = after completion → after-completion unit = daily → interval = 1 (already set)
→ audit the Repeat dialog against the requested rule (before committing) → press "OK"
```

`ok: true`, the template and its instance landed, **zero beeps**. The interval keystroke class disappears entirely for the default — the exact hop the field incident died on. Correctness is not weakened by the skip: the pre-commit dialog audit (CGRD1) re-reads every control through its own address immediately before the OK press, so a wrongly-skipped field could not commit.

---

## 6. R — the osascript seam refuses instead of degrading identity

Driven directly against the shipped `dist/deputy/osa.js` with a script whose effect is VISIBLE (activating Finder), so the refusal is provable by the absence of the side effect — and paired with a positive control, per the CNCAC1 rule that a negative from an unproven oracle is not evidence.

| cell | mode | result |
|---|---|---|
| R1 | `THINGS_API_HELPERS=true`, no deputy installed | `exitCode 126`, `refused: true`, copy names a *live, healthy deputy* + `things helpers status` — **frontmost after: Things3** (Finder never came forward: the script did not run) |
| R2 | `THINGS_API_HELPERS=false` (positive control) | `exitCode 0`, `refused: false` — **frontmost after: Finder** (the identical script DID run) |
| R3 | the CLI's own `make-repeating` with helpers expected | refuses before any drive; nothing created (`repeating? 0`) |

R3 records an honest ordering fact: at CLI level the READ gate speaks first (*"the helpers are enabled on this machine but are not serving reads"*), so a user with a dead deputy is stopped before the write path is reached at all. The seam's own refusal is the backstop for every caller that gets past it — and R1 proves it is real.

---

## 7. P2 — the composite refuses BEFORE it seeds, and −1728 is named

Second pass, fresh clone, after [MODALX1](modalx1-open-sheet-matrix.md) landed its guard requirements. With a Repeat dialog standing (opened by hand) and the shipped CLI:

```
$ things todo make-repeating <uuid> --frequency daily --interval 2 --dangerously-drive-gui --json
EXIT=4  blocked:environment
  "a dialog is already open in Things, and while one is open the app ignores changes like this
   one and stops sending anything to Things Cloud — nothing was created"
  remediation: dismiss the dialog … ; `things ui-state` shows what is open
      rows titled '<fixture>': before=1  after=1     <- NO copy minted
      the original: trashed=0                        <- untouched
```

That is the gap MODALX1 measured, closed: the composite's clone leg rides the URL scheme, which an open dialog does not touch, so it used to LAND and then strand a copy when every AppleScript leg after it failed. The census is asked before the seed, and only a POSITIVE sighting refuses (an unreadable census proceeds — the drive's own precondition is the backstop).

The same standing dialog, through `things todo delete`:

```
verify-failed:silent-noop … Can’t get to do id "…" (-1728)
likelyCause: "modal-open"
remediation: "…what it says about an item that IS there whenever a dialog is open somewhere in
              the app … Run `things ui-state` … dismiss it … nothing was changed."
```

and after dismissal the identical command returns `ok`. The error code that meant nothing now names its one cause.

## 8. D — `--when <today>` (issue #625), and what was hiding behind it

The matrix, weekly rules on a clock pinned to Sunday 2026-07-05:

| `--when` | before | after |
|---|---|---|
| `2026-07-05` (today) | **exit 3** — the audit refused its own correct write | **ok** |
| `2026-07-06` (tomorrow) | ok | ok |
| `2026-07-12` (+7d) | ok | ok |
| `2026-09-22` (far) | ok | ok |

**The audit's comparator was string-matching a rendered value.** Measured (cell N): with the clock on a Sunday and a weekly-Sunday rule, the first-occurrence control's value IS the word `Today`, and its menu offers `Today, Sun, Jul 12, 2026, Sun, Jul 19, 2026, …, More…` — so the pre-commit audit compared `"2026-07-05"` against `"Today"` and aborted the drive it had just performed correctly. The comparator now RESOLVES the app's relative renderings against the app's own clock (Today / Tomorrow / Yesterday / a weekday name inside the coming week), the same way the selector already resolves them, and falls through to the existing date parse — and to a fail-closed mismatch — for anything else.

**Fixing that exposed a second false negative, and it is #508's shape one case over.** With the audit passing, the today case still failed: *"the series was created but its first occurrence landed on 2026-07-12, not the requested 2026-07-05"*. The database says otherwise:

```
template   icStart=2026-07-12  next=2026-07-12  instanceCreationCount=1
instance   startDate=2026-07-05                      <- the requested occurrence, materialized
```

Committing a rule whose first occurrence is TODAY makes the app materialize that occurrence immediately and ADVANCE the cursor to the next slot. The post-drive check read only the cursor, so it reported a wrong phase on a series that landed exactly as asked. It now accepts either oracle — the cursor naming the requested date, OR a materialized instance sitting on it — and still refuses when nothing sits on the requested day. Re-run on fresh fixtures: 4/4 `ok`, the today case with its instance on 2026-07-05, **0 beeps**.

*(Worth a maintainer's ruling: `rt1_instanceCreationStartDate` is documented in this codebase as "the app-materialized first occurrence", and for a same-day rule it is not — it is the NEXT slot. That is app behavior, recorded here rather than in the oddities register, which this campaign did not own.)*

## 9. What this campaign does NOT establish

- **The original 1002 keystroke failure is still unreproduced.** Nothing here recreates it; the hardening makes its *shape* impossible to reach silently (a refusal, named, with nothing typed) rather than explaining that particular afternoon.
- **The sync gate is cited, not re-measured here.** The open-dialog Things Cloud gate is the maintainer's field A/B (an airgapped clone has no account to sync). The census and the copy report it; [oddities](../things-app-oddities.md) owns the evidence entry.
- **No secure system modal was staged.** The `inspectable: false` branch is unit-covered and reasoned from the AX model (macOS exposes no tree for one); a live cell would need a real consent prompt on a machine nobody is watching.
