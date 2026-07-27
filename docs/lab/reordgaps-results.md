# REORDGAPS — five ordering probes closing the remaining reorder unknowns

Campaign: HEADORD · DAYORD · ANYBNC · SOMEORD · TMPLORD. One offline Tart clone (pinned clock; ordering is local — no cloud account). Script: [`lab/scripts/research-reordgaps.sh`](../../lab/scripts/research-reordgaps.sh). Feeds [design/heading-demotion-and-move.md](../design/heading-demotion-and-move.md) §1/§4/§5 (the ratified bucket model) and the capability-matrix Ordering rows.

## ⚠️ EXECUTION STATUS — script authored, LAB RUN NOT YET PERFORMED (2026-07-27)

The probe script is complete, syntax-clean, and follows house conventions, but the live clone campaign **could not be run this session** because of two host-environment blockers, neither of which the campaign work introduced:

1. **Host disk at 99% (≈1.7 GiB free on `/Volumes/Workspace`).** The lab harness floor is ≥10 GiB, and for good reason: booting a macOS clone writes divergent COW blocks continuously (logs, Spotlight, swap) even airgapped. Running a multi-arm probe session into 1.7 GiB of headroom risks driving Mike's working host to 100% mid-write — an unacceptable risk to the host, distinct from the (COW-safe) golden. Reclaimable space within this agent's remit is only `lab/artifacts` (413 MiB) and stray run-VMs (none present); the volume is filled by `Projects` (69 GiB, Mike's data) and the golden (25 GiB), neither of which is mine to delete. **Free ≥10 GiB before running.**
2. **`vncdo` is gone** (the Cylance-quarantine pattern — the `vncvenv` venv no longer exists). GUI drags themselves are CGEvent mouse-synthesis over SSH and need no vncdo, but the one-time **Accessibility TCC grant** (AXVM1 rung-b) does — it clicks through the authorization dialog. Without the grant, the AX tree is unreadable and CGEvents won't post, so the four **GUI-drag oracle arms** (HEADORD-d, DAYORD-a, SOMEORD-c, TMPLORD-a) cannot run regardless of disk. **Restore `vncdo` (`pip install vncdotool` into a venv; export `$VNCDO`) to run the `gui` phase.** The eight headless arms need neither vncdo nor AX.

The table below therefore records, per arm, an **evidence-grounded expectation** — derived from already-locked probes (O04/O06/O11, P7/P8/P9, ANYORD, HEADCERT) and the maintainer's 2026-07-27 live-GUI observations baked into the design doc — and marks whether the arm is **[SETTLED-BY-PRIOR]** (existing evidence already answers it; this run is a reconfirmation) or **[PENDING-RUN]** (genuinely open; the expectation is a hypothesis the script tests). No arm's verdict below is presented as freshly observed here.

## Verdict table (expectations pending the run)

| Arm | Question | Expectation (grounded) | Status |
|---|---|---|---|
| **HEADORD-a** | Does a project-specifier native reorder listing headed children reject/damage them? | **RIPS them out — `heading → NULL`** on every listed child (the O06 destructive law). | [SETTLED-BY-PRIOR] O06; run = reconfirm |
| **HEADORD-b** | Does the private reorder command accept the **heading AS the container** (`to do id`/`list id`/`heading id <H>`)? | **NO — error / no-op.** The command's specifier `responds-to` lives on classes `list` and `project` only (P9 sdef read); a heading is a `to do` subclass, not a container class, and its children are addressed via the *project* specifier (scf P1). Expect −1728 / clean no-op with heading FK + index unchanged. A landed re-rank preserving the heading FK would be the breakthrough that makes within-heading order automatable. | **[PENDING-RUN]** genuinely open |
| **HEADORD-c** | Does a headed anytime to-do keep its heading FK through a `someday → anytime` bounce, and where does it land? | Two live hypotheses; the run decides. (i) **FK survives** — `when=` only rewrites `start`/`startDate`/`startBucket`/`index`, never `heading`/`project`, so the item front-inserts *within its heading's bucket* → a usable within-heading placement primitive. (ii) **FK dropped to the unheaded block** → bounce is DESTRUCTIVE of heading membership and useless here. Prior weakly favors (i) (no bounce evidence has ever touched an FK; P9f's heading-clear needed an explicit `list-id=` write), but it is unproven. | **[PENDING-RUN]** genuinely open |
| **HEADORD-d** | Which column encodes within-heading child order? | **`index`** (headed children carry `index` like all project children — O06/O11). GUI drag → `index` delta, heading FK unchanged. | [SETTLED-BY-PRIOR] (O06/O11) — GUI DB-diff re-confirm needs `gui` phase (vncdo) |
| **DAYORD-a** | Is the within-day key `todayIndex`, and do project/area views reflect it? | **Yes — `todayIndex`, shared with Upcoming** (maintainer live-GUI, 2026-07-27, baked into design §1). | [SETTLED-BY-PRIOR] (maintainer) — GUI DB-diff re-confirm needs `gui` phase |
| **DAYORD-b** | Is there a headless day-scoped reorder spelling? | **Only `list "Tomorrow"`** (next-day items, writes `todayIndex` — HEADCERT). No arbitrary-future-day spelling: `list "Upcoming"` is an unproven aggregate, date-shaped `list "2026-07-10"` should error (no such list — P9 `every list` had no date lists), and a **project specifier writes `index` (project order), NOT the day bucket's `todayIndex`** (O04) — so it does not touch day order. **Verdict: no official-surface spelling for an arbitrary future day — the wish-list row stands.** | **[PENDING-RUN]** for the arbitrary-day sweep (Tomorrow leg is [SETTLED-BY-PRIOR]) |
| **ANYBNC** | Does `someday → anytime` bounce front-insert an area-LESS loose anytime to-do, state-preserving? | **Yes (expected).** The bounce front-inserts on `index` below the global min (P7d/P8e project analog; O07/O08 to-do analog), `start=1`/`startDate NULL` restored, `area` stays NULL. Reverse-order legs realize an exact target order (P8e). This would close the area-less loose-anytime gap ANYORD left open (area-less loose to-dos "have no clean container surface"). | **[PENDING-RUN]** (strong prior) |
| **SOMEORD-a** | Area-specifier reorder of that area's **someday** to-dos — clean, corrupting, or rejected? DESTRUCTIVE-RISK. | **Most likely a clean `index` re-rank preserving `start=2` + `area`** (ANYORD proved the area specifier is a deterministic, area-preserving `index` re-rank for *anytime* to-dos; `index` is orthogonal to `start`). **Open risk:** the write normalizes `start 2 → 1` (de-someday's the item), which would be a new destructive oddity. Run on **expendable seeded** `SA-*`; blast radius documented honestly. | **[PENDING-RUN]** genuinely open (destructive-risk) |
| **SOMEORD-b** | Project-specifier reorder with **someday** children — clean or corrupting? | **Clean `index` re-rank preserving `start=2`** (expected; O04 project reorder writes `index`, orthogonal to `start`). | **[PENDING-RUN]** (strong prior) |
| **SOMEORD-c** | Which column encodes within-container someday order? | **`index`** (same column as anytime/active children; someday-ness is `start=2`, independent of the order key). GUI drag → `index` delta, `start=2` preserved. | [SETTLED-BY-PRIOR] (model) — GUI DB-diff re-confirm needs `gui` phase |
| **TMPLORD-a** | Are resting templates drag-sortable within the repeating bucket at all? | **No — drag-inert; any drop lands at the TOP of the resting sub-bucket** (maintainer live-GUI, oddities §9e). §9e's top-insert IS the only mechanic; there is no interleave. The DB-index evidence §9e still lacks would be banked here. | [SETTLED-BY-PRIOR] (maintainer/§9e) — DB-index confirm needs `gui` phase |
| **TMPLORD-b** | Is there a headless template reorder spelling? | **Expected no-op.** Repeating templates are invisible to `to dos` enumeration (oddity 5e), so the private command addressing a container's `to dos` should not see them → no `index` write. (Also: templates cannot be seeded headlessly — `make-repeating` is a ui-vector op — so this arm depends on the `gui` phase seeding ≥2 co-located templates, or on the golden co-locating its two.) | **[PENDING-RUN]** genuinely open |

