# REANCH2 — `deadline=` on a repeating TEMPLATE, and the re-anchor re-verified

**Version stamp:** `things-lab-golden-v4` · Things **3.23** (CFBundleVersion **32300036**, direct-download channel) · macOS **15.7.7 (24G720)** · `Meta.databaseVersion` **27** · two airgapped clones, guest clock **PINNED 2026-07-05 12:00 (a Sunday)** and never rolled (the golden-v4 trial wall of 2026-07-18 is never approached) · guest audio muted at boot (`output muted = true`) · AXVM1 accessibility grant baked · beep sentinel armed per cell (research mode: counted, never fatal). Campaign run 2026-08-28, unattended. Immutable snapshot per the [harness](harness.md) version-stamping policy.

Driver: [`lab/scripts/research-reanch2.sh`](../../lab/scripts/research-reanch2.sh) (cells selected by `CELLS=…`; `KEEP=1` keeps the clone, `REUSE=1` attaches). Fixtures fully synthetic (`REANCH2-*`); the golden's own `LAB-REPEAT-WEEKLY-PROJ` seed is the project arm. Artifacts (gitignored): `lab/artifacts/reanch2-lab/`, `reanch2b-lab/` — `report.txt` plus per-gesture full-row snapshots in `snap/`.

**DB oracle:** REANCH1's, verbatim — every gesture bracketed by a **full-row snapshot** of every `TMTask` column for the fixture's rows (`rowsnap.py` → `uuid⇥column⇥value`, packed dates decoded, blobs hashed), diffed field by field, plus a decoded rule summary (`rsum.py`, printing the rule blob hash and the blob's own `ia`/`sr` anchors). "No field changed on any surviving row" means all 41 columns of every row compared. Every write is also bracketed by a pid oracle and an `.ips` count.

Predecessors: [reanch1-url-reanchor.md](reanch1-url-reanchor.md) (the series re-anchor and its guards — this campaign's two open questions come from its §9 and the maintainer's ruling), [tmpldl-projdl-deadline-cycle.md](tmpldl-projdl-deadline-cycle.md) ARM 1 (the `deadline=` silent no-op, measured on **3.22.11** — re-asked here because REANCH1 proved the sibling `when=` handler CHANGED between builds).

---

## 0. Headline

1. **`deadline=` on a repeating template is still a COMPLETE SILENT NO-OP on 3.23** — future date, today's date, a past date, and on a template whose rule already deadlines its instances: four arms, zero fields changed across all 41 columns, no crash, no `userModificationDate` bump, `open` exit 0 every time (§3). TMPLDL's 3.22.11 verdict survives the build that changed `when=`. The deadline path is guarded; the schedule path was not.
2. **A `deadline=` companion VOIDS the whole url — including the `when=` re-anchor that lands on its own.** `update?id=<template>&when=<future date>&deadline=<date>` changes NOTHING (2/2, two clones), while the identical `when=` alone on the SAME row performs the full five-column re-anchor moments later (§4). Reversing the parameter order changes nothing, and an EMPTY `deadline=` (the clear spelling) voids it too — an inert parameter is enough. On a NON-repeating to-do the same pair lands both fields normally, so the void is specific to the template row. **New [oddity §27](../things-app-oddities.md).**
3. **REANCH1's re-anchor reproduces byte for byte.** A fresh daily template seeded 2026-07-05 with `next = icStart = 2026-07-06`, `update?when=2026-07-09`: the same five columns, and the rule blob goes `sha256:3b34361cc5aa9175` → **`sha256:b9a58999d5b4072c`** — the identical 627-byte hash REANCH1 §2.1 recorded and REPX2 §1.4 measured after pressing the GUI's own `Update Rule` (§2).
4. **The `@<time>` reminder re-verifies.** `when=2026-07-09@18:00` writes `reminderTime = 1207959552` (18:00) alongside the same five-column delta and the same target blob hash — the reminder rides the COLUMN, not the rule (§2).
5. **Nothing diverged from REANCH1.** Every law this campaign re-touched came back identical, which is what let the code leg proceed: the URL-drivable subset shipped is the bare `--when` re-anchor, and `deadline=` stays GUI-bound because it does not work at all here (§6).

---

## 1. Method

Two disposable clones of `things-lab-golden-v4`, each airgapped (default route deleted, ping verified failing), clock pinned **before** Things was ever launched, guest audio muted at boot, destroyed on exit. **No cell rolls the clock** — every question here is answered at the write, not at a spawn.

| clone | cells | what it covered |
|---|---|---|
| `reanch2-lab` | S · P · A · D | the positive control, the REANCH1 re-verify, and the seven-arm deadline matrix |
| `reanch2b-lab` | E | the D6 discriminator block: the pair repeated, its positive control, order, an empty companion, and the same pair on a non-template row |

**Fixture shape.** Every to-do fixture is `things:///add?title=…&when=2026-07-05` promoted through `Items ▸ Repeat…` (the REPX1/REPX2/REANCH1 recipe), which lands the documented series: a materialized instance dated 07-05 plus a template with `next = icStart = 2026-07-06`, `icCount = 1`, rule blob `sha256:3b34361cc5aa9175`. `REANCH2-DLR` additionally ticks the dialog's **Add deadlines** checkbox, which is the WITH-offset control TMPLDL flagged as uncreatable at the time: it lands `deadline = 4001-01-01` (the sentinel, packed `262213760`) on the template and a real deadline on its instance.

**The one write shape**, throughout:

```
things:///update?id=<template-uuid>&auth-token=<token>&<params>
things:///update-project?id=<template-uuid>&auth-token=<token>&<params>
```

**Zero crashes, zero beeps.** `ips 0→0` on every gesture of both clones (`final: app=ALIVE ips=0`), and the beep sentinel reported `0 alert beep(s)` for all six windows.

---

## 2. Cell A — REANCH1 re-verified (bare `when=`, and the `@time` reminder)

`REANCH2-CTRL` (fixed daily, `next = icStart = 2026-07-06`), `update?when=2026-07-09`:

```
[A1-bare-when] update?when=2026-07-09  transport EXIT=0  pid 701->701  ips 0->0  app=ALIVE
    CHANGED rt1_instanceCreationStartDate: 132805376(2026-07-06) -> 132805760(2026-07-09)
    CHANGED rt1_nextInstanceStartDate    : 132805376(2026-07-06) -> 132805760(2026-07-09)
    CHANGED rt1_recurrenceRule           : sha256:3b34361cc5aa9175:len627 -> sha256:b9a58999d5b4072c:len627
    CHANGED todayIndexReferenceDate      : 132805376(2026-07-06) -> 132805760(2026-07-09)
    CHANGED userModificationDate         : …
    (rows in both: 2; fields compared: 82)
rule after: … ia=1783555200.0 (2026-07-09) sr=1783209600.0 (2026-07-05, unchanged)
```

Five columns, the instance row untouched, and **the same blob hash REANCH1 §2.1 and REPX2 §1.4 recorded** for this seed and target. `sr` (the rule's series start) stays; `ia` (its anchor) moves. Nothing about the law has drifted.

`REANCH2-REM` (a second fresh daily template), `update?when=2026-07-09@18:00`:

```
[A2-when-at-time] update?when=2026-07-09@18%3A00  transport EXIT=0  ips 0->0  app=ALIVE
    CHANGED reminderTime                 : None -> 1207959552
    CHANGED rt1_instanceCreationStartDate: 2026-07-06 -> 2026-07-09
    CHANGED rt1_nextInstanceStartDate    : 2026-07-06 -> 2026-07-09
    CHANGED rt1_recurrenceRule           : sha256:3b34361cc5aa9175 -> sha256:b9a58999d5b4072c
    CHANGED todayIndexReferenceDate      : 2026-07-06 -> 2026-07-09
    CHANGED userModificationDate         : …
```

`1207959552` = 18:00 (`hour<<26 | minute<<20`), and the rule-blob delta is **identical to the bare form's** — REANCH1 §3's finding, reproduced: the reminder is a template COLUMN write that rides along, not part of the rule. (Spawn-level inheritance was measured by REANCH1 §3 and is not re-run here: this clone never rolls its clock.)

---

## 3. Cells P + D — `deadline=` on a template

### 3.1 The positive control first

A negative from an oracle that has never been shown a positive is not evidence (the CNCAC1/URLEN1 law), so `REANCH2-PLAIN` — an ordinary, non-repeating to-do — takes the same parameter first:

| arm | write | result |
|---|---|---|
| P1 | `update?deadline=2026-09-01` | `deadline: None -> 132812928(2026-09-01)` + `userModificationDate` |
| P2 | `update?deadline=` (empty) | `deadline: 132812928(2026-09-01) -> None` + `userModificationDate` |

The parameter works, and so does its clear spelling. Everything below is measured against that.

### 3.2 The matrix — four templates, four no-ops

| arm | fixture | write | app | delta |
|---|---|---|---|---|
| D1 | `REANCH2-DLF` daily | `update?deadline=2026-09-01` (FUTURE) | ALIVE, `ips 0→0` | **(no field changed on any surviving row)** |
| D2 | `REANCH2-DLT` daily | `update?deadline=2026-07-05` (== today) | ALIVE | **none** |
| D3 | `REANCH2-DLP` daily | `update?deadline=2026-07-01` (PAST) | ALIVE | **none** |
| D4 | `REANCH2-DLR` daily **+ Add deadlines** | `update?deadline=2026-09-01` | ALIVE | **none** — the 4001-01-01 sentinel and `ts=0` both intact |
| D5 | `REANCH2-DLR` | `update?deadline=` (the CLEAR spelling) | ALIVE | **none** — the sentinel survives that too |
| D7 | `LAB-REPEAT-WEEKLY-PROJ` project template | `update-project?deadline=2026-09-01` | ALIVE | **none** |

Four readings:

- **The 3.22.11 verdict holds on 3.23.** TMPLDL ARM 1 called `deadline=` on a template a complete silent no-op; it still is, on the build that gave `when=` a working branch. The two paths did not change together.
- **The FUTURE-vs-NOT boundary that governs `when=` (REANCH1 §5) does NOT extend to `deadline=`.** A past or today-dated deadline is as inert as a future one — no crash class here at all. The deadline handler rejects the write on the ROW's kind, before any date reasoning.
- **The rule-DEADLINED template is the control TMPLDL could not build**, and it behaves identically: a template whose instances already carry deadlines will not take a deadline of its own, and cannot have its sentinel cleared. So the deadline mode is settable ONLY through the Repeat dialog's checkbox, on any build.
- **The project route matches the to-do route.** `update-project?deadline=` is inert on a project template exactly as `update?deadline=` is on a to-do one — a symmetry `when=` also has (REANCH1 §4.1), in the opposite direction.

### 3.3 D6 — the pair

`REANCH2-BOTH` (a fresh daily template), both parameters in ONE url:

```
[D6-when-and-deadline] update?when=2026-07-09&deadline=2026-09-01  transport EXIT=0  ips 0->0  app=ALIVE
    (no field changed on any surviving row)
    (rows in both: 2; fields compared: 82)
```

The re-anchor did not happen. That is a stronger claim than "the deadline was dropped", and it is what cell E was run to bound.

---

## 4. Cell E — the discriminator block (second clone)

Five arms on fresh fixtures, one clone, same pinned clock:

| arm | fixture | write | delta |
|---|---|---|---|
| E1 | `REANCH2-EPAIR` (daily template) | `when=2026-07-09&deadline=2026-09-01` | **(no field changed)** — D6 at 2/2 |
| E2 | the SAME row, immediately after | `when=2026-07-09` | **full five-column re-anchor**, blob → `sha256:b9a58999d5b4072c` |
| E3 | `REANCH2-EREV` (daily template) | `deadline=2026-09-01&when=2026-07-09` | **(no field changed)** — order-insensitive |
| E4 | `REANCH2-ECLR` (daily template) | `when=2026-07-09&deadline=` (EMPTY) | **(no field changed)** — an inert companion voids it too |
| E5 | `REANCH2-EPLAIN` (a NON-repeating to-do) | `when=2026-07-09&deadline=2026-09-01` | **both land**: `deadline → 2026-09-01`, `start 1→2`, `startDate → 2026-07-09`, `todayIndex`, `tiRef`, `umd` |

E2 is the cell that makes the block evidence rather than an absence: the same row, the same clone, the same second — with the companion gone, the write lands in full. E5 is its complement from the other side: the parameter PAIR is perfectly ordinary on a normal row.

**The law, as measured:** on a repeating TEMPLATE, a `deadline=` parameter anywhere in an `update` / `update-project` url causes the ENTIRE command to be discarded — the sibling parameters included, whether or not the deadline value would have done anything. On any other row the same pair applies normally.

What this looks like from the outside is a per-command guard rather than a per-field one: the template check that silently drops `deadline=` appears to abandon the whole command instead of that one field. It is invisible — `open` exits 0, no error, no dialog, nothing in the row — and it is the kind of thing a caller only discovers by reading the database afterwards. **New [oddity §27](../things-app-oddities.md).**

---

## 5. What this campaign closes and leaves open

**Closed:**

- (a) *Does `deadline=` on a template work the way `when=` does on 3.23?* **No.** It does nothing at all, on every date class, on both routes, deadlined rule or not (§3).
- (b) *Does the `@<time>` component still set a rule-level reminder?* **Yes**, byte-identically to REANCH1 §3 (§2).
- The D6 void is a law, not an artifact: 2/2 with a same-row positive control, order-insensitive, triggered even by an empty value, and absent on non-template rows (§4).

**Open (unchanged from [REANCH1 §9](reanch1-url-reanchor.md), plus one):**

1. Whether the same whole-command void applies to OTHER silently-guarded parameters on a template (`checklist-items=`, `list-id=`, `tags=` were not aimed at a template here) — i.e. whether §4's law is about `deadline=` or about "any parameter the template guard drops".
2. REANCH1's open cells 1–8 stand as written (the multi-weekday rewrite's actual law, an ENDS-bounded rule, a deadlined series' spawned instances, a monthly nth-weekday anchor, a PAUSED template, sync, natural-language `when=` phrases on a template, and the app's own ⌘Z against a URL re-anchor). The shipped op refuses the paused and multi-weekday cases outright rather than resting on any of them.

---

## 6. What this campaign changes elsewhere

| document | change |
|---|---|
| [things-app-oddities.md](../things-app-oddities.md) | **new §27** — a `deadline=` parameter voids the WHOLE url on a repeating template, taking a `when=` re-anchor down with it; measured 2/2 with a same-row positive control |
| [things-app-oddities.md](../things-app-oddities.md) §2i | **dated appendix** — the template `deadline=` no-op re-confirmed on Things 3.23 (TMPLDL measured it on 3.22.11), and the deadlined-rule control TMPLDL could not build behaves identically |
| [capability-matrix.md](../capability-matrix.md) | the *Schedule/deadline edits on templates* row: the deadline half is re-confirmed on 3.23 and gains §4's void; the re-anchor half moves from "reachable, NOT built" to **SHIPPED** |
| [reference/novel-paths.md](../reference/novel-paths.md) | the URL re-anchor entry gains its BARE-dispatch requirement (a `deadline=` companion voids it) |
| the shipped op | `reschedule-repeat` gained the re-anchor spelling — bare `--when`, url vector, no GUI-drive gate, every REANCH1 §8 guard enforced pre-dispatch (see the CHANGELOG entry for the same release) |
