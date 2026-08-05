# Resolution-timestamp surface — `--created-at` / `--completed-at` implementation plan

**Status: PLAN — awaiting maintainer sign-off (this PR).** Probe basis: scf2 P4a–P4d, BACKDT (#404), HEADSORT (#400), LOGSORT (#401), WG-7 fix (#405). Maintainer rulings from the 2026-08-05 design conversation are baked in; open recommendations are marked. Independent of the read-shape doctrine v2 migration (#399) — this is pure write surface. Everything lands in **0.14.0** (ALPHA: no shims).

## 1. Vocabulary

- **Delete** `things todo backdate` and `things todo add-logged` (and their client/MCP counterparts) outright.
- **Add two flags, both kinds (to-do AND project), one flag per field:** `--created-at <iso>` and `--completed-at <iso>`, each accepting an ISO date (`2025-01-15`) or datetime (`2025-01-15T09:30`). Date-only normalizes to **noon in the effective zone** (§5).
- **No `--canceled-at`.** CC's own canon settles it: the Get Info modal labels the timestamp **"Completed on"** for canceled items and even archived headings (maintainer-verified screenshots 2026-08-05). One field, one flag; each command's help states once that the completion timestamp applies to canceled items too. (Glossary gains this "Completed on" note — §6.)

## 2. Per-command semantics (identical for to-dos and projects)

| Command | Starting status | Legs | Result |
|---|---|---|---|
| `add … --completed-at [--created-at]` | — | 1 (json import, **atomic**) | born resolved, exact dates, straight to Logbook (P4d / B-PROJ-JSON) |
| `add … --created-at` (alone) | — | 1 (json, atomic) | born open with backdated creation |
| `update … --created-at` | any | 1 (AS `set creation date`, status-safe, umd-silent) | creation changed, nothing else |
| `update … --completed-at` | completed | 1 (AS `set completion date`) | stopDate changed |
| `update … --completed-at` | canceled | 3 (URL flip→completed · AS backdate · URL flip→canceled) | stopDate changed, **canceled preserved** (maintainer ruling; every flip is certified stopDate-preserving) |
| `update … --completed-at` | open | **refuse** → points at `complete --completed-at` / `cancel --completed-at` | lifecycle boundary stays out of `update` (§3) |
| `complete … [--completed-at]` | open | 1–2 (resolve · AS backdate) | completed (backdated if asked) |
| `complete … [--completed-at]` | completed | 0–1 (idempotent no-op · optional backdate) | completed |
| `complete … [--completed-at]` | canceled | 1–2 (URL flip · optional backdate) | completed — the flip is the *stated intent* of the verb |
| `cancel … [--completed-at]` | open | 1–3 (cancel · then flip-dance if backdating) | canceled (backdated if asked) |
| `cancel … [--completed-at]` | completed | 1–2 (backdate while completed · flip) | canceled, stopDate as given |
| `cancel … [--completed-at]` | canceled | 0–3 (idempotent · flip-dance if backdating) | canceled |

Locked by regression tests (all certified app behavior, BACKDT B-FLIP/B-SWEEP): **every resolution-kind flip preserves `stopDate` on every surface**; re-resolving same-state is a true no-op (not even a umd bump); a preserved stopDate keeps sweep state. The "flip-dance" (flip→completed, AS backdate, flip back) is the only headless path to backdate a canceled item — 3 legs, disclosed.

**Project `add` caveat (B-PROJ-JSON / §5b):** a completed-project import requires every child spec resolved — one open child silently reverts the parent to open at creation. The engine refuses `add --completed-at` on a project whose child specs include open items, with copy naming the §5b law.

**Open-item hazard wall:** AS `set completion date` force-completes from ANY status (open items complete with children cascade-stamped at *now*; canceled items convert). The engine therefore only ever compiles the AS backdate leg against a pre-read, verified-**completed** row — the WG-7 guard generalizes from "refuse canceled" to "the AS leg fires exclusively on completed rows; every other path routes through the certified flip legs first."

## 3. The `update` quarantine line (maintainer's mapping question, answered)

The line already exists in the shipped surface; this plan makes it doctrine:

- **Quarantined out of `update` (dedicated verbs):** resolution status (`complete` / `cancel`, and reactivation), trash (`delete` / restore), container & heading placement (`move`, `--to-heading`). These are lifecycle/placement **state machines with side-effect semantics** (cascades, reopen laws, §5b).
- **Owned by `update` (attributes):** `--when` (including `today` / `evening` / `someday` — stage moves are attribute edits, not lifecycle boundaries), `--deadline`, `--reminder`, `--title`, `--notes`, tags. This matches the GUI, where When/Deadline live on the item card while completion is the checkbox and placement is drag.
- `--completed-at` slots consistently: `update` may *edit the timestamp attribute* of an already-resolved item (including the canceled 3-leg, which starts and ends in the same lifecycle state) but never *crosses* the open↔resolved boundary — that refusal points at the verb.

## 4. Guards, gating, disclosure

- AS-dependent legs require AppleScript onboarding (existing gate); `add` paths are json-only and stay ungated.
- Multi-leg paths are **sequences, not atomic**: disclosed in the result (leg list + warning on partial failure with exact recovery state) and fully visible in `--dry-run`. No new `--allow-*` flag — disclosure over consent here, since every leg is individually certified non-destructive and the sequence never crosses a lifecycle boundary the user didn't name. (If sign-off prefers a consent flag for the 3-leg flip-dance, it slots in trivially.)
- WG-7's interim refusal (canceled + completion-date) is **superseded** by the canceled 3-leg on `update`; the bespoke op it guarded is deleted.

## 5. Date-only values and timezones

- json **rejects** bare dates; AS date-literals stamp **midnight** — both vectors therefore receive full timestamps from the engine, and the engine normalizes date-only input to **noon in the effective zone** (B-DATEONLY; noon decodes to the intended calendar date in every zone, midnight can slip a day).
- **Effective zone** = the caller's declared zone (MCP `tz` argument / `THINGS_TZ` / embedding `zone` option — the same resolution chain reads already use), else the process-local zone (which *is* the app host's zone for local CLI use). Rationale: the caller named the calendar date, so the caller's zone is the best proxy for intent; Logbook day-grouping is viewer-local anyway (same derivation family as the log boundary), so no single stamp satisfies every viewer — noon-in-caller-zone maximizes the window.
- **New: `docs/reference/timezones.md`** — the consolidated timezone-sensitive-behavior reference the maintainer requested (§6).

