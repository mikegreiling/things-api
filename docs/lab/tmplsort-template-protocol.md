# TMPLSORT — the template-sorting protocol, the `with ids` wire-syntax artifact, and the corrected mixed-wire law

**Probed under:** golden `things-lab-golden-v2` · Things **3.22.12** (build 32212016) · macOS Sequoia · DB schema v26 · guest clock pinned **2026-07-05 12:00**. Two sittings, both one disposable offline Tart clone of `things-lab-golden-v2` (booted `--vnc-experimental`; ordering is local — no cloud account): the **TMPLSORT campaign 2026-08-03** (arms 1/2 + the project-template arms) and the **wire-syntax audit recovery 2026-08-04** (the coercion law + the multi-id re-probes, VM `tmplsort-lab`). Repeating-to-do templates for the 2026-08-03 fixture were GUI-created via **vncdotool** against the framebuffer (`File ▸ New Repeating To-Do`, the UI1 recipe; the golden bakes only two templates); every reorder wire is headless AppleScript, PID-watched (templates are §1/§6 crash-adjacent). Script: [`lab/scripts/research-tmplsort.sh`](../../lab/scripts/research-tmplsort.sh). Evidence (gitignored, synthetic): `lab/artifacts/tmplsort-lab/{report.txt,snap-*.txt,screens/*.png}`.

