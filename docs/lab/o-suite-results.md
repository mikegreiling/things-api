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

## Not probed (future work)

Sidebar ordering (areas among areas; projects within an area), checklist-item order (no granular surface anywhere), reorder behavior on the Anytime/Someday `index` scale outside containers.
