# CGRD1 — closing the error class behind #589: no bare positional field, a pre-commit dialog audit, and unexplained-delta detection

**Probed under: `things-lab-golden-v4` · Things 3.23 (build 32300036) · DB v27 · macOS 15.7.7 · guest clock pinned 2026-07-05 (never rolled — the trial wall is 2026-07-18).** One disposable clone (`cgrd1-lab`), destroyed at the end. All fixtures synthetic. Driver: [`lab/scripts/research-cgrd1.sh`](../../lab/scripts/research-cgrd1.sh):

```sh
TART_HOME=/Volumes/Workspace/tart bash lab/scripts/research-cgrd1.sh setup     # clone + boot + airgap + clock pin + warm-up + guest helpers
                                                          … census   # §A/§B — the cadence group and the dialog shell, every mode
                                                          … ship     # build dist + push node/dist/commander + ui-enabled
                                                          … cert     # cells (a) (b) (c)
                                                          … teardown
```

[HXPC1](hxpc1-picker-assert.md) §A found ONE wrong address: the Repeat dialog inserts the ends-count field ahead of the interval when an ends bound is selected, so `text field 1 of group 1` was the interval at one moment and the count at the next, and the per-step read-back reported `OK` because it re-read the field it had addressed. #589 fixed that address. CGRD1 closes the **error class** — *a state-dependent AX tree addressed positionally, verified only against its own address* — with three guards, and measures the structure each of them rests on.

**Posture, ratified 2026-08-25:** AX surfaces are treated as undocumented private APIs, subject to change without warning. Every judgement below prefers **failing closed on an anodyne change** (a moved control, a renamed label) to being permissive and mutating a field nobody asked about.

---

## §A — the cadence group's label inventory, every mode

The hardened interval discriminator prefers a POSITIVE match on the `Every` label's row over HXPC1's negative "the field NOT on the `Ends:` row" rule. Whether that is safe depends on a mode HXPC1 never dumped the static texts of — after-completion. Measured:

| frequency | static texts | text fields | group pop-ups |
|---|---|---|---|
| daily | `Ends:`@375 · `Next:`@330 · `days`@286 · **`Every`@286** | #1=1 **@283** | 2 |
| weekly | `Ends:`@375 · `Next:`@330 · `weeks`@286 · **`Every`@286** · `on`@286 | #1=1 **@283** | 3 |
| monthly | `Ends:`@375 · `Next:`@330 · `on the`@286 · `months`@286 · **`Every`@286** | #1=1 **@283** | 4 |
| yearly | `Ends:`@375 · `Next:`@330 · `on the`@286 · `in`@286 · `years`@286 · **`Every`@286** | #1=1 **@283** | 5 |
| **after completion** | `after previous item is checked off.`@331 — **no `Every`, no `Ends:`** | #1=1 @328 | **1** |
| daily + `Ends: after` | `times`@375 · `Ends:`@375 · `Next:`@330 · `days`@286 · `Every`@286 | **#1=1 @372** (count) · **#2=1 @283** (interval) | 2 |

Three laws fall out, and they are what `AX_CADENCE_HANDLERS` encodes:

1. **The interval is matched positively on the `Every` row** in all four fixed frequencies (`Every`@286 against the field's @283 — a 3pt baseline offset, well inside the 8pt tolerance). In the two-field ends-after state that rule picks #2, which is correct.
2. **After-completion carries NEITHER label and offers exactly ONE field**, so it falls through to a UNIQUENESS check — not an index. The positive rule therefore cannot regress the after-completion path, which was the one real risk in adopting it.
3. **The ends-count REQUIRES the `Ends:` label.** No label, no count field: the drive refuses rather than inferring one.

Anything else fails closed reporting the whole numeric-field inventory. The pop-up counts also confirm the RDLG2 `next-popup` index fork independently (Ends + Next + the per-frequency controls: daily 2 · weekly 3 · monthly 4 · yearly 5).

## §B — the dialog SHELL, and the one address that had to be converted

The "and start [n] days earlier" offset shipped as `text field 1` of the dialog shell — a value-bearing numeric field picked by index out of a tree whose shape depends on the "Add deadlines" checkbox, verified only by re-reading the same index it wrote. Exactly the #589 shape. Measured across the states that reveal it:

```
deadlines OFF                : direct textfields=0 | statics: [Repeat]@269                                   | checkboxes=2 groups=1 popups=1
deadlines ON                 : direct textfields=1 #1=[0]@409 | statics: [days earlier]@413 [and start]@413 … | checkboxes=2 groups=1 popups=1
deadlines ON + reminders ON  : direct textfields=1 #1=[0]@409 | statics: [days earlier]@413 [and start]@413 … | checkboxes=2 groups=1 popups=1
```

So the old spelling was **right by luck, not by construction**: the shell holds no direct text field until the box is ticked and exactly one afterwards, ticking reminders as well does not add another — but nothing in the address said any of that. It is now the field sharing the `days earlier` label's row (@413 against the field's @409), through the same handler family as the cadence numbers, fail-closed on a missing label or a non-unique row.

The same census justifies three addresses that were KEPT positional:

