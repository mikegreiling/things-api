# ANYORD — the Anytime aggregate-reorder wire convention, settled

Run `things-run-notesmd-anyord-20260723-135451` (offline pinned clone; `lab/scripts/research-anyord.sh`), settling the UNSETTLED Anytime loose-to-do reorder convention (up-next §0 item 4; P7b vs P8d disagreed — see [o-suite-results.md](o-suite-results.md) §P7-P9 and the P13 non-determinism note). Also produces the Anytime ordering-semantics map the §6 sort-ergonomics design round needs.

**Seed.** 7 loose **anytime** to-dos (`start=1`, `startDate NULL`), spread across ≥2 areas + area-less: `AO-A1/A2/A3` in LAB-AREA-A, `AO-B1/B2` in LAB-AREA-B, `AO-X1/X2` area-less. Reorders sent via the private AppleScript command `_private_experimental_ reorder to dos in list "Anytime" with ids "<csv-uuids>"`.

## Verdict: NO operable wire convention — the aggregate reorder is DESTRUCTIVE **and** non-deterministic. Do NOT ship it.

`reorder to dos in list "Anytime"` on loose anytime to-dos fails on two independent counts:

1. **DESTRUCTIVE — it strips area membership.** A single call on the pristine `AO-B1,AO-B2` pair (both in LAB-AREA-B) set **`area` → NULL** on BOTH, yanking them out of their area into the flat area-less Anytime section. Isolated and reproduced (AO-B untouched until this one call; area `2piYxp6U` → NULL). This is a data-mutating side effect of an *ordering* command → new oddities entry.
2. **NON-DETERMINISTIC — repeated identical calls never converge and never match the request.** Sending the identical request `"AO-A1,AO-A2,AO-A3"` **five times in a row** produced five DIFFERENT orders — `A3,A2,A1` → `A2,A1,A3` → `A3,A1,A2` → `A2,A1,A3` → `A3,A1,A2` — none of them the requested `A1,A2,A3`, no convergence. (A single *first* call on a fresh set may coincidentally match the request, as the very first probe did — it does not generalise, exactly the P13 finding.)

The command writes the **`index`** column (not `todayIndex`), stacking the sent ids below the current global minimum each call (indices marched −4139 → −8274 over the series).

**This resolves the P7b-vs-P8d disagreement:** neither the Inbox-style forward re-rank (P8a) nor the Someday-style anchor-stack (P8b) holds — the Anytime aggregate command is simply broken for this purpose. P13's "will not ship / non-deterministic" stands, now with the additional destructive-area-strip finding. **No reorder scope should target `list "Anytime"`.**

## Anytime ordering-semantics map (for the §6 sort-ergonomics round)

**The Anytime view is a GROUPED aggregate, not a flat list:**

- an **ungrouped top section** = area-less loose anytime to-dos (+ area-less Today/anytime items);
- then **one group per AREA** (with an area header) holding that area's loose anytime to-dos;
- then **one group per PROJECT** holding that project's anytime children.

**Within each group/section, order = the `index` column, ascending** (lower `index` sorts higher). Verified against the GUI: after the reorders the ungrouped section rendered `AO-A3, AO-A1, AO-A2, AO-X2, AO-X1` — exactly the DB `index` ascending order (−8274, −8087, −7897, −2911, −2343). So the GUI faithfully sorts each group by `index`; the non-determinism lives entirely in the *write*, not the display.

**`index` is a single GLOBAL sequence** (not per-container) — one monotonic counter shared across all items — but because only same-group items are displayed together, it functions as a within-group sort key. **Cross-group placement is determined by GROUPING (area/project membership), NOT by `index`.** There is therefore **no single flat "Anytime order"** for a reorder command to bind to — which is exactly why flattening the aggregate (`list "Anytime"`) doesn't map to what the app shows.

**What "order within Anytime" binds to, per group:** the member's `index`. To change it deterministically, reorder within the CONTAINER, not the aggregate.

## The clean, deterministic alternative (recommendation for the build)

**Reorder loose anytime to-dos via their CONTAINER specifier, never the aggregate.** Confirmed: `_private_experimental_ reorder to dos in area "LAB-AREA-A" with ids "…"` is an **exact forward re-rank on `index`, deterministic, and area-preserving** — `C1,C2,C3` → `AC-1,AC-2,AC-3` (stable on repeat), `C3,C1,C2` → `AC-3,AC-1,AC-2` (stable on repeat), area retained throughout (the O04 within-project law generalises to within-area). This is the same shape the shipped `reorder --scope area` already uses.

- **Area'd loose anytime to-dos** → reorder via the area container (deterministic, non-destructive). ✅ operable.
- **Area-less loose anytime to-dos** → have **no clean container surface** (they exist only in the flat top section; the only reach is the broken aggregate command). So an "Anytime reorder scope" for area-less items is **not buildable** on any reliable convention today. ✅ documented gap.

**Design conclusion for §6:** do not add an `anytime` reorder scope bound to `list "Anytime"`. If within-Anytime reordering is wanted, express it as **container-scoped** (area) reordering; area-less loose anytime to-dos remain un-reorderable via automation. The reorder ergonomics round should treat "reorder within Anytime" as "reorder within the area group," not "reorder the flat Anytime list."

## Reproduce

```
TART_HOME=/Volumes/Workspace/tart \
VNCDO=/path/to/vncvenv/bin/vncdo \
  bash lab/scripts/research-anyord.sh
```

Offline pinned clone; seeds the loose anytime to-dos, runs the aggregate reorder series (determinism + area-strip probes) and the container-specifier control, screenshots the grouped Anytime view. Evidence (gitignored, synthetic): `lab/artifacts/things-run-notesmd-anyord-20260723-135451/ao-01-anytime-baseline.png` (grouped view), `ao-02-areaA-gui.png` (GUI == DB index order).