This began as the follow-up TDRAG-3 (#390, [tdrag-ax-residuals.md](tdrag-ax-residuals.md)) made plausible — proving the full template-sort protocol the front-insert primitive implies. In finalising it we discovered a **wire-syntax artifact** that invalidated a family of published multi-id findings, so the campaign grew a second half: audit every `with ids` usage in the lab scripts, establish precisely what the malformed calls did, and RE-PROBE the invalidated laws with the correct wire.

**Status: RAN + BANKED (2026-08-03 arms 1/2) + RE-PROBED + CORRECTED (2026-08-04).**

> **⚠ FORWARD-POINTER (2026-08-04, PTMPL) — the PROJECT-template claims below are SUPERSEDED; this evidence body is left intact per the immutable-snapshot policy.** A follow-up sitting ([ptmpl-project-templates.md](ptmpl-project-templates.md)) verified the repeating PROJECT template EYES-ON (screenshots) and found: **(1)** the projection RENDERS as a first-class, selectable, drag-sortable `todayIndex` row INSIDE its Upcoming day block (and the Later Projects view) — so "renders in the sidebar as a project, not as an Upcoming day-block projection row" (headline 3 / §"Project templates — INERT" / the verdict) is **FALSE** (the sidebar shows only the active series ROOT, never the projection); the GUI drag writes the template row's `todayIndex` alone, `umd`-silent, and persists. **(2)** "repeating PROJECT templates are INERT for this surface" is **surface-specific, not absolute**: single-id `list "Upcoming"`/`list "Today"`, the `area id` specifier, and `list "Later Projects"` are no-ops/skip on the project template, BUT **`list "Tomorrow"` (when the projection day == tomorrow) cleanly writes it** — single-id front-insert AND multi-id EXACT-slot member (`umd`-silent, no reparent, no crash, no instance contamination), exactly like a to-do template (TMPLSORT-3). The single-id `list "Upcoming"` no-op itself is re-confirmed. See [ptmpl-project-templates.md](ptmpl-project-templates.md) §PTMPL-A / §PTMPL-B.

## Headlines

1. **THE WIRE-SYNTAX ARTIFACT — a multi-item AppleScript LIST literal on `with ids` is a hard −1700, not a no-op.** The shipped private-reorder op sends ONE comma-joined quoted TEXT (`with ids "id1,id2,id3"`, `src/write/commands.ts`). Two lab scripts (`research-tdrag.sh`, `research-tmplsort.sh`) instead hand-rolled AppleScript LIST literals (`with ids {"id1","id2","id3"}`). A **multi-item** list literal on that parameter throws **`Can't make {…} into type text. (-1700)`** at the AppleEvent parameter-coercion boundary — **the app never runs the reorder.** The probe harness's `gas` helper swallowed the error (`… 2>&1 || true`, no exit/stderr check), so the −1700 masqueraded as a clean **no-op**. Every "mixed wire = full no-op" law built on those calls was measuring a REJECTED call, not app behaviour. (A **single-item** list `{"x"}` coerces to its element `"x"` cleanly, so single-id list-literal probes were *accidentally valid* — the single-template findings survive; see the audit table.)
2. **TMPLSORT-1 — the templates-only sort PROVES OUT for repeating TO-DO templates** (2026-08-03, single-id valid). Three daily to-do templates tied at `todayIndex=0`, dispatched by single-id `list "Upcoming"` front-insert in reverse target order, land the exact target order (`TS-B −1551 < LAB-REPEAT-DAILY −953 < TS-A −554`), each leg writing only the dispatched template's `todayIndex` (`rt1`/`start`/`startDate`/`tiRef`/`index`/`umd`/`project` byte-identical), contamination-free.
3. **TMPLSORT-1 — repeating PROJECT templates are INERT for this surface** (2026-08-03, single-id valid). The single-id `list "Upcoming"` reorder is a genuine full no-op on a repeating **project** template's `todayIndex` (zero DB delta, twice) — it renders in the sidebar as a project, not as a reorderable Upcoming day-block projection row.
4. **TMPLSORT-3 CORRECTED (2026-08-04 re-probe) — a VALID multi-id day-block wire carrying a template is NOT a no-op: it re-ranks the template as a first-class member.** With the correct comma-text wire: (a) `list "Upcoming" with ids "SA,TEMPLATE,SB"` WRITES the template's `todayIndex` (0 → −1464) and re-ranks the co-wired ordinary row, `umd`-silent, no reparent, no crash; (b) `list "Tomorrow" with ids "TM2,TEMPLATE,TM1"` (all three valid tomorrow members) is a **full sort landing the EXACT sent order TM2 < TEMPLATE < TM1 — the template placed at an arbitrary MID-slot**, not merely front-inserted; (c) a `list "Today"` wire whose template is NOT a Today member re-ranks the valid Today members and **silently SKIPS** the non-member template (no poison, no crash). So "front-insert-ONLY / mixed wire is a full no-op / a template id poisons the whole call" was entirely the −1700 artifact.
5. **The `project id` reparent hazard STANDS** (single-id valid): `reorder to dos in project id <P> with ids "<template>"` reparents the template (`project` NULL→P + `umd` bump); reversible via `update?list-id=` empty. Never resolve a template uuid onto the `project id` specifier.
6. **ORD-18 (TDRAG-5) re-verified — conclusion holds, provenance corrected.** A scheduled row carries a distinct non-zero `index`, scheduling PRESERVES it, and the dated `day` bounce is `index`-byte-isolated (`todayIndex` front-inserts, `index` byte-identical). The distinct `index` came from ANYTIME-in-project CREATION (sparse index) + a valid comma-text reorder — NOT from the list-literal reorder the original doc credited (which −1700-errored and did nothing).

## The verdict

**Template cell — SORTABLE for repeating TO-DO templates; INERT for repeating PROJECT templates.** A repeating to-do template's Upcoming day-block projection is a fully sortable, first-class member of the block `todayIndex` axis, reachable by the private `_private_experimental_ reorder to dos in list "Upcoming"`/`list "Tomorrow"` command **both** as a single-id front-insert (reverse-target dispatch lands an exact block order — TMPLSORT-1) **and** as a member of a multi-id day-block wire (a `list "Tomorrow"` multi-id wire lands the exact requested order with the template at an arbitrary slot — TMPLSORT-3 corrected). The write is `umd`-silent, `rt1`/containment-safe, crash-free, and contamination-free. Repeating **project** templates are inert (no reorderable projection row; their instances sort as ordinary scheduled projects). Wiring guards: (1) **never** resolve a template id onto the `project id` specifier — it REPARENTS (reversible via `list-id=` empty, but a silent container move); (2) the template leg is `userModificationDate`-silent (a `umd`-diffing watcher/sync-differ misses it — §9r); (3) **refuse project templates**. **NOT wired here — probes + docs only; wiring is a maintainer-ratification follow-up** (the `day` reorder scope's forecast/scheduled interleave would gain a template leg family, gated by `allow-experimental` + the sdef canary, with an o-suite lock authored at wiring time). The earlier planner guidance to "refuse-or-split a mixed template wire because it is a harmless no-op" is **withdrawn** — the mixed wire is a real writer.

