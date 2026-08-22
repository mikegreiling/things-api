# RDLG2 — the Things 3.23 repeat-dialog recipes, adapted and certified

**Version stamp:** certification arm `things-lab-golden-v4` · Things **3.23** (CFBundleVersion **32300036**, direct-download channel) · databaseVersion **27**; regression arm `things-lab-golden-v3` · Things **3.22.14** (**32214000**) · databaseVersion **26**. Both: macOS **15.7.7 (24G720)**, airgapped clones, guest clock pinned **2026-07-05 12:00 (a Sunday)**, AXVM1 accessibility grant baked. Immutable snapshot per the [harness](harness.md) version-stamping policy.

Drivers: [`lab/scripts/research-rdlg2a.sh`](../../lab/scripts/research-rdlg2a.sh) (the dialog census RDLG1 left open) · [`lab/scripts/research-rdlg2b.sh`](../../lab/scripts/research-rdlg2b.sh) (the non-dialog repeat surfaces) · [`lab/scripts/research-rdlg2c.sh`](../../lab/scripts/research-rdlg2c.sh) (the 3.23 certification, production CLI `--dangerously-drive-gui`) · [`lab/scripts/research-rdlg2d.sh`](../../lab/scripts/research-rdlg2d.sh) (the ≤3.22 regression arm) · [`lab/scripts/research-rdlg2e.sh`](../../lab/scripts/research-rdlg2e.sh) (the derived-projection-day certification). Fixtures fully synthetic (`RDLG2-*` / `RDLG2B-*` / `RDLG2C-*` / `RDLG2D-*` / `RDLG2E-*`, plus the golden's own `LAB-*` seed).

Predecessor: [rdlg1-323-repeat-dialog-census.md](rdlg1-323-repeat-dialog-census.md) — the census this campaign acts on, and **corrects in one place** (§1.1 below).

---

## 0. Headline

The Things 3.23 Repeat dialog is drivable again, and the **same binary still drives Things 3.22.14** — the recipe measures which dialog is open instead of asking the app its version. Three things changed shape, one capability was **lost by the app**, and one long-standing defect of ours is **fixed**:

| | 3.22.14 | 3.23 | What shipped |
|---|---|---|---|
| per-frequency pop-up indices | Ends 1, then weekday/anchor at 2… | the occurrence pop-up takes 2, anchors shift to 3… | ONE recipe carrying BOTH index sets, selected by a live `probe-dialog-shape` step |
| first occurrence (`--when`) | free-form `AXDateTimeArea` — ANY date | a bounded MENU of the rule's own occurrences | a `select-next-occurrence` primitive; **off-rule dates are now unreachable and fail closed** |
| `Items ▸ Repeat ▸ …` | `Reschedule…` | `Edit Rule…` | both spellings as ordered path candidates |
| multi-weekday drive | blind "+"-then-redrive-row-1 — left STALE weekdays on a pre-populated dialog (RRD1) | same trap | a `converge-weekdays` closed loop — certified on BOTH versions, grow AND shrink |

Certification: **21/21 cells green** on golden-v4 (RDLG2c) and **the regression arm green** on golden-v3 (RDLG2d) after the arm caught a real defect in the first shape probe (§2.2).

---

## 1. The census RDLG1 left open (RDLG2a, golden-v4)

### 1.1 `Next: ▸ More…` is NOT a date picker — it is more of the same menu

The single most consequential open cell. `More…` opens a **cascading submenu of further on-rule occurrences** — 101 items per level, each level ending in another `More…`, generated lazily about ten years out (the dump reaches `Sun, May 11, 2036` at depth five). There is no calendar affordance, no text field, nothing that accepts an arbitrary date.

```
AXPopUpButton val="Today" id=_NS:144
  AXMenu
    [1]  AXMenuItem ttl="Today"             id=nextDateOptionAction:
    [2]  AXMenuItem ttl="Sun, Jul 12, 2026" id=nextDateOptionAction:
    …
    [15] AXMenuItem ttl="Sun, Oct 11, 2026" id=nextDateOptionAction:
    [16] AXMenuItem (separator)             id=_popUpItemAction: DISABLED
    [17] AXMenuItem ttl="More…"
           AXMenu
             [1]   AXMenuItem ttl="Sun, Oct 18, 2026" id=nextDateOptionAction:
             …
             [102] AXMenuItem ttl="More…"  → (and so on, ~5 levels captured)
```

**Consequence — an app-side capability regression.** Through 3.22 the `Next:` control was a free date field, so a series could be started on an **off-rule** first occurrence (a weekly-Sunday rule first landing on a Wednesday — the ANCH2 / RSPA1 / DACON1 vocabulary). Under 3.23 the dialog can express only `Today` and dates the rule itself produces. This is not a recipe gap we can engineer around: the affordance is gone. Recorded in [things-app-oddities.md §11](../things-app-oddities.md); the recipe fails closed with the reason (§3.3, cell C9).

**Consequence — addressing.** Every occurrence item carries `AXIdentifier = nextDateOptionAction:` (the separator carries `_popUpItemAction:`), a locale-proof marker for "this item is an occurrence". Titles are localized (`Sun, Jul 12, 2026`), so the drive PARSES each title to a date rather than rebuilding the app's display string.

### 1.2 The weekday machinery: rows are INSERTED at the front

Weekly mode, driven a row at a time on a fresh dialog:

| state | group pop-ups | group buttons |
|---|---|---|
| 1 weekday row | Ends · Next · **Sunday** | 1, at x=525 |
| after one "+" | Ends · Next · **Sunday (new)** · Monday | 4 — two per row, x=525 and x=548 |
| after two "+" | Ends · Next · **Sunday (new)** · Sunday · Thursday | 6 — two per row |

Two laws fall out, and both matter to the drive:

1. **A new row is inserted AT THE FRONT of the enumeration** (`pop up button 3`), pushing every existing weekday row one index later. The shipped "press +, then re-drive the same index" therefore rewrote the row it had just added, which is exactly the RRD1 trap.
2. **Each row carries two title-less `AXButton`s once there are ≥2 rows** (one at x=525, one at x=548); a lone row has only the x=525 one. Pressing the **smaller-x** button always ADDED a row (measured three times, at three different y positions), and pressing the **larger-x** button REMOVED one (cell C14: group pop-ups 5 → 4). Their enumeration order is unstable — `[1]=(525,297) [2]=(548,297) [3]=(548,272) [4]=(525,272)` for two rows — so index-addressing them is not sound; the drive resolves the add button by live geometry (smallest x).

The shipped converge uses the add button only. It never presses remove: surplus rows are set to a DUPLICATE of a target weekday, and the app stores the weekday set deduplicated, so a SHRINK needs no removal (certified end to end, cell C12). One less gesture whose renumbering behavior would have to be modeled.

### 1.3 `Ends`, reminders, deadlines — unmoved

| control | 3.23 measurement | verdict |
|---|---|---|
| `Ends = after` | the group gains a SECOND text field; the count field is child **[2]** (`@402,372`, beside the `times` label) and the interval is child **[10]** (`@311,283`) — so `text field 1 of group 1` IS the count once Ends is `after` | unchanged; the shipped order (interval driven FIRST, while it is the sole field) is still what keeps them apart |
| `Ends = on date` | one `AXDateTimeArea` appears at the Ends row (y=373); the group's field count returns to 1 | unchanged — and, because the first occurrence is no longer a date area, this is now the ONLY date area in the dialog, so the `ends` target is unambiguous by construction |
| `Add deadlines` | reveals the "start N days earlier" field as `text field 1` of the SHEET (value `0`) | unchanged |
| `Add reminders` | reveals a single `AXDateTimeArea` at y=417 with a non-midnight 12:00 default | unchanged — the time-of-day discriminator still separates it from the midnight pickers |
| occurrence preview | a static text (`",  7/12/26,  7/19/26, …"`) — but it is EMPTY under `Ends = after` and `Ends = on date`, and its child index moves between states | **rejected as the read-back oracle**; the drive reads the *control it just set* back instead (the pop-up's own value, the checkbox's value, the field's text) |

### 1.4 `Edit Rule…` opens the same dialog, pre-populated

The renamed menu item opens a byte-identical sheet whose controls carry the template's current rule (`frequency = daily`, `Next: = Mon, Jul 6, 2026`). A pre-populated MULTI-weekday rule comes back with its rows in the reverse of creation order (created `{Sunday, Wednesday}` → reopened as `3=Wednesday, 4=Sunday`), which is harmless for a converge that assigns every row.

---

## 2. The recipe changes

### 2.1 One probe, two index sets

`repeatDialogEntry` emits a `probe-dialog-shape` step immediately after the interval field and **only when a shape-dependent control is actually addressed** (weekday set, monthly/yearly anchor, or `--when`). A bare `--frequency daily --interval 3` drives exactly the certified two-control path with no extra osascript hop, and an after-completion rule — whose cadence group has no calendar row at all — never probes.

Steps then declare their dependence explicitly:

- `shaped: { "next-popup": …, legacy: … }` — merged into the step once the shape is known (the monthly/yearly pop-up indices, and the weekday converge's row base index);
- `onlyShape: …` — the step runs only under that shape (the two first-occurrence drives, which are different PRIMITIVES, not merely different paths).

A shape-dependent step reached with no measured shape, or a shape with no entry, is a fail-closed refusal (recipe bug), and a dialog matching neither shape refuses the whole drive with the dialog cleared.

### 2.2 The probe discriminates on the CONTROL, not the label — a defect the regression arm caught

The first implementation keyed on the presence of the `Next:` static text, on RDLG1's reading that the label is new in 3.23. **It is not.** Driven against golden-v3, the probe returned `next-popup` on Things 3.22.14, whose weekly cadence group reads:

```
popups=2  fields=1  buttons=1  statics=7  dateAreas=1
  popup 1 = never        (Ends)
  popup 2 = Sunday       (weekday)
  static 3 = Ends:
  static 4 = Next:       <- present on 3.22.14 too
  static 1 = ,  7/12/26,  7/19/26, …   <- so is the occurrence preview
```

The misread cost exactly what a wrong index costs: the converge grew the dialog to rows 3 and 4 (which did not exist yet), set those, and left the REAL first row at its default — `--weekdays monday,thursday` committed `{Sunday, Monday, Thursday}`, caught fail-closed by verify-per-write (`verify-failed:mismatch`, `anchorKey w0,w1,w4`). No wrong rule was reported as landed.

The shipped probe therefore reads the `Next:` label's **row position** and asks which control class shares that row: an `AXPopUpButton` → `next-popup`, an `AXDateTimeArea` → `legacy`, neither → `unknown` (refuse). Both branches are positive matches, and anchoring on the row keeps the probe independent of the Ends state (an `Ends: on date` bound adds a second date area on a *different* row in both versions). Corrects [rdlg1](rdlg1-323-repeat-dialog-census.md) §1's "the single cause of the +1 shift is the new `Next:` pop-up" — the pop-up is new, the LABEL is not.

### 2.3 `select-next-occurrence`

Opens the pop-up (the same self-healing open every pop-up drive uses), then walks its items: each title is parsed to a date (direct `date` coercion, retried after stripping a leading weekday token), and the first item matching the request is clicked. When the request is today and the first item is not date-parseable (it is `Today`), that item is taken. Unmatched levels descend the trailing `More…` submenu to a **bounded depth of 6** (~600 occurrences). A miss raises the named error the drive surfaces verbatim:

> select-next-occurrence: this Repeat dialog offers only the rule's own upcoming occurrences (and today) as the first occurrence, and 2026-07-22 is not one of them — searched 1 level(s) of the Next: menu. Ask for a date the rule actually produces, or change the rule.

After the click the pop-up's value is read back and must equal the clicked item's own title.

### 2.4 `converge-weekdays` (the RRD1 fix)

One step for the whole weekday set, on both dialog shapes:

1. read the live row count (`group pop-ups − base + 1`, base 2 legacy / 3 next-popup);
2. while short of the target count, press the row-add button — resolved as the **smallest-x** button in the group, from live geometry;
3. assign EVERY row from the target set, **cycling** — so a surplus row duplicates a target weekday rather than keeping a stale one;
4. read every row back; error unless the row set equals the target set exactly.

The cycling assignment is what makes a SHRINK possible without the unverified remove button: `{tue,thu,sat}` → `{friday}` assigns Friday to all three rows and the app collapses them to one. Certified in both directions (cells C11/C12, D4).

### 2.5 `Edit Rule…` / `Reschedule…`

The submenu anchor (`Items ▸ Repeat`) stays a canaried static resolve — it only exists on a selected template, which is the real precondition — and the ITEM press became an ordered candidate pair (`Edit Rule…` first, `Reschedule…` second). Neither present is a fail-closed miss naming the step.

---

## 3. Certification — golden-v4, Things 3.23, production CLI (RDLG2c)

Every cell: a fresh synthetic to-do created through the URL scheme, then the shipped `things` binary with `--dangerously-drive-gui --json`, then the rule read back out of SQLite (`rt1_recurrenceRule` decoded; `dy`/`mo` are 0-based in the blob, `fu` is the unit code and `fa` the interval).

| cell | command | rule read back | verdict |
|---|---|---|---|
| C1 | `make-repeating --frequency daily --interval 3` | `fu=16 fa=3 of=[{dy=0}]` | PASS (no shape probe emitted — the certified two-control path) |
| C2 | `--frequency weekly --weekdays monday,thursday` | `of=[{wd=1(Mon)},{wd=4(Thu)}]` | PASS — **the maintainer's example**, no stray Sunday |
| C3 | `--frequency monthly --on-day 15` | `fu=8 of=[{dy=14}]` | PASS |
| C4 | `--frequency yearly --yearly-month 10 --on-day 8` | `fu=4 of=[{dy=7,mo=9}]`, first occurrence 2026-10-08 | PASS |
| C5 | `--frequency monthly --on-weekday friday --on-ordinal last` | `of=[{wd=5(Fri)},…]` | PASS |
| C6 | `--ends-after 5` · `--ends-on 2027-01-01` | both drove `ok` | PASS |
| C7 | `--weekdays wednesday --deadline --start-days-earlier 3` | `of=[{wd=3(Wed)}] ts=-3 tmplDeadline=4001-01-01` | PASS |
| C8 | `--weekdays sunday --when 2026-07-19` (ON-rule) | `icStart=2026-07-19` | PASS — the new pop-up drive lands the requested occurrence |
| C9 | `--weekdays sunday --when 2026-07-22` (OFF-rule) | no template minted | PASS — refused with the named reason, zero mutation |
| C10 | `reschedule-repeat --interval 4` | rule rewritten | PASS — through the renamed `Edit Rule…` |
| C11 | `reschedule-repeat --weekdays tuesday,thursday,saturday` on a pre-populated `{mon,wed}` | `of=[{wd=2},{wd=4},{wd=6}]` | PASS — **the RRD1 trap is closed**; no stale weekday survived |
| C12 | `reschedule-repeat --weekdays friday` on `{tue,thu,sat}` | `of=[{wd=5(Fri)}]` | PASS — the shrink path |
| C13 | `add-repeating 'RDLG2C-ADD' --weekdays tuesday --when 2026-07-07` | `of=[{wd=2(Tue)}]` | PASS — the clone→trash→promote composite is unaffected |

**21 assertions, 0 failures.**

The drive trail the CLI reports for a full-vocabulary cell (C7) shows the new step in place:

```
reveal → activate → assert-eligible → Items ▸ Repeat… → the Repeat dialog → frequency = weekly
  → interval = 1 → measure the Repeat dialog's shape … (next-popup) → weekdays = wednesday
  → Add deadlines → start 3 days earlier → press "OK"
```

---

## 4. Regression — golden-v3, Things 3.22.14, the SAME binary (RDLG2d)

| cell | expectation | result |
|---|---|---|
| D1 | the probe reads `legacy` | PASS — `legacy` (this is the cell that FAILED before §2.2's fix, and the failure is the whole reason the arm exists) |
| D2 | `--weekdays monday,thursday` at the legacy indices | PASS — `of=[{wd=1(Mon)},{wd=4(Thu)}]` |
| D3 | reschedule through the OLD `Reschedule…` spelling, retargeting to `{friday}` | PASS — `of=[{wd=5(Fri)}]` |
| D4 | RRD1 grow `{mon,wed}` → `{tue,thu,sat}` | PASS — no stale weekday survived; the converge fixes the trap on 3.22 as well |
| D5 | an OFF-RULE first occurrence still lands (`--when 2026-07-22` on a weekly-Sunday rule) | PASS — `icStart=2026-07-22`; the legacy date-area write is unchanged, so the capability 3.23 removed survives where the app still offers it |
| D6 | monthly + yearly anchors at the legacy indices | PASS — `of=[{dy=14}]` and `of=[{dy=7,mo=9}]` |

**11 assertions, 0 failures** (run `rdlg2d2-lab`). The pre-fix run is kept as `rdlg2d-lab`: it is the evidence for §2.2, and for the claim that a mis-measured shape is caught by verify-per-write rather than committed (`verify-failed:mismatch`, `anchorKey w0,w1,w4`, zero mutation reported as success).

---

## 5. The other 3.23 repeat surfaces (RDLG2b + RDLG2c census cells)

### 5.1 `File ▸ New Repeating To-Do` — a real direct-create path, but not a replacement

The menu item opens the Repeat dialog **immediately, on nothing** — no row exists yet (TMTask count unchanged at the menu click), and the dialog opens in its `after completion` default. Pressing OK mints the series: **+2 rows — the template and its first instance** — and leaves the new row in inline title edit, where typed text + Return names it (certified: `RDLG2C-NEWREP`, `fu=16 fa=1`, `icCount=1`).

Measured against `add-repeating`'s clone → trash → promote composite:

- **What it saves:** the clone and the trash legs, and the source-fate reasoning around them.
- **What it costs:** the title is the ONLY attribute reachable (by keystroke, into an inline editor), where the composite seeds a fully-specified to-do through the URL scheme first (notes, tags, container, checklist, deadline) and only then promotes; and the GUI hands back no uuid, so the new template still has to be discovered by title+timestamp probing — the same machinery, now with a keystroke-typed title as its only key.

**Verdict: probe only, no engine change.** It is the right primitive for a bare titled series and the wrong one for the vocabulary `add-repeating` actually accepts. Recorded so the option is not re-litigated from scratch.

### 5.2 `Items ▸ Repeat ▸ Create Next Copy` — materialize-and-advance

On the seeded daily template (cursor `next = icStart = 2026-07-06`, `icCount = 3`), one press:

- **materializes** a new instance row dated 2026-07-06 (`rt1_repeatingTemplate` set, `status=0`, untrashed);
- **advances the cursor** to 2026-07-07 and bumps `icCount` 3 → 4.

So it is exactly "spawn the pending occurrence now", with the same cursor bookkeeping the clock-arrival spawn does. No dialog, no confirm, app stays alive.

### 5.3 Early-completing an instance does NOT advance the series

Completing a future-dated instance (`set status to completed`, the scriptable equivalent of 3.23's new instance checkbox) sets `status=3` + `stopDate` on that row and leaves the template **byte-unchanged**: cursor still 2026-07-07, `icCount` still 4, no new instance. Early completion is an instance-level act on this surface, not a series advance.

### 5.4 The Make Exception / Update Rule chooser — still NOT reproduced

Four attempt vectors against a fixed-schedule instance of a daily series, all honest negatives:

| vector | outcome |
|---|---|
| `Items ▸ When…` → type `tomorrow` → AXPress the filtered row | the picker filters correctly (window collapses to 341×173, a single `AXUnknown desc="Tomorrow"` row), but **no chooser appeared and the instance's `startDate` did not move** in either attempt; the second attempt's `entire contents` walk did not find the row to press at all |
| AppleScript `schedule to do id <instance> for <date>` | re-dated cleanly — `startDate` 2026-07-05 → 2026-07-09 — **no chooser**, no error, app alive |
| URL scheme `things:///update?id=<instance>&when=<date>` | re-dated cleanly — 2026-07-09 → 2026-07-10 — **no chooser**, and notably **no crash** (oddities §1's crash is the TEMPLATE case; an INSTANCE takes the URL `when=` fine on 3.23) |
| in-GUI drag of the instance onto a calendar date | **NOT ATTEMPTED** — a synthetic HID drag needs a real framebuffer, which the headless clone does not provide |

**Status: OPEN.** Every headless re-dating vector moves the instance without any exception prompt, which is itself a useful bound: the chooser is not on the automation path, so nothing we drive can trip it. It needs a framebuffer/HID rig (the same rig the SESSGATE wrong-Space and long-title cells are waiting on).

### 5.5 The §9ff double-spawn precondition did not form under 3.23

The oddity's own pure-GUI repro (a to-do scheduled for a future date **with a deadline**, then `Items ▸ Repeat…` → yearly → OK) behaved **differently** on 3.23: the source row was **consumed** (identity-replaced) into a deadline-mode template — `fa=1 ts=-14 tmplDeadline=4001-01-01`, the seed's 14-day when→deadline gap folded into the RULE — with **zero instances**. Advancing the guest clock to the occurrence day spawned nothing extra (untrashed instances of the series: 0, stable across a +15 s re-settle).

Under 3.22.14 the same input PRESERVED the source as a materialized future-dated instance, which is the precondition the double-spawn needs. So on this evidence the deadline no longer triggers source-preserve and §9ff's precondition never forms — **but that is a different source fate, not a proof that the spawn reconciliation was fixed**. [things-app-oddities.md §9ff](../things-app-oddities.md) is therefore left UNAMENDED; the other preserve trigger (a terminal checklist element, SRCFATE SF-Tck) has not been re-probed under 3.23 and is the cell that would settle it.

### 5.6 A01B — the at-locus create regression, and our vector's health

| call | 3.23 result |
|---|---|
| `make new to do at beginning of list "Today" with properties {name:…}` | row created, correct title, **`start=0`, `startDate=NULL`** — the list's scheduling is not applied (oddities §10) |
| `make new to do …` then `schedule t for (current date)` — **our applescript vector's shape** | `start=2`, `startDate=132805248` (the pinned day) — **lands** |

The two-step create+schedule is unaffected, confirming the regression is specific to the at-locus shortcut. The a-suite's `A01B` row is reconciled to the measured 3.23 behavior (verdict `partial`, `start=0`, `startDate` NULL) with a command `note` pointing at oddities §10 and at this document.

---

## 6. The register walk (repeater laws first)

Locks re-run against golden-v4 / Things 3.23 in this campaign:

| lock | result | laws it carries |
|---|---|---|
| **r-suite** (`npm run lab:run -- --suite lab/suites/r-suite.json`, run `r-20260822-141658`) | **GREEN** — 21/21 probes `ok`, verdicts and tiers identical to the 3.22.14 baseline (R09's crash still reproduces, R20/R21 still `unsupported`) | the repeat-family live locks: series lifecycle, template guards, reminder/deadline behavior on repeats |
| **a-suite** (run `a-20260822-142138`) | **GREEN** — 39/39 `ok` with the reconciled `A01B` (§5.6). Note A10 came back **tier 0**: the GV4 sweep's A10/R01 tier-3 delta was a FIRST-TOUCH `window-new` artifact on that run, not a standing 3.23 behavior — it does not recur on a fresh clone | the AppleScript-vector laws, including `A21` (schedule on a template refuses, error 302) and `A21B` |
| **write-layer e2e smoke** (`lab/scripts/e2e-write-smoke.sh`, run `things-run-e2e-20260822-092529`) | **126/132 green** — and all **6 failures are REORDER steps** (`verify-failed:silent-noop` on the private reorder), the known 3.23 no-op. Every repeat step is `ok`, including `[130] repeating-template when= is hard-blocked` | the shipped-CLI end-to-end locks; the repeat verbs' half is green |
| **RDLG2c / RDLG2d** (this document) | **GREEN** both arms (21/21 and 11/11) | the ui-vector repeat-dialog laws — the per-version certification-runbook lock |
| **RDLG2e** (§6.1) | **GREEN** — 8/8 cached projection days reproduced exactly by the derivation, 0 disagreements | the derived projection day (#520/#522) against a real 3.23 library |

The **o-suite stays RED** under 3.23 for a reason unrelated to this campaign — `_private_experimental_ reorder` is a silent no-op there (GV4), now handled by a shipped ≥3.23 version gate that routes to the SIT7 fallbacks. The suite rows still encode the native protocol, so every ORD-* law keeps its stale *Confirmed under* list until those expectations are reconciled. That is the register working as designed: the stale list IS the signal.

### 6.1 The derived projection day, against a real 3.23 library (RDLG2e)

A varied template corpus was built through the production CLI on a golden-v4 clone (daily · weekly-multi-weekday · monthly · monthly-nth-weekday · yearly · ends-after · after-completion), one series was PAUSED (the natural NULL-cache cohort), the clone's database was copied to the host, and the SHIPPED `templateProjectionDay` was run over every template TWICE — as shipped (cache-first) and with the cache SUPPRESSED (derivation only):

```
title                 cached      shipped     derived-only  verdict
LAB-REPEAT-DAILY      2026-07-06  2026-07-06  2026-07-06    AGREES with the app's own cache
LAB-REPEAT-WEEKLY-PROJ 2026-07-12 2026-07-12  2026-07-12    AGREES
RDLG2E-AC             —           —           —             no cache (after-completion: no calendar)
RDLG2E-DAILY          2026-07-07  2026-07-07  2026-07-07    AGREES
RDLG2E-ENDS           2026-07-06  2026-07-06  2026-07-06    AGREES
RDLG2E-MONTHLY        2026-07-15  2026-07-15  2026-07-15    AGREES
RDLG2E-NTH            2026-07-31  2026-07-31  2026-07-31    AGREES
RDLG2E-PAUSE          —           —           —             no cache (paused: the app renders no projection)
RDLG2E-WEEKLY         2026-07-06  2026-07-06  2026-07-06    AGREES
RDLG2E-YEARLY         2026-10-08  2026-10-08  2026-10-08    AGREES
templates=10  cacheNull=2  derivationNull=2  agree=8  DISAGREE=0
```

So on a real 3.23 library the derivation is not merely *sound* — it reproduces the running app's own cached answer **byte for byte on every template that has one**, across every calendar shape, and declines exactly where the app renders nothing. That is the certification #520/#522 were waiting for. It also re-confirms the GV4 correction from the other side: 3.23 still maintains the cache on templates (8 of 10 carry one; the two that do not are the after-completion and the paused series, both pre-existing cohorts).

**And it found a decoder bug of ours.** `things doctor` on that library reported `repeats: 10 template(s), 1 undecodable — plist parse error: unsupported node <array/>`. Things writes the offsets list as a SELF-CLOSING `<array/>` when a rule has no calendar anchor — i.e. for **every after-completion series** — and the rule-blob parser accepted only `<array>…</array>`. The whole rule failed to decode, costing that template its occurrence projections and its rule read-back (it fails closed, so nothing wrong was ever reported — the series simply went dark). Fixed here: the parser accepts the empty self-closing `<array/>`, `<dict/>`, and `<string/>` forms, with the verbatim 3.23 blob as the unit fixture. Pre-existing, not a 3.23 regression — 3.23 is simply the first library we decoded that contained one.

---

## 7. Open cells this campaign did NOT close

1. **The Make Exception / Update Rule chooser** (§5.4) — needs a framebuffer/HID rig.
2. **§9ff under 3.23 via the terminal-element preserve trigger** (§5.5).
3. **A repeating PROJECT under 3.23.** `projectMakeRepeatingRecipe` drives the same dialog through a different reveal (the repeat-bar popover, HID-clicked); the dialog findings carry, but the REVEAL was not re-certified on 3.23 — it needs the framebuffer rig for the same reason as (1).
4. **`Show Previous Copy`** DB semantics, and `Resume` on a paused 3.23 template.
5. **Bulk pause/resume/stop** on a multi-selection (untouched by both censuses).
