# GRNDINT — the grand-interleave o-suite certification, the mixed-kind+template refusal BUG, and the reschedule-bounce two-fact rider

**Probed under:** golden `things-lab-golden-v2` · Things **3.22.12** (build 32212016) · macOS Sequoia · DB schema v26 · guest clock pinned **2026-07-05 12:00**. ONE disposable offline Tart clone of `things-lab-golden-v2` (`grndint-lab`, booted `--vnc-experimental`; ordering is local — no cloud account). All day-scope reorders driven through the **SHIPPED CLI** (guest e2e bundle: node + dist + commander — `things reorder` / `things project move`), the certified UI recipe for the rider (`todo reschedule-repeat --dangerously-drive-gui`, golden-v2's baked AXVM1 grant). Ground truth = guest Things DB row deltas (independent read-only SQLite), PID-watched (templates are §1/§6 crash-adjacent — pid stable throughout). Script: [`lab/scripts/research-grndint.sh`](../../lab/scripts/research-grndint.sh). Evidence (gitignored, synthetic): `lab/artifacts/grndint-lab/{*.json,rider-*.txt,report.txt}`.

This is **PR 2** of the template-sort arc — the VM certification of #393's template day-block wiring (register **ORD-19**, previously PENDING) plus the reschedule-bounce rider (TDRAG-4 follow-up). #393 (PR 1) landed the code + engine locks; this sitting proves the shipped wiring against the golden and promotes the o-suite lock.

**Status: RAN + BANKED + CERTIFIED (2026-08-04).** o-suite O34–O37 GREEN on two clean passes (`o-20260804-191106`, `o-20260804-191443`, `lab:compare` identical across 36 probes); e2e-write-smoke template locks GREEN (130 steps, 0 failures). Teardown verified (no leaked VMs).

## Headlines

1. **The three-mechanism grand interleave sorts in ONE `day`-scope op — VM-proven.** A same-07-06-day to-do set of SCHEDULED (`when=`, loose + area-direct) + DEADLINE-FORECAST (deadline-cycle) + a repeating TO-DO TEMPLATE projection reorders together via `things reorder … --in 2026-07-06`, landing the exact target order `F1<S2<TMPL<F2<S1` and, re-run, the REVERSED order `S1<F2<TMPL<S2<F1`. The to-do-template leg (single-id `list "Upcoming"` native front-insert, TMPLSORT-1/§9s) is `userModificationDate`-SILENT with `rt1`/`index`/`start`/`startDate` byte-identical; forecast `index`/`deadline` byte-identical; scheduled `startDate` preserved. The result discloses the umd-silent leg in its `warnings`.
2. **The native `tomorrow` one-call wire carries the template as an ordinary exact-slot member.** A NO-FORECAST tomorrow-day set (07-06 == tomorrow at the 07-05 pin) routes to the native `list "Tomorrow"` reorder — lands the EXACT sent order `S2<TMPL<S1`, and the native re-rank is `umd`-SILENT for ALL members (`index` byte-identical), distinct from the `day` bounce's URL legs. A forecast member force-downgrades the whole group to the `day` bounce (`move.ts` scope pick: `!hasForecastMember && day==tomorrow ? "tomorrow" : "day"`), because the native wire re-dates a forecast row.
3. **The project-template SUFFIX rule holds byte-exactly.** On an arbitrary future day (07-12) the repeating PROJECT template has no headless reach (PTMPL-B), so it is the byte-UNTOUCHED suffix: a conformant wire (`project move … <projTemplate>` last) is ACCEPTED — movables front-insert above, the project template's `todayIndex`/`umd`/`index`/`start`/`startDate`/`rt1` ALL byte-identical (`warnings` disclose the untouched suffix); a NON-conformant wire (project template above a movable) is REFUSED with the ratified `H-REORDER-SCOPE` copy naming the one achievable arrangement.
4. **Experimental-off refuses honestly, naming the template — never a crash-path leg.** With `allow-experimental` off, a template-bearing day-group refuses (`H-REORDER-SCOPE`, "…needs the native private reorder surface … (allow-experimental is off)"), naming the template uuid, on both the to-do arm (`things reorder`) and the projects arm (`things project move`). No dated `when=`/`deadline=` leg is ever compiled onto a template (the §1 crash-path lock).
5. **BUG (real, in the shipped #393 wiring — NOT patched here, per the PR-2 brief).** A MIXED to-do+project day-block set that ALSO contains a repeating template is refused UPSTREAM with the "one kind at a time" index-kind error — even though the day axis is explicitly named and normally intermixes kinds. Root cause: `globalAxisIntermix` ([move.ts](../../src/write/move.ts) ~L1650) gates on `scheduleBucket`/`forecastDeadlineDay` per row but was **not taught templates** in #393; a template row (startDate NULL, no deadline) fails the `.every()` predicate, so the mixed-kind relaxation never fires and the upstream `indexKindRefusal` blocks the set before the day-axis resolver (which #393 *did* teach) runs. This blocks Mike's headline "both kinds + template, one op" case. Minimal repro + fix location below.
6. **Rider (reschedule-bounce, two byte-verdicts).** VERDICT 1 — **DOOR CLOSED (anchor drift):** driving the Repeat dialog daily→weekly→daily on the baked template does NOT restore `rt1_recurrenceRule` byte-identically; the next-occurrence anchor drifts `07-06 → 07-12` and does NOT return (rule length returns to 627 but the embedded anchor date differs). VERDICT 2 — **todayIndex SURVIVES:** a previously-written `todayIndex=-10946` is byte-identical through both reschedule legs. Because verdict 1 is a drift, the round-trip is not a wiring candidate (door closed, not a parked curiosity).

## The certified cases (through the shipped CLI)

Fixture: baked `LAB-REPEAT-DAILY` (to-do template, projects **07-06 = tomorrow**), `LAB-REPEAT-WEEKLY-PROJ` (project template, projects **07-12**); URL-seeded scheduled/forecast members. Packed days 07-06 = `132805376`, 07-12 = `132806144`.

| Case | CLI | Result |
|---|---|---|
| **to-do arm, forward** (`todoarm-fwd.json`) | `reorder F1 S2 TMPL F2 S1 --in 2026-07-06` | Landed `F1 −5773 < S2 −5219 < TMPL −4686 < F2 −4117 < S1 −3594` = target. Template `umd` `1783253090.89771` UNCHANGED; `index=−940` kept; forecast `index`/`deadline` byte-identical; scheduled `startDate` preserved. `warnings`: "1 repeating to-do template(s) … userModificationDate-SILENT". No crash. |
| **to-do arm, reversed** (`todoarm-rev.json`) | `reorder S1 F2 TMPL S2 F1 --in 2026-07-06` | Landed `S1 < F2 < TMPL < S2 < F1` = reversed target; template `umd` byte-identical across BOTH passes. No crash. |
| **native tomorrow** (`o36-tomorrow.json`) | `reorder S2 TMPL S1 --in 2026-07-06` (no forecast) | note "reordered within the Tomorrow day-group (tomorrow scope)"; landed `S2 < TMPL < S1` exact sent order; ALL members `umd`-SILENT + `index` byte-identical; `warnings` none. No crash. |
| **project suffix ACCEPT** (`proj-suffix-accept.json`) | `project move GF1 GS1 <projTmpl> --first` | Landed `GF1 −2317 < GS1 −1738 < PROJTMPL 0`; project template `0\|1783055771.81552\|0\|2\|NULL\|132806144` byte-identical before/after. `warnings`: "1 repeating project template(s) … left byte-untouched … suffix rule". No crash. |
| **project suffix REFUSE** (`proj-suffix-refuse.json`) | `project move GS1 <projTmpl> GF1 --first` | `H-REORDER-SCOPE` (nested under `error.detail.failed`): "a repeating PROJECT template cannot be placed above a movable item on the 2026-07-12 day-block … The only arrangement this day-group can reach headlessly is: GS1, GF1, PROJTMPL …". Template byte-unchanged. exit 3. |
| **experimental-off** (`exp-off-{todo,proj}.json`) | either arm, `allow-experimental=false` | `H-REORDER-SCOPE`: "the <day> day-group contains repeating template(s) [<uuid>] whose day-block placement needs the native private reorder surface … (allow-experimental is off)". Names the template. exit 2 (to-do) / 3 (proj). |

### The o-suite + e2e locks (option A split)

- **o-suite O34–O37** ([lab/suites/o-suite.json](../../lab/suites/o-suite.json)) reproduce the compiled wire as raw URL/AppleScript DB-diff rows (O31–O33 precedent — the app-mechanics drift detector): O34 (day-bounce to-do interleave forward), O35 (reversed, own `GR-*` fixture), O36 (native tomorrow wire), O37 (project-template suffix accept, template byte-untouched). Two GREEN passes, `lab:compare` identical across 36 probes.
- **e2e-write-smoke** ([lab/guest/e2e-write-smoke.sh](../../lab/guest/e2e-write-smoke.sh)) drives the SHIPPED `things reorder`/`things project move` binary end-to-end: the grand interleave (exit 0 + umd-silent disclosure), suffix accept (exit 0 + byte-untouched disclosure), suffix refuse (exit 3 + ratified `H-REORDER-SCOPE` copy), experimental-off (exit 3 + names the template). GREEN (130 steps, 0 failures).

## The BUG — mixed-kind + template refused upstream (globalAxisIntermix not template-aware)

**Minimal repro** (grndint-lab, dry-run — deterministic at the guard):
```
things reorder <to-do> <project> <template> --in 2026-07-06
  → usage error: "one kind at a time — an index bucket sorts to-dos and projects in
    separate order-spaces … a mixed set cannot re-rank in one call: …"
things reorder <to-do> <project>            --in 2026-07-06   → OK (move-plan)   # same set minus the template
things reorder <to-do> <template>           --in 2026-07-06   → OK (move-plan)   # both to-dos + template
```
The refusal fires ONLY when both kinds AND a template are present. `globalAxisIntermix` ([move.ts](../../src/write/move.ts), in `runInPlaceReorder`) requires `rows.every(r => scheduleBucket(r)∈{today,evening,scheduled:} || forecastDeadlineDay(r)≠null)`. A repeating template row has `startDate` NULL and no deadline, so it satisfies NEITHER branch → `globalAxisIntermix=false` → with a wrong-kind movee present (a project on `todo reorder`), `indexKindRefusal` returns before `resolveReorderAxis` (which #393 taught to admit templates on the day axis) is ever reached.

**Fix location (for a follow-up PR — NOT applied here):** add a template-with-strictly-future-projection disjunct to the `globalAxisIntermix` `.every` predicate (mirroring `rowDayKey`'s template branch), so a template-bearing mixed-kind set falls through to the day-axis resolver like a template-free one. This is a one-clause gate omission in #393, not an app quirk. Its impact: Mike's mixed-kind+template one-op interleave is currently unreachable via the CLI (the single-kind arms — O34–O37 — work; the mixed-kind arm is blocked). Tracked in [docs/up-next.md](../up-next.md).

**Secondary surfacing wart:** the ratified `H-REORDER-SCOPE` refusals (suffix non-conformant, experimental-off) surface NESTED under a generic top-level `verify-failed` / "the reorder leg did not complete (blocked)" with non-canonical exit codes (2/3, not the blocked-hazard 4). The helpful copy is present but buried. Noted for a follow-up surfacing pass; not blocking (the copy is intact and asserted).

## The reschedule-bounce rider (two byte-verdicts)

Driven through the shipped `todo reschedule-repeat … --dangerously-drive-gui` (the UIC1-certified Repeat-dialog recipe) on baked `LAB-REPEAT-DAILY`, with a live `todayIndex=−10946` written beforehand. Two legs: daily→weekly (projection day moves), weekly→daily (shift back). Evidence: `rider-{before,mid,after}.txt`.

| | before (daily) | mid (weekly) | after (daily again) |
|---|---|---|---|
| `todayIndex` | −10946 | −10946 | **−10946** |
| `rt1_nextInstanceStartDate` | 132805376 (07-06) | 132806144 (07-12) | **132806144 (07-12)** |
| `rt1_recurrenceRule` len | 627 | 628 | 627 (bytes DIFFER — anchor date embedded ≠ original) |

**VERDICT 1 — DOOR CLOSED (anchor drift).** The daily→weekly→daily round-trip does NOT restore `rt1_recurrenceRule` byte-identically; the next-occurrence anchor drifts `07-06 → 07-12` and stays there (the back-to-daily leg carries the anchor forward from the weekly leg rather than resetting to the natural daily cadence). A reschedule round-trip is therefore NOT anchor-idempotent — not a wiring candidate. This is a Things-app behavior of the Repeat dialog's rule edit (the next date derives from current state), filed as an oddity.

**VERDICT 2 — todayIndex SURVIVES.** The previously-written `todayIndex=−10946` is byte-identical through both reschedule legs — a template's day-block ordinal survives a rule reschedule untouched. (This is the clean fact; it does not by itself open a wiring candidate given verdict 1's drift.)

No crash on either leg (pid stable).

## Reproduce

```sh
export TART_HOME=/Volumes/Workspace/tart
export VNCDO=/Volumes/Workspace/Projects/things-api/lab/vncvenv/bin/vncdo   # gitignored venv (rider only)
bash lab/scripts/research-grndint.sh setup       # clone golden-v2 + boot + airgap + clock-pin + ship node/dist bundle
# ground truth is captured by driving the shipped CLI directly over ssh (see report.txt);
# the o-suite + e2e locks certify it unattended:
npm run lab:run -- --suite lab/suites/o-suite.json   # O34–O37 (run twice + lab:compare for the gate)
bash lab/scripts/e2e-write-smoke.sh                  # the template CLI locks
bash lab/scripts/research-grndint.sh teardown
```