## The wire-syntax artifact and the coercion law (RE-PROBE, 2026-08-04)

The shipped op ([`src/write/commands.ts`](../../src/write/commands.ts) private-reorder command) always emits ONE comma-joined quoted TEXT:

```
_private_experimental_ reorder to dos in <specifier> with ids "id1,id2,id3"
```

The `with ids` parameter is **text-typed**. Two lab scripts hand-rolled AppleScript LIST literals instead. Micro-probe (`rp-coerce`, one clone) established exactly what that did:

| Form | What AppleScript does | Result |
|---|---|---|
| `({"aa","bb","cc"}) as text` (bare coercion) | list→text with default text-item-delimiter `""` | **concatenates → `"aabbcc"`** (no error) |
| `… with ids {"a","b","c"}` (multi-item, the malformed probe) | the **typed command parameter** refuses the AE list | **`Can't make {…} into type text. (-1700)`** — the command is REJECTED at the AppleEvent boundary; **the app never runs** |
| `… with ids {"x"}` (single-item) | single-element list coerces to its element | **`"x"`** — a valid single id (accidentally correct) |
| `… with ids "a,b,c"` (the shipped comma-text) | already text | **accepted** — a real multi-id re-rank |

**The law:** a multi-item list literal on `with ids` is a **hard −1700 at the parameter-coercion boundary**, distinct from the bare `{…} as text` concatenation — AppleScript does not pre-flatten a list for a typed command parameter; it ships an AE list and the app's unmarshaller rejects it. Because `gas` ran `osascript … 2>&1 || true` and no probe checked osascript's exit code, the −1700 printed nowhere the probes read and looked like a silent no-op. **Direct control (`rp-coerce`), three anytime rows in `LAB-PROJ-PLAIN` (resting `index` −70/−25/0, distinct from creation):**
- **NEGATIVE (list literal `{CE3,CE1,CE2}`):** AS returned `… -1700`; `index` **unchanged** (−70/−25/0) — the app never re-ranked.
- **POSITIVE (comma-text `"CE3,CE1,CE2"`):** no error; `index` → **CE3 −2117 < CE1 −1678 < CE2 −1254** (ascending in the sent order) — a real multi-id re-rank.

## The `with ids` syntax audit (every `lab/scripts/research-*.sh`)

Every reorder-issuing lab script was classified. **All scripts use the comma-text form EXCEPT `research-tdrag.sh` and `research-tmplsort.sh`**, which used LIST literals. Single-id list literals are accidentally valid; multi-id list literals are INVALID (−1700, app never ran).

