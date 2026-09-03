# DEFAULTS3 — the observer-down quadrant: a drive is certified when ALL FOUR quadrants of its optional machinery are

**Probed under: `things-lab-golden-v4` · Things **3.23** (CFBundleVersion **32300036**) · macOS **15.7.7** · DB schema **v27** · guest clock pinned **2026-07-05 12:00 (a Sunday)**, trial wall 2026-07-18, never rolled.** ONE disposable clone of golden-v4 (the golden is never booted), airgapped (default route deleted), beep sentinel on in report-only mode (`THINGS_LAB_BEEPS_OK=1`), destroyed at teardown. Fixtures fully synthetic (`DEF3-*`). Immutable snapshot per the [harness](harness.md) version-stamping policy.

Driver: [`lab/scripts/research-defaults3.sh`](../../lab/scripts/research-defaults3.sh) — cells `repro` · `quad`. Ledger extractor: [`lab/scripts/defaults3-ledger.py`](../../lab/scripts/defaults3-ledger.py). Artifacts (gitignored): `lab/artifacts/defaults3-lab/` (`report.txt`, per-drive traces in `trace/`, CLI output in `drive/`).

This is the fix campaign for **[#700](https://github.com/mikegreiling/things-api/issues/700)**, a field defect in the 0.20.8 RC caught by the FIRST field-shaped release-gate run ([AGENTS.md](../../AGENTS.md) § Release gate, [reference/release-checklist.md](../reference/release-checklist.md) Stage 5). It sits on top of [VOPAT2 (#687)](vopat2-screen-reader-build.md) and [DEFAULTS2 (#691)](defaults2-minimal-recipe.md), and its finding is about the two of them TOGETHER.

---

## 0. Headline

| | |
| --- | --- |
| **The field failure** | `things todo add-repeating "…" --when 2026-09-28 --frequency weekly --interval 1 --dangerously-drive-gui` → `verify-failed:silent-noop`, 9,037 ms, refused at the shape probe: *"its first-occurrence row (\"Next:\") holds neither an occurrence pop-up nor a date field … a Things update has redesigned it again"*. Deputy-routed, real display, Things 3.23.2 |
| **Did the app change?** | **No.** The `Next:` row was not missing — it had not been BUILT yet. The probe read the cadence group MID-REBUILD |
| **Mechanism** | With a settle sidecar live, the frequency step waits to be TOLD the rebuild finished (`SETTLE_POPUP_APPLIED`). With none it waits for nothing — and DEFAULTS2 had removed the accidental gate (the interval step's `cgSettle`) by moving the probe ahead of it and then making that step skippable |
| **Reproduced headless** | **YES, byte-for-byte** — same refusal string, same step, same census signature (`select-popup` axElems 6 → `probe-dialog-shape` axElems **1**). Forced with `THINGS_API_AX_OBSERVER=0` on a golden-v4 clone at Things **3.23**, so the 3.23.2-vs-3.23 difference is NOT involved (§2) |
| **The prefill switch is not in the causal path** | Both observer-down quadrants fail identically, both observer-up quadrants pass. The hypothesis this campaign was commissioned with named prefill-ON as a condition; it is not one (§2.2) |
| **What shipped** | the no-sidecar shape probe takes the certified POLLING settle — `cgSettle`'s own budget and its own two-part rule (a POSITIVE verdict, held across two reads a tick apart). The sidecar form is one round, unchanged (§3) |
| **Certified** | **all four quadrants** — {sidecar, polling} × {prefill on, off} — across the 5-state matrix + the deadlined and reminder arms, rule blobs byte-identical across every quadrant, census unmoved, **0 alert beeps** (§4) |
| **The law** | *Optional machinery MULTIPLIES; certification of a drive is certification of every QUADRANT of it, never of each switch alone* — recorded in [harness.md](harness.md) §AX-drive scrutiny (§5) |

---

## 1. The certification gap, stated once

Two campaigns each added an off switch, and each certified its own switch honestly:

| | prefill ON | prefill OFF |
| --- | --- | --- |
| **observer UP** | VOPAT2 §cert, DEFAULTS2 §cert | DEFAULTS2 §cert |
| **observer DOWN** | **never run** | **never run** |

VOPAT2 certified `{TAG=obs, TAG=poll}` — against the recipe as it stood BEFORE DEFAULTS2 reordered it. DEFAULTS2 certified `{on, off}` — with the sidecar armed in the preamble of every single arm (its own §4 lists `observer arm` among the ten hops before the dialog is even open). The product had no arm at all, and the product is the field's own shape: every deputy-routed host, and every Mac with no Command Line Tools.

**Why this is not the routing-arm law again.** #695 was a host CLASS with no lab arm (a routed host, which a clone cannot host). This is a host class the lab CAN host trivially — one environment variable — that simply was not crossed with the other switch. The routing-arm law says *name the identity you certified under*; this one says *cross your switches*.

---

## 2. §repro — the field failure, headless, on the PRE-FIX bundle

The `repro` cell ships a dist built at the RC's own commit (`4f478118`; the driver prints a bundle fingerprint so a report can never be read against the wrong dist) and runs the FIELD'S OWN command shape in all four quadrants.

| quadrant | exit | verdict | the shape probe read | outcome |
| --- | --- | --- | --- | --- |
| `obs-pf` (sidecar, prefill on) | 0 | `ok:true` | `next-popup` (axElems **7**) | landed `tp=0 fu=256 fa=1 of=[{wd=1}] next=2026-09-28` |
| `obs-nopf` (sidecar, prefill off) | 0 | `ok:true` | `next-popup` (axElems **7**) | landed, blob byte-identical to `obs-pf` |
| `poll-pf` (no sidecar, prefill on) | **3** | `ok:false` | *(no verdict)* — axElems **1** | **REFUSED at the shape probe**, `NO-ROW` |
| `poll-nopf` (no sidecar, prefill off) | **3** | `ok:false` | *(no verdict)* — axElems **1** | **REFUSED at the shape probe**, `NO-ROW` |

The refusal is the field's, to the character:

```
"measure the Repeat dialog's shape (an occurrence pop-up on the Next: row, or a date field)
 — FAILED: its first-occurrence row (\"Next:\") holds neither an occurrence pop-up nor a date
 field, so the dialog matched neither known shape — a Things update has redesigned it again;
 nothing was entered into the rule"
```

and so is the hop trail, including the element census that names the cause:

```
field    … press 125 → dialog-open 614 → select-popup 346/e6 → probe-dialog-shape 166/e1 → resolve 2421/e20 → dismiss-dialog 198
poll-pf  … press  64 → dialog-open 434 → select-popup 144/e6 → probe-dialog-shape  81/e1 → resolve 1289/e11 → dismiss-dialog  95
```

### 2.1 `axElems 1` is the whole diagnosis

The probe logs how many static texts its plural read realized. A SETTLED weekly cadence group has **7** (measured, the two passing quadrants above). The failing quadrants read **1** — a group whose old children have been destroyed and whose new ones do not exist yet, with no `Next:` label to anchor on. So `nextY is missing value`, the probe returns `unknown`, and the driver's `unknown` copy blames a redesign.

**LAW (DEFAULTS3-1).** *The Repeat dialog's cadence group is UNREADABLE for a window after a frequency change, and a read taken inside it reports a group that does not exist rather than an error. The window is announced closed (`AXValueChanged` on the pop-up, with the `AXUIElementDestroyed` burst) — and where nothing is listening for that announcement it must be POLLED out, because the app will answer a mid-rebuild read as readily as a finished one.*

This is [RDLAT2 §7c](rdlat2-repeat-dialog-latency.md)'s settle law arriving from a fourth direction: an accidental settle was holding a real dependency together, and making the driver faster exposed it. DEFAULTS2 removed 29 round-trips from the interval hop and, with them, the gate nobody knew that hop was providing.

### 2.2 The prefill switch is NOT a condition

The campaign was commissioned with the hypothesis that the defect needed prefill-ON: DEFAULTS2's reorder plus the observer down. The reorder half is right and the prefill half is not — `poll-nopf` fails identically. The reason is in the recipe: `probe-dialog-shape` is pushed immediately after the frequency selection **unconditionally**, and the two things that follow it both carry `cgSettle` (`verify-prefill` when anything is nominated, the interval's `set-group-number` when nothing is). Which of those two follows depends on the prefill switch; that the PROBE is first does not.

So the defect is one-dimensional in the observer and the fix is too. The prefill quadrants still have to be certified — the point of §4 — but they were never the cause.

### 2.3 What this rules out

The clone runs Things **3.23** (32300036) and the field ran **3.23.2**. The failure reproduces on 3.23, so *"a Things update has redesigned it again"* is excluded as a contributing cause and the banked 3.23.2 installer was not needed. (What 3.23.2 changed for this drive is unrelated and already recorded: the after-completion offset clamp, DEFAULTS2 §clamp.)

---

## 3. §fix — what shipped, and what deliberately did NOT move

`axProbeDialogShapeScript` (`src/write/vectors/ui.ts`) now takes the settle injector, like every other script this drive generates.

**With a sidecar** it is one round, decided on a positive verdict alone: the same Apple events, at the same cost, on the read its own frequency step's settle already guaranteed was of a finished group.

**With none** the measurement is wrapped in the CERTIFIED POLLING SETTLE — `SETTLE_READS` (40) reads `SETTLE_POLL_S` (0.1 s) apart, the identical budget `cgSettle` uses for the identical re-layout (BEEP1/RDLAT2) — and it returns only on a verdict that is **positive** AND **held across two reads a tick apart**. Both halves are load-bearing:

- the **positive verdict** steps over the torn-down group: no `Next:` row exists, so there is nothing to mismeasure;
- the **agreement** stops a HALF-BUILT group deciding the version fork. The probe decides by ROW ADJACENCY, mid-layout positions are stale, and a stray pop-up transiently on the `Next:` row would read `next-popup` on a ≤3.22 dialog — the wrong branch, and the exact failure the step exists to prevent. (Agreement alone would not do either: agreement is also what a group that has not STARTED rebuilding looks like — RDLAT2 §E.4 — which is why the verdict has to be positive as well.)

A budget that expires with the shape STILL MOVING is a different fact from a dialog that never had a `Next:` row, and now says so:

| verdict | refusal |
| --- | --- |
| `unknown` | *"…holds neither an occurrence pop-up nor a date field … a Things update has redesigned it again"* (unchanged) |
| `unsettled` | *"the Repeat dialog's cadence group never stopped re-laying out, so which control shares its first-occurrence row (\"Next:\") could not be measured; nothing was entered into the rule"* |

The two send a reader somewhere completely different — one says the app changed, the other says this host never saw the group finish — and a refusal that cannot tell them apart cost this campaign its first hour. `unsettled` is unreachable on the sidecar path by construction.

### 3.1 The probe STAYS where DEFAULTS2 put it, and this is not a preference

The alternative fix was to move the shape probe BEFORE the first input, on the reasoning that the dialog's SHAPE is a version property and does not change with the frequency. The shape does not — but the CONTROL the probe reads it off does not exist in every dialog state:

- an **after-completion** rule's cadence group carries neither an `Ends:` nor a `Next:` label to measure (which is why the recipe emits no probe for that shape at all);
- a **reschedule** opens the dialog PRE-POPULATED from the existing rule, so a probe taken before the frequency selection measures the OUTGOING state — and a to-do currently repeating `after completion` would refuse a perfectly enterable `--frequency weekly`.

The S4 arm in §4 is that case, run in every quadrant, and it is why the answer is a settle rather than a reorder. DEFAULTS2's own reason for the position stands unchanged: the verify-by-read hop needs the measured shape to address the shaped pop-ups, and it must read before any setter.

---

## 4. §quad — the four-quadrant certification

Everything below through the production CLI on the FIXED bundle, against the guest SQLite oracle, on the same clone as §2. Every arm run in **all four quadrants**, with each drive's quadrant PROVED out of its own trace (`phase:"ui-observer"` and `phase:"ui-prefill"`) rather than assumed from the environment the cell set.

### 4.1 The matrix

`obs` = settle sidecar live · `poll` = `THINGS_API_AX_OBSERVER=0` · `pf` = pre-fill reliance live · `nopf` = `THINGS_API_PREFILL=0`.

| arm | `obs-pf` | `obs-nopf` | `poll-pf` | `poll-nopf` |
| --- | --- | --- | --- | --- |
| **S1** fixed (monthly, interval 2) | **PASS** | **PASS** | **PASS** | **PASS** |
| **S2** after-completion (weekly, interval 3) | **PASS** | **PASS** | **PASS** | **PASS** |
| **S3** deadlined (weekly, start 2 days earlier) | **PASS** | **PASS** | **PASS** | **PASS** |
| **S4** ends-after RESCHEDULE (daily, interval 3, ends after 4) | **PASS** | **PASS** | **PASS** | **PASS** |
| **S5** pause + resume | **PASS** | **PASS** | **PASS** | **PASS** |
| **S6** reminder (`add-repeating`, weekly, 09:30) | **PASS** | **PASS** | **PASS** | **PASS** |
| **RP** the field's own command shape (§2) | **PASS** | **PASS** | **PASS** | **PASS** |
| rule blobs byte-identical across all four | — | **YES** (S1, S2, S3, S6) | **YES** | **YES** |
| window/focus census | `repeat`/`attached`/`cb:2 pu:1 bt:2 gp:1 tf:0` | identical | identical | identical |
| alert beeps | **0** | **0** | **0** | **0** |
| crash / `.ips` | none | none | none | none |

Every arm's quadrant is read out of its OWN trace, not out of the environment the cell set:

| arm | observer, per trace | pre-fill, per trace |
| --- | --- | --- |
| S1 | `stopped` (obs) / `unavailable (switched off by THINGS_API_AX_OBSERVER)` (poll) | `confirmed=[monthly-mode,monthly-ordinal,next]` (pf) / no verify hop (nopf) |
| S2 | as above | `confirmed=[ac-unit]` / no verify hop |
| S3 | as above | `confirmed=[interval,weekdays,next]` / no verify hop |
| S4 | as above | no verify hop in EITHER — a reschedule gets no reliance at all (DEFAULTS1 §9.5) |
| S5 | not armed in any quadrant — the pause/resume recipes have no settle to serve | no verify hop |
| S6 | as S1 | `confirmed=[interval,weekdays,next,add-reminders,reminder-time]` / no verify hop |

### 4.2 What the fix costs, and where

The probe's own hop, per quadrant (`durationMs` / elements realized — a clone, so the elements are the number that transfers):

| | `probe-dialog-shape` |
| --- | --- |
| `obs-pf` / `obs-nopf` | **89–108 ms, 7 elements** — ONE round, unchanged |
| `poll-pf` / `poll-nopf` | **681–697 ms, 17 elements** — THREE rounds: one mid-rebuild read, then two that agree |
| `poll-*`, PRE-FIX (§2) | 81 ms, **1 element** — the mid-rebuild read, taken as the answer |

Three rounds is the shape of the thing: the first read lands inside the rebuild window and sees a torn-down group, the second sees the finished group, the third confirms it has stopped moving. So the observer-down path pays **~0.6 s and 10 extra realized elements per drive** for a drive that previously did not complete at all. The sidecar path pays nothing.

Whole-drive totals (hops / elements realized) show the same, and nothing else moved:

| arm | `obs-pf` | `obs-nopf` | `poll-pf` | `poll-nopf` |
| --- | --- | --- | --- | --- |
| S1 | 15 / 93 | 17 / 119 | 15 / 102 | 17 / 126 |
| S2 | 14 / 36 | 14 / 36 | 13 / 35 | 13 / 34 |
| S3 | 16 / 88 | 18 / 108 | 15 / 97 | 18 / 117 |
| S4 | 14 / 105 | 14 / 105 | 13 / 121 | 13 / 121 |
| S5 (each leg) | 5 / 0 | 5 / 0 | 5 / 0 | 5 / 0 |
| S6 | 16 / 55 | 19 / 75 | 15 / 64 | 19 / 84 |

The `poll-*` columns run one hop fewer than their `obs-*` twins because they spawn no sidecar, and (S1/S3/S6) about ten elements more because the probe polls. **On the field this trade is heavily favourable in the only direction that matters**: the sidecar-down drive went from refusing to landing.

### 4.3 What was NOT re-run, and why that is honest

- **The mismatch / refusal / guard cells** (DEFAULTS2 §mismatch, §refuse, §cells — C2 / S / T / X). None of them reaches the shape probe's read at all: three refuse before dispatch, and the guard cells refuse at the preflight or at the focus guard. The change is confined to one script's no-sidecar text, and the unit suite pins that text plus the recipe ordering in both settle shapes.
- **The routed arm.** Still the gap #695 named: a clone cannot host the helpers. The broker-acceptance test (`test/unit/ui-script-broker-safety.test.ts`, `test/deputy/broker-integration.test.ts`) covers the polling form of every script this drive emits — which is now the form a routed host generates for the probe too — and the field-shaped run on the maintainer's Mac is the certification that closes it.

---

## 5. The law this campaign records

**Quadrant law (harness.md §AX-drive scrutiny).** *Optional machinery MULTIPLIES. A drive with N independent switches has 2^N execution shapes, and certifying each switch against the default of the others certifies N+1 of them — so the shapes that ship broken are the PRODUCTS.* Two campaigns, each certifying its own fallback impeccably, shipped a defect in the corner neither of them visited; and the corner was not exotic — it is what every deputy-routed Mac runs, which is what the maintainer's own Mac runs.

Three rules follow:

- **Cross the switches, and say the crossing out loud.** A campaign that adds a switch to a drive that already has one certifies the MATRIX, not its own column. Where 2^N is too many to drive, name the quadrants that were skipped and why — an unnamed gap is the one that ships.
- **A switch's default is not neutral ground.** DEFAULTS2's arms all ran with the sidecar armed because that is what a lab host does; the field's default is the opposite. The quadrant a campaign forgets is the one its own rig makes convenient.
- **Prove the quadrant from the drive's own trace.** Every arm here reads its observer state and its prefill ledger out of the trace it produced, because an environment variable a cell believes it set is not evidence that the drive ran that way (the sidecar can be unavailable for reasons no variable mentions — #695's routing stand-down is one).

---

## 6. Rig notes

- The driver takes `DISTSRC=<path>` so the same cells can run against a pre-fix and a fixed bundle on ONE clone (`KEEP=1` then `REUSE=1`), and prints a BUNDLE FINGERPRINT per run — `grep -c unsettled dist/write/vectors/ui.js`, 0 pre-fix and 3 after — so a report can never be misread against the wrong dist. Every future fix campaign that wants a before/after on one clone can lift this.
- A failing drive produces NO prefill ledger, because the shape probe precedes the verify hop. That is not a missing measurement; it is the ordering under test, and the ledger says `(no verify hop)` rather than inventing a state.
- The `--when 2026-09-28` in the field's command is a SCHEDULED DATE, not a clock. It rolls nothing and is safe past the trial wall; the guest clock stayed pinned at 2026-07-05 throughout both cells.
