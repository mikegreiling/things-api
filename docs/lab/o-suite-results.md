# O-suite results — ordering campaign

Suite: [lab/suites/o-suite.json](../../lab/suites/o-suite.json) (11 probes, O01–O12; no O02). Locked 2026-07-04 after discovery + acceptance ×2 with identical verdicts (runs `o-20260704-014924` / `o-20260704-015104`). All probes tier 0, app running in background, no crashes.

Subject: the private AppleScript command `_private_experimental_ reorder to dos in <specifier> with ids "<uuid>,<uuid>,…"` (undocumented, declared in Things.sdef as of 3.22.11) plus the URL `when=` bounce primitive. Together these feed `write.reorder`.

## Verdict summary

| Probe | Finding | Verdict |
|---|---|---|
| O01 | Partial ids list in Today: listed items adopt the given order; unlisted members untouched | supported |
| O03 | **DESTRUCTIVE**: an evening-bucket member included in a Today reorder gets its startBucket silently CLEARED (de-eveninged) — native reorder normalizes the bucket to the targeted list | partial |
| O04 | Project specifier (by name) reorders project children natively | supported |
| O05 | Area specifier (by name) reorders direct area to-dos natively | supported |
| O06 | **DESTRUCTIVE**: project-scope reorder RIPS heading-contained children out of their heading (`heading → NULL`) when their uuids are listed | partial |
| O07 | Bounce, Today: `when=evening → when=today` round-trip FRONT-inserts; neighbors' todayIndex + buckets untouched | supported |
| O08 | Bounce, Evening: inverse round-trip front-inserts within the evening section | supported |
| O09 | `project id "<uuid>"` specifier works (production form — name specifiers are ambiguity-prone) | supported |
| O10 | `area id "<uuid>"` specifier works | supported |
| O11 | Mixed project, full un-headed wire list: heading rows keep their `index`, headed children stay headed — the production wire-list shape is safe | supported |
| O12 | A PROJECT row scheduled in Today is accepted in the ids list and reorders like a to-do (`project` inherits from `to do` in the sdef) | supported |

## Consequences baked into `write.reorder`