* `pop up button 1` (frequency) — the shell's **only** direct pop-up in every state (`popups=1`);
* `group 1` (the cadence group) — the shell's **only** group (`groups=1`), and a container handle whose every consumer discriminates within it;
* `checkbox "Add deadlines"` / `"Add reminders"` — title-addressed already (`checkboxes=2`).

## §C — certification cells (production CLI, `--dangerously-drive-gui`, guest SQLite oracle)

Fixtures are built the REPX2/REPX3 way — a URL-scheme add plus a direct AX Repeat-dialog drive — because `make-repeating` carries an AppleScript leg and the Wave A write gate returns `direct-unknown` for every sshd-descended shell ([CNC1 §9](cnc1-template-mutations.md)). `reschedule-repeat` is pure-ui, so it IS reachable under `THINGS_API_UI_DIRECT=1`. The template uuid is looked up by title AFTER the seed drive (the CNC1 `tmpl` rule): committing the dialog mints a template and an instance, and assuming the seed row is the one carrying the rule is a rig failure that reads like a finding — the first pass made exactly that mistake and reported five red cells for it.

**(a) a clean reschedule passes the audit and lands — PASS.** `todo reschedule-repeat <t> --frequency daily --interval 3 --ends-after 4`:

```
drove 11 step(s): reveal … → Items ▸ Repeat submenu → Items ▸ Repeat ▸ Edit Rule…
  → the Repeat dialog → frequency = daily → interval = 3 → ends = after → ends after = 4
  → audit the Repeat dialog against the requested rule (before committing) → press "OK"
EXIT=0
before: tp=0 fu=256 fa=1 ts=0 rc=0 of=[{wd=0(Sun)}]
after : tp=0 fu=16  fa=3 ts=0 rc=4 of=[{dy=0}]        <- daily · interval 3 · ends-after 4
```

The audit is a real step in the shipped stream, and it sits between the last control and the OK press.

**(b) a poisoned intended value aborts pre-commit with ZERO database delta — PASS.** The dialog is driven to a known state (daily / interval 3) and then handed the SHIPPED audit script text emitted out of `dist/`, once honestly and once with one intended value deliberately wrong — the test seam, so the thing under test is the thing that ships:

```
honest audit   (intended daily/3): OK
poisoned audit (intended daily/9): execution error: the Repeat dialog does not hold what this
  drive entered — 1 control(s) differ: interval (intended "9", dialog shows "3")
rule after the aborted drive: IDENTICAL to before (byte-for-byte)
```

Note what the refusal does NOT say: the frequency, which did hold, is not reported. Only the control that differs is named, with both values.

**(c) the CONVERTED start-offset address drives — PASS.** The one address guard 1 converted rather than justified, exercised end to end through the production CLI (`--deadline --start-days-earlier 2`):

```
drove 11 step(s): … → frequency = weekly → interval = 1 → Add deadlines → start 2 days earlier
  → audit the Repeat dialog against the requested rule (before committing) → press "OK"
EXIT=0
after: tp=0 fu=256 fa=1 ts=-2 … dl=4001-01-01     <- the offset landed; the template is deadlined
```

**Totals: 16 assertions, 0 failures.**

---

## §D — what the guards are, in one line each

* **Guard 1 — no bare positional field addressing.** Every `<class> <N>` selector in `ui-recipes.ts` / `ui.ts` / `ui-drag.ts` either carries a `// positional-ok:` marker naming the measured reason it is safe, or it does not ship. `test/unit/positional-addressing.test.ts` scans the three files and fails on a new one; the marker must sit on the offending line or in the comment block directly above it, so a marker cannot drift over to cover an address added later.
* **Guard 2 — the pre-commit full-dialog audit.** Assembled from the recipe's OWN step list (so a control it drives cannot be omitted from the audit), run as the last step before OK, re-reading every control through its own discriminated address — the numbers through the label-row handlers, the pop-ups by value, the weekday rows as a set, the occurrence pop-up by parsed date, and the three `AXDateTimeArea`s through the same ObjC-bridge walk that writes them. Any mismatch names every differing control with both values and aborts through the standard clean-abort path.
* **Guard 3 — unexplained-delta detection.** Post-drive, the decoded rule is diffed pre versus post over the RRF1 vocabulary; every changed field must be attributable to a requested field or to an explicitly mapped co-mover carrying its law. An unattributable one is the new `verify-failed:collateral`.

## §E — what remains open

* **On-device certification.** Everything here is `lab-certified`; the ui vector's on-hardware confirmation is unchanged ([ui-certification-runbook](ui-certification-runbook.md)).
* **The audit's date-area leg is not driven by a cell.** Cells (a)–(c) exercise the System Events sweep; the JXA `AXDateTimeArea` leg is unit-tested against its generated source and shares its walk and target discriminator with `axSetDateTimeScript` by construction (one shared prelude), but no cell drives an `--ends-on` / `--reminder` reschedule end to end. A next sitting should carry one.
* **Guard 3 covers reschedule only.** `make-repeating` / `add-repeating` MINT the rule, so there is no pre-state to diff — every field is new by construction. If a future verb rewrites an existing rule, it should carry the same `collateral` block.