| Script | Line(s) | Wire form | Class | Published claim resting on it |
|---|---|---|---|---|
| `research-anyord / dlbnc / bounce2 / bouncejson-headxproj / headsub1 / headsub2 / ordfin1 / ordfin2 / p7 / p8 / p9 / p13 / p14 / phase21b-a / parked / reordgaps / scf2 / scf3 / scampaign-followups / sit4 / sit6 / upcord1 / upcdl`.sh | all | comma-text `with ids "…"` | **VALID** | all certified/CLI-driven ordering evidence — SAFE, as expected |
| `research-tdrag.sh` | 355, 398, 414 | single-id `{"$TMPL_TODO"}` | valid (accidental) | TDRAG-3-1 single `list "Upcoming"` writer; TDRAG-3-3 `project id` reparent — **stand** |
| `research-tdrag.sh` | **262** | multi-id `project id … {OE3,OE1,OE2}` | **INVALID** | ORD-18 / TDRAG-5 "a native reorder GAVE distinct index" — provenance corrected |
| `research-tdrag.sh` | **363, 367** | multi-id `{SC2,tmpl,SC1}` (Upcoming, project-id) | **INVALID** | TDRAG-3 arm3 first-run mixed-wire "no-op" reads |
| `research-tdrag.sh` | **407** | multi-id `list "Upcoming" {SA,tmpl,SB}` | **INVALID** | **TDRAG-3-2** "mixed wire = full no-op, front-insert-ONLY" — CORRECTED |
| `research-tmplsort.sh` | 302, 341, 366, 394, 441 | single-id `{"$u"}` / `{"$TB"}` | valid (accidental) | TMPLSORT-1 templates-only + project-INERT + arm2 template legs + arm3b reparent — **stand** |
| `research-tmplsort.sh` | **422** | multi-id `list "Upcoming" {SCH1,TA,SCH2}` | **INVALID** | TMPLSORT-3a "mixed wire = harmless no-op" — CORRECTED |
| `research-tmplsort.sh` | **472, 480** | multi-id `list "Today"/"Tomorrow" {…}` | **INVALID** | TMPLSORT-3c "template id poisons the wire, both no-ops" — CORRECTED |

`research-tmplsort.sh` has since been **fixed to the comma-text form** (its `reorder_wire` helper wraps a bare comma-joined id string in `with ids "…"`; every call site converted); `research-tdrag.sh` carries a forward-pointer header comment (its probe lines are the immutable record of what produced the now-corrected evidence). The certified o-suite (O31–O33) and all CLI-driven reorder evidence were never affected — they run the shipped comma-text op.

## Fixture

The golden bakes exactly two repeating templates (`LAB-REPEAT-DAILY` = `W3PZB9e7W6…`, a daily to-do projecting to 07-06, `tiRef=132805376`, `index=−940`, `rt1` ruleLen 627; `LAB-REPEAT-WEEKLY-PROJ` = `759yS6xe6d…`, a weekly **project**, projecting to 07-12). For the 2026-08-03 templates-only/interleave arms, two extra daily to-do templates (`TS-A` `6kNhgHhggR…`, `TS-B` `UbheCdCXZh…`) were GUI-created via vncdotool (`File ▸ New Repeating To-Do`, fixed-daily deadline-less). The 2026-08-04 re-probes use ONLY the baked `LAB-REPEAT-DAILY` + URL-seeded ordinary rows (no VNC) and `LAB-PROJ-PLAIN` = `933TCvzMgM…` / `LAB-AREA-A` = `7Ck4hAXU36…`.

## TMPLSORT-1 — templates-only protocol proof (2026-08-03, single-id valid)

**Target ascending `todayIndex`:** `TS-B < LAB-REPEAT-DAILY < TS-A`. Front-insert ⇒ last-dispatched = most-negative = first, so **reverse-target dispatch = `TS-A, LAB-REPEAT-DAILY, TS-B`** (each a single-id `list "Upcoming"` wire — accidentally-valid class).

| Leg | Wire | Result |
|---|---|---|
| **1 — TS-A** | `reorder to dos in list "Upcoming" with ids "TS-A"` | `todayIndex` **0 → −554** (front-insert). `rt1`/`start`/`startDate`/`tiRef`/`index`/`umd`/`project` byte-identical. No crash. |
| **2 — LAB-REPEAT-DAILY** | `… with ids "LAB-REPEAT-DAILY"` | `todayIndex` **0 → −953** (below TS-A). `index=−940` kept, `umd` unchanged, all else byte-identical. |
| **3 — TS-B** | `… with ids "TS-B"` | `todayIndex` **−84 → −1551** (below DAILY). `umd` unchanged, all else byte-identical. |
| **FINAL** | — | **`TS-B −1551 < LAB-REPEAT-DAILY −953 < TS-A −554` = EXACT target.** GUI re-renders in the sorted order (`proj-scroll.png`). |

