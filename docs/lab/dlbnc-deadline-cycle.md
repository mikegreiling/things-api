# DLBNC — the deadline-forecast day-block axis: GUI drag ground truth + the deadline-cycle reorder protocol

**Probed under:** golden `things-lab-golden-v1` · Things **3.22.11** · macOS Sequoia · DB schema v26 · guest clock pinned **2026-07-05 12:00**. Campaign **2026-08-03**, one disposable offline Tart clone (`dlbnc-lab`, booted `--vnc-experimental` for the framebuffer; ordering is local — no cloud account). Script: [`lab/scripts/research-dlbnc.sh`](../../lab/scripts/research-dlbnc.sh) (subcommands `setup`/`caps`/`arm1obs`/`arm1drag`/`arm2`/`arm3`/`arm4`/`arm5`/`pulldb`/`teardown`). Headless arms use URL `deadline=`/`when=` + AppleScript `due date`; the GUI arms use `screencapture -x` over SSH (the HEADARC2/SX6 capture path — the guest `sshd` carries the `ScreenCapture` TCC grant, **no vncdotool required**). DB row deltas from read-only guest SQLite are ground truth. Evidence (gitignored, synthetic): `lab/artifacts/dlbnc-lab/report.txt`, `session.env`, `screens/*.png`.

