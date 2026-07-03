# A-suite + X-suite results — AppleScript campaign (Lab-4 exit)

**Environment:** things-lab-golden-v1 · Things 3.22.11 (trial build 32211007) · macOS 15.6 guest · pinned clock 2026-07-05 · schema fingerprint verified at bootstrap each run.

**Acceptance (two identical unattended green runs per suite, 2026-07-03):** `a-20260703-070139`/`a-20260703-070507` (39 probes) and `x-20260703-070823`/`x-20260703-070906` (3 probes) — every probe green, `lab:compare` identical. A U-suite regression run (`u-20260703-070950`) re-proved all 22 URL probes green after the tier-rule refinement below. A00 (sdef inventory) is covered statically: design doc §8 + vendor/manifest.json (trial sdef byte-identical to MAS).

## Headline findings

1. **AppleEvent auto-launch STEALS FOCUS (tier 2) — central hypothesis refuted.** An AppleScript command to closed Things launches it *and activates it* (A40 read, A41 write). The design assumed background auto-launch (tier 0–1). Consequence for the write API: **pre-launch Things with `open -g -a Things3`, then send AppleEvents** — against a running background app, every AppleScript read and write measured tier 0.
2. **AppleScript guards where the URL scheme crashes.** `schedule` on a repeating template returns a clean error — `Things3 got an error: Cannot schedule to-do (302)`, exit 1, zero DB delta (A21). The URL `when=` on the same row kills the app (U12). The write API's repeating-item guard can route schedule-like operations to AppleScript's error path instead of hard-blocking blindly.
3. **The private reorder command works** (A50): `_private_experimental_ reorder to dos in list "Today" with ids "<uuid>,<uuid>"` reorders Today deterministically (verified via `todayIndex`). Native reorder obsoletes the bounce hack — version-fragile, gate behind an experimental flag, but real.
4. **The private `json` property works** (A51): `_private_experimental_ json of to do id …` returns a JSON document for any to-do — including data invisible to every public read surface (checklist items; recurrence config on templates).
5. **Deletes are heterogeneous:**
   - to-do delete → `trashed=1`, links intact, restorable (A24)
   - **project delete is shallow**: only the project row gets `trashed=1`; children keep `trashed=0` and their `project` link — Trash membership of children is *derived through the parent* (A24B). Mirrors of the Trash view must traverse.
   - area delete → **row hard-deleted** (A25); contained to-dos get `trashed=1` (A25B)
   - tag delete → row hard-deleted, TMTaskTag assignments cascade (A26)
   - empty trash → all `trashed=1` rows hard-deleted (A27)
   - **No TMTombstone rows are written for any of these** — with Things Cloud disconnected, tombstones (a sync artifact) never appear. Untestable in the airgapped lab; flagged for the (out-of-scope) sync validation track.
6. **Repeating templates are invisible to AppleScript list reads but directly addressable** (A12): `to dos of list "Someday"` omits the template (same blind spot as things.py); `to do id "<uuid>"` fetches it fine — and A51's private json exposes its recurrence config.
7. **Tag reads return direct tags only** (A13) — inherited area/project tags are not materialized, consistent with the DB model (U18).
8. **`to dos of project` includes heading-contained children** (A11) — AppleScript flattens headings (which don't exist in its object model; A31 errors as expected, as does checklist access, A30).

## Verdicts (39 A-probes + 3 X-probes)

All verdicts identical across both acceptance runs. Highlights beyond the findings above; full evidence in `lab/artifacts/<runId>/evidence/`.

| probe | operation | verdict | tier | notes |
|---|---|---|---|---|
| A10 | read.lists | supported | 0 | all built-in lists enumerable incl. Logbook + Trash |
| A14 | read.selection | supported | 0 | `selected to dos` = 0 without UI selection (headless-safe) |
| A01/A01B | todo.create | supported | 0 | default locus = Inbox (`start=0`); `at beginning of list "Today"` honored |
| A02–A05 | project/area/tag create + hierarchy | supported | 0 | the URL-scheme gaps, all confirmed |
| A06 | todo.create-full | supported | 0 | `due date` (AppleScript date) → packed `deadline`; `tag names` binds existing tags |
| A20 | todo.update | supported | 0 | property setters |
| A21B | todo.schedule | supported | 0 | `schedule … for (current date) + N * days` → `start=2` + packed `startDate` — fills `move`'s Upcoming gap |
| A22/A22B | todo.move | supported | 0 | list moves; project/area via property setters (mutually exclusive: setting area clears project) |
| A22C | move to Upcoming | unsupported | 0 | errors, as documented; `schedule` is the path |
| A23/A23B | status set/reopen | supported | 0 | completed sets `stopDate`; reopen clears it |
| A28 | log completed now | supported | 0 | completed row unaffected at DB level |
| A29 | class conversion | unsupported | 0 | to-do⇄project immutable |
| A42 | activate | supported | 2 | the only deliberate focus-steal |
| A43 | mutation during URL-error modal | supported | 0 | modal ≠ execution lock for AppleEvents either (T13 cross) |
| A52 | parse quicksilver input | supported | 0 | quick-capture syntax creates in Inbox |
| A53 | show quick entry panel | disruptive-only | 3 | window titled "Quick Entry" |
| A54 | edit | disruptive-only | 3 | navigates main window (title change), no new window |
| X01 | cross-vector identity | supported | 0 | AppleScript-created uuid stable through URL mutation |
| X03 | rapid interleave | supported | 0 | 3 back-to-back mutations across vectors all land |
| X04 | delete + re-add | supported | 0 | identity not reused: two rows, one trashed |

X02 lives in the A-suite as A43. X05 (cold-start races) deliberately omitted: nondeterministic by nature; bounded instead by the write API's serialized-mutation rule.

## Tier-model refinement

Bare activations can surface the same untitled companion window that launches show (A42). The tier detector's window budget is now `launch ? 2 : activated ? 1 : 0`; all previously locked U-suite tiers re-validated green under the new rule (`u-20260703-070950`).

## Consequences for the write API (Phase 5)

- **Vector routing:** AppleScript joins URL as a tier-0 vector *provided Things is already running* — the pipeline should ensure a background launch (`open -g`) before dispatching either vector from a closed-app state.
- **Operation coverage gained:** area/tag create+delete+hierarchy, Upcoming scheduling, list moves, native Today reorder (experimental-gated), checklist/recurrence reads via private json (experimental-gated).
- **Hazard table update:** repeating `schedule` via AppleScript = guarded error (safe to attempt, error surfaced); repeating `when=` via URL = crash (hard-block stays).
- **Trash semantics:** project trash membership is derived — any "list trash" or "restore" feature must traverse parent links, not filter `trashed=1` alone.