**Full-DB write-set:** exactly four `todayIndex` bytes changed — the three dispatched templates plus the co-resident forecast row `LAB-P-2` lazily materialized `0 → −220` (`todayIndex`-only, `umd`-silent, pushed to the block back). **Instance contamination:** completing `LAB-REPEAT-DAILY`'s current instance spawned a clean `todayIndex=0` instance (no contamination). **Verdict:** a reverse-target dispatch of one single-id front-insert per template lands the exact block order, byte-clean and contamination-free — the deadline-cycle protocol shape, realised for repeating to-do templates.

### Project templates — INERT (2026-08-03, single-id valid)

The single-id `list "Upcoming"` reorder on `LAB-REPEAT-WEEKLY-PROJ` is a genuine full no-op — `todayIndex=0` unchanged, **zero DB delta** — run twice: alone in its 07-12 block, AND with two co-resident scheduled rows seeded so a front-insert would have somewhere to land. A repeating project template renders in the **sidebar** as a project, not as an Upcoming day-block projection row; only its spawned **instance** schedules. **Verdict:** the front-insert primitive is a to-do-template phenomenon; it does NOT extend to repeating project templates (their instances sort as ordinary scheduled projects via the existing day scopes).

## TMPLSORT-2 — mixed-block interleave (2026-08-03, single-id + URL legs, VALID)

This arm has **no multi-id list literals** — its template legs are single-id front-inserts (accidentally-valid class) and its scheduled/forecast legs are URL-driven (`when=`/`deadline=`), so it required NO correction. Into the `07-06` block: two scheduled rows (`SCH1`/`SCH2`, `when=` bounce), two deadline-forecast rows (`FC1`/`FC2`, deadline-cycle), and the three templates (single-id Upcoming front-insert). One global **reverse-target** dispatch (`DAILY, TS-B, SCH2, FC2, TS-A, SCH1, FC1`) landed the exact target interleave:

`FC1 −7037 < SCH1 −6590 < TS-A −6135 < FC2 −5472 < SCH2 −4877 < TS-B −4365 < LAB-REPEAT-DAILY −3991`.

Per-family cleanliness held (template legs `todayIndex`-only + `umd`-silent; `when=`/`deadline=` legs `umd`-bumped as URL field-writes always do). **Verdict:** the three front-insert families share ONE global block `todayIndex` min-space; a single reverse-target dispatch with per-family legs lands the exact interleave — the shipped `day` scope's scheduled+forecast interleave (DLBNC O32) generalises to include to-do-template projections as a third leg family. (Now further supported by TMPLSORT-3's finding that a template is a first-class member of a single multi-id day-block wire.)

## TMPLSORT-3 — the mixed-wire law, CORRECTED (RE-PROBE, 2026-08-04)

The 2026-08-03 draft's TMPLSORT-3a/3c rested on multi-id LIST literals (`research-tmplsort.sh:422/472/480`) that all −1700-errored, so their "full no-op / template poisons the wire / harmless refuse-or-split" readings were artifacts. Re-probed on a fresh clone with the correct comma-text wire, using the baked `LAB-REPEAT-DAILY` template + URL-seeded ordinary rows. **PID-watched; no crash on any wire.**