## Per-probe protocol & analysis

### HEADORD — within-heading child order (the O06 gap)

**Seed** (headless, HX0): `RG-HEAD` project with heading `H1` + headed anytime children `HC1/HC2/HC3`; the script asserts each child's `heading` FK == `H1.uuid` before probing (TJSON nests to-do items following a heading item under it).

- **a** — `_private_experimental_ reorder to dos in project id "<RG-HEAD>" with ids "HC3,HC2,HC1"`. O06 predicts the listed headed children get `heading → NULL` (ripped into the unheaded block). Reconfirmation only.
- **b (the key novel arm)** — address the heading AS the list container, three spellings: `to do id "<H2>"`, `list id "<H2>"`, `heading id "<H2>"` (fresh `RG-HEAD2`/`H2`/`HB*` so `a` doesn't contaminate). Nobody has tried the heading as the *list* (scf P1 proved heading uuids work as *items* inside a project specifier for reordering the headings themselves). Expected error/no-op — the specifier class is `list`/`project` only. **A clean `index` re-rank with the heading FK intact would be the breakthrough: within-heading order becomes automatable and design rule 5's guaranteed set gains the in-heading bucket.**
- **c** — a headed anytime to-do `HD1` (in `RG-HEAD3`/`H3`) through `update?…&when=someday` → `…&when=anytime`. Full state audit before/after: `{index, todayIndex, start, startDate, heading, project, area}`. Decides whether the heading FK survives a bounce and, if so, where in the heading's bucket it lands.
- **d (GUI oracle — needs `gui` phase)** — drag `HGa` past `HGb` inside heading `HG`, diff the DB. Confirms `index` is the within-heading order column (expected) and that the heading FK is untouched by a within-heading drag.

### DAYORD — scheduled day-bucket order

**Seed:** loose `DP-1/2/3` @ 2026-07-10 (a future Upcoming day on the pinned 07-05 clock), loose `TM-1/2/3` @ 2026-07-06 (Tomorrow), and `RG-DAYPROJ` children `DPC1/2/3` @ 2026-07-10.

- **a (GUI oracle — needs `gui` phase)** — drag within the 07-10 day in the Upcoming view; confirm `todayIndex` is the key and that the project/area views reflect it (maintainer already established this live; this banks the DB-index evidence).
- **b** — headless spelling hunt: `list "Upcoming"` (aggregate — which key?), `list "Tomorrow"` (HEADCERT reconfirm — `todayIndex`, next-day only), date-shaped `list "2026-07-10"` / `list "July 10, 2026"` (expect error), and a project specifier with same-day children (expect `index` write, NOT `todayIndex` → does not move the day bucket). **Expected verdict: no official-surface spelling for an arbitrary future day — the wish-list row stands; `list "Tomorrow"` remains the only date-scoped headless reorder, and it reaches only the next day.**

### ANYBNC — area-less loose anytime to-dos via bounce (the queued spec, exactly)

**Seed:** area-less loose anytime `AB-1/2/3` (`start=1`, `startDate NULL`, `area NULL`). Bounce each `someday → anytime` in **reverse desired order** (send `AB-3`, then `AB-2`, then `AB-1`) so the front-inserts compose to `AB-1 < AB-2 < AB-3` by `index`. Assert per leg: `index` lands below the running global `MIN(index)`, `start=1`/`startDate NULL` restored, `area` stays NULL. Records leg-count economics (2 legs/item) and abort behavior. Closes the area-less loose-anytime gap ANYORD documented — via the bounce rather than the (broken, destructive) `list "Anytime"` aggregate.

### SOMEORD — someday buckets INSIDE containers

**Seed:** `SA-1/2/3` someday to-dos in LAB-AREA-A (expendable — the destructive-risk arm); `RG-SOMEPROJ` with someday children `PS1/2/3`. What the shipped `--scope someday` already covers, for the boundary: **loose someday to-dos and area-less someday projects, via the `list "Someday"` anchor-stack two-call** (P6h/P8b to-dos ascend, P9e projects descend). It does NOT cover **within-area** or **within-project** someday order — that is exactly the SOMEORD gap.

- **a** — `reorder to dos in area "LAB-AREA-A" with ids "SA3,SA1,SA2"`. Expected clean `index` re-rank preserving `start=2`; the honest open risk is `start`-field corruption (`2 → 1`). Blast radius documented on the expendable seeds.
- **b** — `reorder to dos in project id "<RG-SOMEPROJ>" with ids "PS3,PS1,PS2"`. Expected clean `index` re-rank preserving `start=2`.
- **c (GUI oracle — needs `gui` phase)** — within-container someday drag; confirm `index` is the key and `start=2` is preserved.

### TMPLORD — repeating templates within a container's repeating bucket

- **a (GUI oracle — needs `gui` phase)** — seed `RG-RPT` with `RT-a/b/c` made repeating (after-completion) via the production `make-repeating` (ui vector, needs the e2e bundle + AX), then drag `RT-a` past `RT-c` in the resting bucket. Oddities §9e (maintainer live) predicts **no interleave — the drop lands at the TOP of the resting sub-bucket**; this run banks the DB-`index` evidence §9e still lacks and confirms §9e's top-insert is the only mechanic.
- **b** — headless: `reorder to dos in project id "<RG-RPT>" with "<reversed template ids>"`. Expected no-op — templates are invisible to `to dos` enumeration (oddity 5e). Depends on the `gui` phase (or the golden) providing ≥2 co-located templates; there is no headless template create.

## What a completed run unblocks in the ratified design

- **Design rule 5 (placement honesty) guaranteed-set.** Today the guaranteed set is the lab-locked reorder scopes (project/area/today/evening/someday/inbox); in-project bucket cases and scheduled day-buckets are explicitly app-default-with-a-note. This campaign's outcomes decide three of those:
  - **Within-heading placement (HEADORD-b/c).** Can within-heading order join the *guaranteed* set in Phase A? **Only if** HEADORD-b lands a heading-as-container re-rank (unlikely) **or** HEADORD-c proves the bounce preserves the heading FK (front-insert into the heading's bucket — a `--first`-equivalent, not arbitrary positioning). If both fail, within-heading placement stays app-default-with-a-note in Phase A, and `todo move --to-heading` can guarantee only container membership (top-of-bucket via the unheaded-block/bounce), never a `--before <sibling>` *inside* a heading. **This is the load-bearing question for whether `--to-heading`/in-heading `--before/--after` are honest in Phase A.**
  - **Within-container someday order (SOMEORD-a/b).** If clean (expected), the someday bucket inside a project/area joins rule 5's guaranteed set via the container specifier — extending `todo reorder`/`todo move` anchor honesty to someday children. If SOMEORD-a corrupts `start`, the area someday bucket stays app-default and a new destructive oddity is filed.
  - **Scheduled day-bucket reorder (DAYORD-b).** Expected to **confirm the DAYORD wish-list row stays open** (no arbitrary-future-day spelling), so day buckets remain rule 5's explicit "app-default with a note" case (design §4) — no vocabulary change, the row stays 🧪 pending a future spelling.
- **No change expected** to rules 1–4 or the detach family (§5): none of these arms touches mixed-kind homogeneity, anchor-migration guards, or containment levels.

## New app oddities

**None recorded** — nothing was executed, so no new quirk is claimed. The one *candidate* is SOMEORD-a `start`-corruption; if the run shows it, file it under oddities §9 the moment observed (the script's SOMEORD-a block prints the exact before/after `start`+`area` for that call).

## Reproduce

```sh
# free ≥10 GiB on /Volumes/Workspace first; restore $VNCDO for the gui phase
TART_HOME=/Volumes/Workspace/tart \
VNCDO=/path/to/vncvenv/bin/vncdo \
  bash lab/scripts/research-reordgaps.sh setup      # clone+boot+airgap+clock-pin+seed (+AX grant & bundle)
  bash lab/scripts/research-reordgaps.sh headless    # HEADORD-a/b/c · DAYORD-b · ANYBNC · SOMEORD-a/b · TMPLORD-b
  bash lab/scripts/research-reordgaps.sh gui         # HEADORD-d · DAYORD-a · SOMEORD-c · TMPLORD-a (needs AX grant)
  bash lab/scripts/research-reordgaps.sh teardown
```

Headless arms need neither `$VNCDO` nor Accessibility; the `gui` phase needs both (setup grants AX only when `$VNCDO` is set). Evidence (gitignored, synthetic) lands in `lab/artifacts/reordgaps-lab/` (`report.txt`, per-arm row/drag JSON, screenshots). After the run, fold the observed deltas into the verdict table above (flip [PENDING-RUN] → observed verdict), close/annotate the matching capability-matrix Ordering rows, and update the probe-backlog entries.