## 6. Documentation workstream

- **timezones.md**: one section per behavior, each marked *certified* / *model-derived* / *unprobed*: the log boundary (viewer-local midnight under Daily; settings-flip stamp guard); Logbook day-grouping (viewer-local); date-only → noon convention (this plan); **`when=today`/`evening` writes are governed by the app host's clock** — a caller in a different zone cannot re-target its own local day, and `evening` has no cross-day form at all (model-derived; the write-side cross-midnight behavior is on the probe list); the **Tomorrow-list partial mitigation** — a caller *ahead* of the app host can reach app-tomorrow (= caller-today) via the certified `list "Tomorrow"` placement laws, but that day's *evening* remains unreachable until the app's own rollover (unprobed).
- **Probe list riding this workstream** (small, one clone): write-side `when=today`/`evening` across a simulated zone gap; the timezones doc upgrades entries from model-derived to certified as legs land.
- **Glossary**: add the "Completed on" canon note (universal Get Info label — completed, canceled, archived headings alike; 24h timestamps; maintainer screenshots 2026-08-05) to the `stopDate` entry.
- Capability matrix rows, CHANGELOG (Unreleased, breaking — bespoke ops deleted), skill sweep, MCP tool descriptions.

## 7. Universal `reorder` (vocabulary unification — maintainer-directed 2026-08-05)

One verb owns every reorder in the data model. `things reorder <refs…> [--start | --after <ref> | --before <ref>] [--in <token>]` accepts ANY single-kind set — to-dos, projects, **headings**, **areas** — and the engine dispatches the protocol by kind and axis (index wire, day-axis bounce family, heading-block wire, area-rank write), exactly as it already dispatches index vs day axes. Refusals, not fragmentation: mixed kinds in one call, cross-container targets, and cross-axis anchors each get a precise refusal naming the fix. Consequences:

- `things project move-heading` remains the **placement** verb (cross-project moves, demotion — it changes *where*, with children riding); pure same-project heading re-ranking becomes expressible through `things reorder` too, honoring #V11 (unguarded archived reorder with disclosed reopens).
- `things area reorder` (and any kind-specific spelling) survives as a **discriminating alias**: same engine path, but refuses when any target or anchor is not that kind.
- The anchor grammar (`--start` / `--after` / `--before`) is reconciled with the `--in` token family at build time; the doctrine's keys-are-tokens rule (read-shape v2 R2) supplies the vocabulary.

## 8. Sequencing

1. **PR A** — engine: op specs (`todo/project.set-dates` family or folded params on existing resolve ops), guards (§2/§4), flip-dance compiler, zone-aware date normalization, unit + guard tests, CLI flags + refusal copy, CHANGELOG.
2. **PR B** — MCP parity + skill sweep + capability matrix.
3. **PR C** — `timezones.md` + probe legs + glossary note.

Each independently green; A is the only breaking one. e2e smoke gains the idempotency + flip locks.