| Probe | Wire (comma-text) | Result |
|---|---|---|
| **3a — mixed `list "Upcoming"`** (`rp-mixed`) | `with ids "SA,TEMPLATE,SB"` (template in the middle; SA/SB scheduled 07-06) | **NOT a no-op.** Template `todayIndex` **0 → −1464** (written), SA **−422 → −1177**, SB (already block-min) **−817 unchanged** → final `TEMPLATE −1464 < SA −1177 < SB −817`. Full-DB diff = exactly 2 rows (template + SA); `umd` **byte-identical** on both; template `project=NULL` (no reparent), `rt1`/`index`/`start`/`startDate`/`tiRef` byte-identical. The template is re-ranked as a first-class addressed row. |
| **3c-Today** (`rp-tt`) | `list "Today" with ids "TD2,TEMPLATE,TD1"` (template is NOT a Today member) | **Valid members re-ranked, non-member template SKIPPED.** TD2 **−1191 → −2212**, TD1 **−625 → −1729**; template `todayIndex` **unchanged** (−1464), no reparent. Full-DB diff = 2 rows (TD1, TD2). The non-member template neither poisons the call nor is written — the ordinary Today members ARE re-ranked. |
| **3c-Tomorrow (decisive)** (`rp-tt`) | `list "Tomorrow" with ids "TM2,TEMPLATE,TM1"` (all three are 07-06 members) | **Full sort, EXACT sent order, template at an arbitrary MID-slot.** TM2 **−2389 → −4097**, template **−1464 → −3639**, TM1 **−1961 → −3055** → final `TM2 −4097 < TEMPLATE −3639 < TM1 −3055` = the sent order `TM2, TEMPLATE, TM1`. Full-DB diff = 3 rows; template `umd`/`rt1`/`project=NULL` byte-identical, no crash. The template is positioned to an arbitrary slot in one multi-id call — decisively NOT front-insert-only. |
| **3b — `project id` reparent** (single-id, VALID — 2026-08-03, unchanged) | `reorder to dos in project id "<P>" with ids "<template>"` | **REPARENT + `todayIndex` front-insert.** `project` NULL→`933TCvzM…`, `umd` bumped, `todayIndex` front-inserts. **RESTORE:** `update?id=<t>&list-id=` (empty) detaches (`project`→NULL, `rt1` byte-identical). The container-clear URL is not guarded on templates, so the reparent is reversible. Never resolve a template uuid onto `project id`. |

**Verdict — TMPLSORT-3 (corrected):** a VALID multi-id day-block reorder wire treats a repeating to-do template as a **first-class member**: it re-ranks the template alongside the co-wired ordinary rows (writing its `todayIndex`, `umd`-silent, no reparent, no crash), and a `list "Tomorrow"` wire lands the EXACT requested order with the template at an arbitrary slot. A wire whose template is NOT a member of the specifier's day skips only that id and still re-ranks the valid members. The one true hazard remains the **`project id` specifier** (reparent, reversible). The prior "mixed wire = full no-op, front-insert-ONLY, template poisons the call, safe to refuse-or-split" was entirely the −1700 syntax artifact.

## ORD-18 (TDRAG-5) spot re-verify — conclusion holds, provenance corrected (RE-PROBE, 2026-08-04)

The original TDRAG-5 credited a **native reorder** (`research-tdrag.sh:262`, a multi-id list literal → −1700) with GIVING three anytime-in-project rows a distinct `index` before scheduling. Re-probed (`rp-ord18`) with a valid reorder:

- The three anytime rows in `LAB-PROJ-PLAIN` rest at **distinct `index` from CREATION** (−70/−25/0); a valid comma-text reorder then set them to −1678/−1254/−2117 — the list-literal reorder the original doc credited did nothing.
- **Scheduling** all three to 07-06 **PRESERVED** the distinct `index` (−1678/−1254/−2117 unchanged; `startDate` stamped, `project` FK kept).
- The **dated `day` bounce** on CE2 (`when=07-07` → `when=07-06`): `todayIndex` **−5266 → −6481** (front-insert) while `index=−1254` is **byte-identical** before/after (`umd` bumped, as URL `when=` writes do).

**Verdict — ORD-18:** the axis-isolation conclusion stands byte-identically (a scheduled row carries a distinct `index`; scheduling preserves it; the dated `day` bounce rewrites `todayIndex` and leaves `index` byte-identical). Only the provenance is corrected: the distinct `index` originates in anytime-in-project creation + a valid reorder, not the −1700-erroring list-literal call.

## Published claims corrected