Extends [UPCDL (#382)](upcdl-deadline-axis.md), which flagged the render-axis question as the single highest-value residual. This campaign closes it and finds the clean lever UPCDL could not.

**Date encoding (128/day):** today `2026-07-05` = `132805248`; deadline day `2026-07-08` = `132805632`.

**Status: RAN + BANKED.**

## Maintainer-established model (ground truth)

The Upcoming view's day blocks order on **`todayIndex`, period**. Scheduled rows use `todayIndex` everywhere they render (root Upcoming AND the in-project upcoming section are one global axis; `index` plays no role in scheduled presentation). **Deadline-forecast rows** (someday/anytime + `deadline`, `startDate=NULL`) are **dual citizens**: `index` orders them in their project's someday/anytime bucket; `todayIndex` orders them within the **ROOT Upcoming day block only** (they do not appear in the in-project upcoming section — they are someday-stage there). The UPCDL "does the block read `index` or `todayIndex`?" hedge is resolved to this model with maintainer-established attribution — and this campaign **GUI-confirmed it directly** (DLBNC-1d).

## The verdict

**WIREABLE — via the deadline-cycle (the winning protocol); the compound when-cycle also works but is strictly inferior.** A URL `deadline=` clear + URL `deadline=<same>` re-set (DLBNC-3) is a **clean, state-preserving `todayIndex` writer** for a deadline-forecast row: each re-set front-inserts the row at the block's global `todayIndex` minimum while leaving `index`, `start=2`, `startDate=NULL`, `deadline`, `todayIndexReferenceDate`, and the heading/project FK **byte-identical** (integers and all). Dispatched in reverse-target order it lands an exact block order with the someday-bucket `index` byte-identical before and after — the acceptance bar every faithful protocol must clear. This is the `startDate`-preserving `todayIndex` lever UPCDL proved absent among the hidden-list specifiers (each of which stamps a `startDate`).

A second, maintainer-proposed **compound protocol** (DLBNC-6) also lands the target: `when=`-cycle the rows in reverse-target order (front-inserts `todayIndex`, clobbering `index`) then REPAIR `index` with one `project id` reorder to the captured order (the UPCDL-3 clean re-rank). It works end-to-end — but it is strictly inferior to the deadline-cycle: 2N+1 legs vs 2N, it touches the private/experimental reorder surface (allow-experimental gate + sdef canary) vs public-URL-only, it perturbs `index` (restores only the ORDER, integers differ) vs never touching it, and its `when=` legs are reminder-lossy (R07) vs the deadline-cycle's reminder-safe `deadline=` ops. **The deadline-cycle is the wiring candidate; the compound is a viable fallback if it ever regresses. NOT wired here — probes + docs only; wiring is a maintainer-ratification follow-up.**

The GUI drag itself (maintainer-observed to re-rank forecast rows within their block, same as recurring templates) writes the same shape — a within-block re-rank that keeps the row in its deadline-forecast block cannot have stamped a `startDate` (that would eject it to a scheduled slot). The deadline-cycle is its faithful headless reproduction.

## Resting bytes (fixture)

Project `DLBNC-P` (heading `P-H`) in `LAB-AREA-A`, all `deadline`/`startDate`-day `2026-07-08` where set. Each newly-created forecast/scheduled row front-inserts a more-negative `todayIndex`; `index` runs the OPPOSITE direction:

| row | kind | todayIndex | index | start | startDate | deadline | tiRef |
|---|---|---|---|---|---|---|---|
| SCH1 | scheduled @07-08 | −476 | 0 | 2 | 132805632 | — | 132805632 |
| SCH2 | scheduled @07-08 | −936 | 0 | 2 | 132805632 | — | 132805632 |
| DF1 | someday+deadline | −1494 | −511 | 2 | NULL | 132805632 | 132805632 |
| DF2 | someday+deadline | −2049 | −172 | 2 | NULL | 132805632 | 132805632 |
| DF3 | someday+deadline | −2428 | −97 | 2 | NULL | 132805632 | 132805632 |
| ND1/2/3 | plain someday (no deadline) | **0** | −45/−19/0 | 2 | NULL | — | **NULL** |
| HDF | someday+deadline, headed `P-H` | −2966 | 0 | 2 | NULL | 132805632 | 132805632 |

A plain someday row (no deadline) rests at `todayIndex=0` / `tiRef=NULL` — **no deadline = no block-axis assignment** (the §9o `start IN (1,2)` gate is really gated on the deadline too). Scheduled (SCH) and forecast (DF/HDF) rows share ONE `todayIndex` axis.

## Verdict table (observed)

| Probe | Question | Verdict |
|---|---|---|
| **DLBNC-1d** | default placement of forecast rows relative to scheduled rows in the block — interleaved or clustered? | **INTERLEAVED on the one `todayIndex` axis, NOT clustered.** The GUI Upcoming "8 Wednesday" block renders top→bottom `HDF, DF3, DF2, DF1, SCH2, SCH1` — EXACTLY ascending `todayIndex` (−2966 < −2428 < −2049 < −1494 < −936 < −476). The `index` order is the opposite (DF1 −511 < DF2 −172 < DF3 −97 < SCH 0), so the block renders by **`todayIndex`, not `index`** — direct GUI confirmation of the maintainer model. Forecast rows carry a dashed checkbox + a "3 days left" deadline flag; scheduled rows a solid checkbox; both sit in one list ordered only by `todayIndex` (here forecast rows sort above scheduled purely because created later = more negative). (`screens/upcoming.png`.) |
| **DLBNC-1a/b/c** | does the GUI permit dragging a forecast row within/between its block, and what does the drag WRITE? | **(a) YES — maintainer-observed:** forecast rows drag-reorder within their Upcoming day block, same behavior as recurring templates (which also sort on `todayIndex` in these views). **(b) WRITE = `todayIndex` only (inferred + reproduced), direct byte-capture NOT run:** a within-block re-rank that keeps the row a deadline-forecast member of the same day block cannot have stamped a `startDate`/`start` (that would eject it to a scheduled slot, off the forecast cohort) — so the drag is a pure `todayIndex` re-rank, the exact shape the deadline-cycle reproduces (DLBNC-3). A synthesized fixed-coordinate `CGEventPost` drag was attempted and produced a **ZERO DB delta** (bytes + `umd` byte-identical): Sequoia gates synthetic HID events for a non-Accessibility-trusted process (`osascript is not allowed assistive access`, −25211; no vncdotool, no grantable Accessibility on this host). **(c) between-block drag:** not exercised (same gate). Direct GUI byte-capture stays an interactive-VNC residual (the HEADARC2 Put-Back mechanism) — flagged, not run. |
| **DLBNC-2** | on a NO-deadline someday row, what `todayIndex` does setting a deadline assign — front/global-min or back; URL vs AppleScript; deterministic? | **VECTOR-DEPENDENT.** URL `deadline=07-08` on ND1: `todayIndex` **0 → −3538** (below ALL incumbents = block global min = FRONT), `tiRef`→deadline, `index`/`start=2`/`startDate=NULL` untouched, 1 `umd` bump — a **clean front-insert** todayIndex writer. AppleScript `set due date` on ND2: sets `deadline`+`tiRef` but leaves `todayIndex=0`; it only lazily resolved to −289 (BACK, least-negative) on a later view recompute — the AS vector is NOT an immediate block-axis writer. Determinism: clearing then re-setting ND1 (already the frontmost) reproduced −3538 exactly, twice → the front-insert value = `(current block todayIndex min) − delta`, deterministic given a fixed block context. |
| **DLBNC-3b** | full collateral of ONE deadline-cycle leg (URL, on middle row C2) | **CLEAN.** C2 before `tIdx=−4737 idx=−3`. After `deadline=` clear: `tIdx=−4737` RETAINED (inert), `dl`/`tiRef` dropped, `idx=−3` kept. After re-set: `tIdx=−5784` (fresh global-min FRONT-insert), `idx=−3` preserved, `start=2`, `startDate=NULL`, `dl`/`tiRef` restored to identical bytes, `dlSup`/`reminder` absent throughout, heading/project FK preserved. **2 `umd` bumps per leg** (clear + set are separate txns). Every byte outside `todayIndex`+`umd` is byte-identical. |
| **DLBNC-3d** | headed-row rip control on a `deadline=` leg | **HEADING-SAFE.** HDF cycled clear+set: `todayIndex` −2966 → −6363 (front-inserted) but `heading` FK `yBAV5Dth` byte-identical. `deadline=` is not a containment write — no O06/§9k rip (matching the hidden-list specifiers, unlike the `project id` reorder). |
| **DLBNC-3c** | PROTOCOL PROOF — scramble C1/C2/C3, deadline-cycle to an exact target block order, someday `index` byte-identical? | **PROVEN.** Target ascending `todayIndex` = C2<C1<C3 (scrambled vs creation). Reverse-target dispatch C3, C1, C2 (front-insert ⇒ last-cycled = most-negative = first). FINAL `todayIndex`: **C2 −8787 < C1 −8219 < C3 −7760 = EXACT target.** Someday-bucket `index` BEFORE `C1:−6 C2:−3 C3:0` and AFTER `C1:−6 C2:−3 C3:0` — **byte-identical**. A working state-preserving day-block reorder protocol. |
| **DLBNC-4** | characterize (conditional — fired) | Insertion law = **front-insert at the block's global `todayIndex` min on each URL `deadline=` re-set** (`min − delta`, deterministic). Leg op = URL `deadline=` clear + URL `deadline=<same>` re-set (**2 URL txns/leg**, `umd` bumps on both). Atomicity = non-atomic (a mid-fail leaves the row transiently deadline-less in its project — recoverable by re-setting the deadline; the row briefly leaves the block during the clear). Undo = per-leg URL writes (no single-txn undo token; the app's own undo is per-URL-write). Gates = none beyond the public URL scheme (no experimental/private surface, no sdef canary). Vector = **URL only** (AppleScript `due date` does not front-insert, DLBNC-2). |
| **DLBNC-5 (reworked)** | when=`<DATE>`→someday AND when=today→someday round-trip on a PROPER multi-row fixture (3 forecast rows + a BYSTANDER WB in the same block) — preserve / re-derive / front-insert, per axis, both vectors? | **BOTH vectors FRONT-INSERT BOTH axes on the someday-restore leg — measured against the untouched bystander.** `when=07-09`→someday on W1: the DATE leg preserves both axes and sets `startDate`/`tiRef` to 07-09 (`tIdx −3545` held, `idx −13` held); the `someday` restore then **front-inserts `todayIndex` −3545 → −5274, BELOW the untouched bystander WB (−4867)** — a genuine front-insert, not a preserve — and clobbers `index` −13 → 439. `when=today`→someday on W2 behaves identically (`tIdx −3961 → −5808`, `idx −7 → 1065`) plus a today-materialization on the today leg (`start 2→1`, `startDate→today`). **This SUPERSEDES UPCDL-7 Q2** ("someday→DATE→someday preserves both axes"): Q2's fixture was a single loose row (`idx=0`), where front-insert to the global min is unobservable — with a bystander present, the front-insert is plain. Front-insertion of both axes is the law, matching §9p's multi-row measurement and the certified `when=` bounce family. So the when-cycle IS a deterministic `todayIndex` writer, but it moves the someday `index` — usable only WITH an index-repair leg (DLBNC-6). |
| **DLBNC-6** | the COMPOUND protocol — when=-cycle to set the block order (clobbers index) then REPAIR index with one `project id` reorder — does it land target `todayIndex` AND restore the original `index` order? | **PROVEN end-to-end.** Step 1 (reverse-target `when=07-09`→someday cycle of X3,X1,X2): FINAL `todayIndex` X2 −9625 < X1 −9066 < X3 −8667 = target; `index` clobbered to 4100/4620/4983. Step 2 (one `project id` reorder to the captured original order, private surface clean-returned): `index` restored to ascending X1 −1665 < X2 −1196 < X3 −764 = **original ORDER** (original `X1:1563 X2:1973 X3:2386` — same rank order; **integers differ** — the reorder re-ranks, it does not restore the literal bytes), while `todayIndex` was UNTOUCHED by the reorder (target preserved — UPCDL-3 clean re-rank reconfirmed), and `deadline`/`start=2`/`startDate=NULL`/`tiRef`/project FK all untouched. Cost 2N+1 legs (2N URL `when=` + 1 private reorder); uses the experimental private surface + sdef canary; non-atomic. WORKS — but see the ranking below: strictly inferior to the deadline-cycle. |
| **DLBNC-6 R07** | are the compound's `when=` legs reminder-lossy? | **YES.** A control row CR scheduled today WITH a reminder (`reminderTime=939524096`) LOST it on the `when=someday` leg (`rem→NULL`, alongside `start 1→2`, `startDate→NULL`) — the §9n/R07 clear-on-`when=` law. Pure forecast rows carry no reminder (structurally — a reminder needs a `startDate`), so the compound is reminder-neutral for the forecast cohort in practice; but a reminder-bearing row would be stripped. The deadline-cycle's `deadline=` ops are orthogonal to `reminderTime` (reminder is `startDate`-bound) → reminder-safe, a further edge over the compound. |

## Ranking the two working protocols

Both the deadline-cycle (DLBNC-3) and the compound when-cycle (DLBNC-6) land the exact target block order with the someday `index` order restored and `deadline`/`start`/`startDate`/FKs untouched. The deadline-cycle wins on every remaining axis:

| Criterion | **deadline-cycle** (DLBNC-3) | compound when-cycle + repair (DLBNC-6) |
|---|---|---|
| Sets target `todayIndex` order | ✅ | ✅ |
| Final someday `index` | ✅ **byte-identical** (never touched) | ✅ order restored, **integers differ** (clobbered then re-ranked) |
| Legs per N rows | **2N** (URL `deadline=` clear+set) | **2N+1** (2N URL `when=` + 1 private reorder) |
| Surfaces | **public URL scheme only** | public URL + **private experimental reorder** (allow-experimental + sdef canary) |
| Reminder safety | **reminder-safe** (`deadline=` orthogonal to `reminderTime`) | `when=` legs **reminder-lossy** (R07) |
| Atomicity | non-atomic (2 txns/leg; row transiently deadline-less, recoverable) | non-atomic (2N+1 txns; transiently scheduled + index-clobbered) |
| `deadline`/`start`/`startDate`/FK | untouched | untouched |

**The deadline-cycle is the wiring candidate; the compound is a viable fallback if the deadline-cycle ever regresses.**

## Why these beat the levers UPCDL already ruled out

| Lever | Writes `todayIndex`? | Deterministic sort? | Someday `index` clean? | `startDate` stays NULL? | Verdict |
|---|---|---|---|---|---|
| **deadline-cycle** (URL `deadline=` clear+set) | **yes (front-insert)** | **yes** | **YES (byte-identical)** | **yes** | ✅ the clean protocol |
| compound when-cycle + `project id` repair | yes (front-insert) | yes | order restored (integers differ) | yes | ✅ works, strictly inferior |
| when=`<DATE>`/today ↔someday alone (DLBNC-5) | yes (front-insert both axes) | yes | **NO (clobbered, unrepaired)** | yes (net) | ✗ moves the someday position |
| hidden-list `list "Today/Tomorrow/Upcoming"` (UPCDL-2/5/6) | yes | yes | — | **NO (stamps startDate)** | ✗ ejects from the block |
| `project id` / someday↔anytime bounce (UPCDL-3/7b) | **no** (writes `index`) | — | (moves index by design) | yes | ✗ wrong axis for the block |
| AppleScript `due date` set (DLBNC-2) | no (lazy back-assign) | no | yes | yes | ✗ not an immediate block writer |

**Supersession note (per the immutability convention — recorded HERE, not by editing UPCDL's evidence body):** UPCDL-7 **Q2**'s finding "a plain `when=` (someday→DATE→someday) update PRESERVES both axes" is **SUPERSEDED** by DLBNC-5. Q2's fixture was a single loose row (`idx=0`), for which a front-insert to the global minimum is unobservable (the only row is trivially the min, so it reproduces its own value). On a proper multi-row fixture with an untouched bystander, the `when=someday` restore leg **front-inserts BOTH `todayIndex` and `index`** below the bystander — contradicting Q2 and matching UPCDL §9p's own multi-row measurement (`idx −9/−5/−4 → 1057/1597/439`) and the certified `when=` bounce family. Q2's Q1 sub-finding (a same-bucket `when=someday` on an already-someday row is a no-op) is unaffected — that involves no front-insert. UPCDL-7b (the someday↔anytime bounce re-ranks `index` only, `todayIndex` byte-identical) is likewise unaffected.

## App oddities filed

- **§9o (amended)** — the "which axis the GUI renders" hedge is RESOLVED: the block renders forecast rows by **`todayIndex`** (maintainer-established; DLBNC-1d GUI-confirmed — the "8 Wednesday" block rendered in ascending `todayIndex`, opposite to `index`). The register/matrix hedges are rewritten to this.
- **§9q (new)** — **deadline-set block-`todayIndex` assignment is WRITE-VECTOR-DEPENDENT**: URL `deadline=<ISO>` immediately **front-inserts** the row at the Upcoming block's global `todayIndex` minimum (`tiRef:=deadline`, `index`/`start`/`startDate` untouched); AppleScript `set due date` sets `deadline`+`tiRef` but leaves `todayIndex=0`, deferring the block-axis assignment to a later view recompute (which lands it at the BACK). And **AppleScript cannot CLEAR a deadline** — `set due date … to missing value` errors −1700 ("Can't make missing value into type date"); only URL `deadline=` (empty) clears. (DLBNC-2, canary.)

## Reproduce

```sh
TART_HOME=/Volumes/Workspace/tart \
  bash lab/scripts/research-dlbnc.sh setup      # clone+boot(vnc)+airgap+clock-pin+warm+seed+canary
  bash lab/scripts/research-dlbnc.sh caps        # screencapture + AX availability probe
  bash lab/scripts/research-dlbnc.sh arm1obs      # DLBNC-1d GUI observe (default placement)
  bash lab/scripts/research-dlbnc.sh arm2         # DLBNC-2 deadline-set todayIndex law (mutates ND rows)
  bash lab/scripts/research-dlbnc.sh arm3         # DLBNC-3 the deadline-cycle bounce + protocol proof (C rows)
  bash lab/scripts/research-dlbnc.sh arm4         # DLBNC-4 characterize (G rows)
  bash lab/scripts/research-dlbnc.sh arm5         # DLBNC-5 when=today<->someday, original single-set run (E rows)
  bash lab/scripts/research-dlbnc.sh arm5b        # DLBNC-5 reworked: proper fixture + bystander, DATE + today (W rows)
  bash lab/scripts/research-dlbnc.sh arm6         # DLBNC-6 compound protocol + R07 reminder audit (X rows + CR)
  bash lab/scripts/research-dlbnc.sh arm1drag seed         # DLBNC-1abc drag byte-audit (best-effort; DG rows)
  bash lab/scripts/research-dlbnc.sh arm1drag go <sx> <sy> <ty>   # (read screens/drag-before.png for coords)
  bash lab/scripts/research-dlbnc.sh teardown
```

Each arm uses an independent row set (SCH/DF/HDF for the resting law + observe; ND for arm2; C for arm3; G for arm4; E for arm5; W+WB for arm5b; X+XB+CR for arm6; DG for the drag) so ONE clone serves the whole campaign. `arm6` additionally requires the private-reorder surface (the `project id` repair leg) — it runs the sdef canary; `arm5`/`arm5b`/`arm6` were run on a second fresh clone after the maintainer's mid-flight rework. `arm1drag go` is a best-effort synthesized drag that no-ops on this host (synthetic events gated without Accessibility); the direct GUI drag byte-capture stays an interactive-VNC residual.