- **Scopes**: `today` (native; bucket-0 members incl. scheduled projects — O01/O12), `project`/`area` (native; un-headed open to-do children — O04/O05/O09–O11), `evening` (bounce ONLY — O03).
- **H-REORDER-SCOPE guard** rejects: evening-bucket uuids in today scope (O03), headed children in project scope (O06), non-members, duplicates, stale evening items in evening scope.
- **Wire list**: requests may be partial; the compiled ids list is always requested-order + every remaining eligible member in current order, so placement is deterministic (O01 proved partial sends work but leave the unlisted block's relative position underdetermined).
- **Experimental gating**: the command is undocumented → `config allowExperimental` opt-in + a per-dispatch sdef canary (`Things.sdef` must still declare `command name="_private_experimental_ reorder to dos in"`); `things doctor` reports both.
- **Bounce safeguards**: reverse-order bouncing (each round-trip front-inserts), every leg is a fully verified `todo.update`, membership re-checked between items, placed-prefix order re-verified after each item, ≤ 10 items, clean abort with placed/remaining detail. Note: a bounce rewrites `startDate` to today for stale-dated Today members (when= normalization) — semantics-preserving in every view, but it is a stored-field change.
- **Heading-scoped ordering stays unautomatable** (O06) — tracked in [docs/gaps.md](../gaps.md).

## Sidebar & project ordering (O13–O14, Phase 14a)

- **O13**: moving areas among areas (sidebar order) is IMPOSSIBLE — AppleScript `move area … to before area` errors ('location specifier'); no other surface known.
- **O14**: **projects WITHIN an area reorder natively** — the private command accepts project uuids in an area specifier (`project` inherits `to do`, O12 analog); area/type membership untouched. Extends write.reorder's area scope to projects.
- **scf P1 (2026-07-09)**: **HEADINGS within a project reorder natively too** — the same command accepts heading (`type=2`) uuids in a project specifier; children keep their heading FK and follow. See [s-campaign-results.md](s-campaign-results.md) follow-ups.

## Aggregate list scopes & the sidebar (P7/P8, 2026-07-09)

Runs `things-run-p7-20260709-101502` / `things-run-p8-20260709-102315` (`lab/scripts/research-p7.sh` / `-p8.sh`), prompted by Mike's Anytime↔sidebar mirror observation.

- **The list scopes do NOT share the container scopes' forward semantics.** Container specifiers (`project id`, `area id`, `list "Today"`) re-rank the sent ids in order (O01/O04). `list "Inbox"` ALSO ranks the sent list in order (P8a — re-confirming A6; the shipped inbox compile is correct). But `list "Someday"` STACKS each sent id above the call's ORIGINAL top item — the original top itself never moves (anchor model, 5/5 fits: P6h, P7e ×2, P8b, P8c-partial). The validated **two-call protocol** (push desired-bottom to top, then send the reversed wire list) realizes an exact order (P8b) and ships as the someday scope's compile.
- **Someday accepts loose someday to-dos** (P6h/P7e/P8b — shipped) and **someday PROJECTS moved too** (P7a) but inconsistently across probes (P8c ≠ anchor model) — locked later by P9e (descending stack). NOTE (Mike, 2026-07-09): someday projects do NOT appear in the sidebar — their order is visible in the Someday view only.
- **Anytime loose-to-do reorder: PROVEN UNRELIABLE — will not ship** (P7b moves them, but the dedicated P13 series showed the write is NON-DETERMINISTIC). P13 T5b: identical starting order + identical request produced a DIFFERENT result than T1 (same inputs → `D,C,B,A` once, `C,B,A,D` another time); repeated identical calls DRIFT rather than converge. The Anytime list is a computed aggregate spanning containers, so re-ranking it by the flat `"index"` the private command writes does not map to what the app shows. No operable convention exists; the scope stays unimplemented by design. **SETTLED 2026-07-23 (ANYORD, [anyord-results.md](anyord-results.md)):** the P13 non-determinism is reconfirmed (5 identical calls → 5 non-converging orders) AND a second, DESTRUCTIVE defect isolated — `reorder to dos in list "Anytime"` **strips `area` → NULL** on every loose to-do it touches (oddities §9c). The Anytime GUI is a GROUPED view (ungrouped area-less + per-area + per-project groups) ordered within-group by `"index"` (a global sequence, GUI verified == DB); cross-group placement is grouping, not index — so there is no flat "Anytime order" to bind. **Clean path:** reorder loose anytime to-dos via their CONTAINER (area) specifier (deterministic exact `index` re-rank, area-preserving); area-less loose anytime to-dos have no clean surface. Resolves P7b-vs-P8d: neither the Inbox-forward nor Someday-anchor model holds.
- **Sidebar order: native writes exhaustively dead** (scf2 P6a–g), **but the BOUNCE works** (Mike's idea): clearing a project's area front-inserts it among top-level projects (P7c), attaching front-inserts within the area (P7c2), and a `when=someday → when=anytime` round-trip front-inserts without residue (P7d; P8e: 3-project sequence in reverse desired order → EXACT target order, `start=1`/`startDate NULL` preserved). Ships as reorder scope **"projects"** (bounce-only, plain anytime undated area-less projects). Areas among areas remain UI-only.
- **Heading rows reorder natively in a project specifier** (scf P1) — ships as scope **"headings"**; children follow their heading.

## P9 — native ordering pursuit + list discovery (2026-07-09)

Run `things-run-p9-20260709-131559` (`lab/scripts/research-p9.sh`), after host sdef inspection showed the private command's direct parameter is a bare `specifier` and `responds-to` lives on class `list` (inherited by `area`) and class `project`.

- **SOMEDAY PROJECTS: LOCKED + SHIPPED.** Same anchor rule as to-dos (original top never moves) but the stack DESCENDS — earlier-sent = higher (P9e-e1). The inverted two-call protocol (call 1: desired-bottom; call 2: anchor then FORWARD desired order) produced EXACT results in two trials, and the to-do-style ascending protocol failed exactly as the descending model predicts (e4 control). The someday reorder scope now accepts area-less someday projects (same-type requests only) with the per-type protocol. Scope note (Mike): this order shows in the SOMEDAY VIEW only — someday projects are not sidebar rows.
- **List discovery (P9a):** `every list` = Inbox, Today, **Tomorrow** (hidden, id `tomorrow`), Anytime, Upcoming, Someday, **Later Projects** (hidden, id `later-projects`), Logbook, Trash, plus every AREA (areas are `list` subclass instances). No list CONTAINS areas — there is no container specifier for areas-among-areas.
- **Areas: still fully dead** (P9b/P9c). `make new area` appends with `index=0` (the app writes TMArea."index" only on UI drag — PROD carries real distinct values); application-specifier (`it`), Anytime single + two-call, Someday, and area-in-area spellings with area uuids: all zero-delta.
- **Anytime top-level projects: still native-dead** (P9d — application specifier and Anytime two-call inert). The when= bounce (scope "projects") remains the only surface.
- **Heading soft-delete is headless (P9f, doctrine input):** `update?list-id=<project>` on a headed child CLEARS its heading link (tier 0, moves to project root), and Shortcuts `edit-title` accepts `""` / `" "` as a heading title. Empty-then-blank = functionally deleted without the delete-class consent modal; true row deletion stays interactive.

## Hidden-list & area'd-someday residuals (2026-07-17, HEADCERT campaign)

Two Round-3 residuals settled in the HEADCERT clone (raw AppleScript private-reorder probes; evidence = index/todayIndex deltas). Subjects seeded via URL: 3 to-dos `when=2026-07-06` (Tomorrow), 3 area-less someday projects, 2 area'd (LAB-AREA-A) someday projects.

- **Hidden lists as reorder specifiers — BOTH ACCEPT, BOTH map to `todayIndex`.** `_private_experimental_ reorder to dos in list "Tomorrow" with ids …` reorders next-day-scheduled to-dos (startBucket 0) by **rewriting `todayIndex`** (`"index"` untouched) — the requested order landed exactly, same mechanism as `list "Today"`. `_private_experimental_ reorder to dos in list "Later Projects" with ids …` reorders **area-LESS someday PROJECTS**, ALSO by **`todayIndex`** (`"index"` untouched). So both hidden lists are `todayIndex`-ranked aggregates, NOT `"index"`-ranked containers.
- **Area'd someday projects in the someday scope — REORDERABLE via `list "Someday"`, semantics MATCH the shipped protocol → proposed membership-widening follow-up (NOT built).** `list "Someday"` membership = the someday to-do + the **AREA'd** someday projects (SAP-1/SAP-2); the shipped projects two-call (`bottom` anchor, then `bottom,…forward`) reordered them to the target order by **`index`** (SAP-1 0→−1999, SAP-2 −410→−1411 giving [SAP-1, SAP-2]) — the same column + descending-projects semantics the shipped someday scope uses. Extending the scope's membership (currently `area IS NULL`) to admit area'd someday projects would be a **pure membership widening** (same wire protocol) — reported as a follow-up per the residual's guardrail; nothing wired.
- **Incidental (NOT concluded — flagged for a clean dedicated probe):** area-LESS someday projects appear in `list "Later Projects"` (todayIndex), and a single `list "Someday"` reorder no-oped on them — whereas the shipped someday scope targets area-less someday projects via `list "Someday"` (expecting `"index"`). The list memberships shifted across repeated cross-list reorders and the subjects were mutated, so this is an OBSERVATION, not a proven defect; a fresh-clone probe of the shipped `reorder --scope someday` on pristine area-less someday projects would settle whether that scope targets the right list. (Note: the shipped CLI `reorder --scope someday` on the mutated LP subjects returned `H-REORDER-SCOPE` blocked, i.e. it did not treat them as members — worth a clean re-check.)

## Not probed (future work)

Areas among areas (every spelling dead — P9c exhausts the sdef-informed candidates); ~~the Anytime list-scope convention for loose to-dos (P7b/P8d inconsistent)~~ — **SETTLED 2026-07-23 (ANYORD): no operable convention; `list "Anytime"` is destructive (area-strip) + non-deterministic; reorder via the area container instead. See [anyord-results.md](anyord-results.md)**; checklist-item order (no granular surface anywhere).