- **TDRAG-3-2** (`tdrag-ax-residuals.md`), **novel-paths #52**, **oddities §9s**, **assumption-register WG-2**: "front-insert-ONLY — a mixed wire `{scheduled, template, scheduled}` is a full no-op / the template cannot be positioned to an arbitrary slot" → **FALSE**; a valid multi-id wire re-ranks the template as a first-class member (arbitrary slot in `list "Tomorrow"`).
- **TMPLSORT-3a** (this doc, draft): "mixed wire incl. a template = harmless full no-op, planner can refuse-or-split" → **withdrawn**; the wire re-ranks the ordinary rows AND the template.
- **TMPLSORT-3c** (this doc, draft): "a template id anywhere in a multi-element wire poisons the whole call, both full no-ops" → **FALSE**; valid members re-rank, non-member ids skip, an all-member wire fully sorts including the template.
- **ORD-18 / TDRAG-5** provenance (`tdrag-ax-residuals.md`, `assumption-register` ORD-18 row): "a native reorder gave the rows distinct index" → corrected (creation + valid reorder; the cited call −1700-errored). Conclusion unchanged.
- **capability-matrix** template ordering cell: "front-insert-ONLY; a mixed wire including the template no-ops" → corrected.

Merged evidence (`docs/lab/tdrag-ax-residuals.md`) is immutable — it carries a forward-pointer banner to this section rather than a body rewrite. The living reference docs (register / oddities / novel-paths / matrix) are amended in place.

## App oddities filed

- **§9s (correction) — a repeating to-do template is a FIRST-CLASS member of the private multi-id day-block reorder, not just a single-id front-insert; the "mixed wire no-ops" clause was a `with ids` list-literal −1700 artifact.** See the [oddities §9s](../things-app-oddities.md) correction. (The −1700 list-literal coercion itself is an AppleScript/probe-harness gotcha, not a Things app bug — it is documented here and in the fixed script's `reorder_wire` header, not in the oddities bug report.)

## Reproduce

```sh
export VNCDO=/Volumes/Workspace/Projects/things-api/lab/vncvenv/bin/vncdo   # gitignored venv (primary checkout)
TART_HOME=/Volumes/Workspace/tart \
  bash lab/scripts/research-tmplsort.sh setup        # clone golden-v2 + boot(--vnc-experimental) + airgap + clock-pin + warm
# 2026-08-03 arms (need the VNC-created TS-A/TS-B templates — caps/mktmpl):
  bash lab/scripts/research-tmplsort.sh caps ; mktmpl TS-A ; mktmpl TS-B ; arm1-seed
  bash lab/scripts/research-tmplsort.sh arm1 ; arm1-contam ; arm1-proj ; arm1-proj2 ; arm2
# 2026-08-04 wire-syntax recovery (baked LAB-REPEAT-DAILY only, NO VNC):
  bash lab/scripts/research-tmplsort.sh rp-coerce    # the list-literal −1700 coercion law + positive/negative control
  bash lab/scripts/research-tmplsort.sh rp-mixed     # VALID multi-id list "Upcoming" wire carrying a template (corrects TDRAG-3-2 / 3a)
  bash lab/scripts/research-tmplsort.sh rp-tt        # VALID Today/Tomorrow wires (corrects 3c; Tomorrow = decisive)
  bash lab/scripts/research-tmplsort.sh rp-ord18     # ORD-18/TDRAG-5 re-verify (valid-reorder provenance)
  bash lab/scripts/research-tmplsort.sh teardown
```

`arm3a`/`arm3b`/`arm3c` remain (now comma-text-correct) as the full-campaign path with the VNC-created TS-A/TS-B; the `rp-*` arms are the self-contained recovery re-probes that need no VNC. A single clone serves the whole campaign (independent row sets per arm; each `rp-*` wire brackets itself with a before/after full-DB snapshot, so its diff is isolated regardless of block co-residents). Templates are §1/§6 crash-adjacent — every reorder wire is PID-watched.
