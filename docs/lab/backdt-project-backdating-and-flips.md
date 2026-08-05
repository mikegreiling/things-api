# BACKDT — project backdating + resolution-flip stopDate semantics

**Probed under:** golden `things-lab-golden-v2` · Things **3.22.12** (build 32212016) · macOS 15.7.7 · DB schema v26 · guest clock pinned **2026-07-05 12:00** (guest TZ **UTC**, so `unixepoch` == `localtime`). Campaign **2026-08-05**, one disposable clone (`lab/artifacts/backdt-lab/`, gitignored — `report.txt` + `final.sqlite`), no crash (Things ALIVE throughout, no DiagnosticReports). Discovery — no assertions; **DB row deltas are ground truth**. Driver: [`lab/scripts/research-backdt.sh`](../../lab/scripts/research-backdt.sh) (subcommands `setup·projas·projasopen·projjson·dateonly·todoopen·loginterval·flip·flip2·dump`). Extends the scf2 **P4a–P4d** to-do backdating evidence ([s-campaign-results.md](s-campaign-results.md) round 2) to **PROJECTS**, and settles the **resolution-flip stopDate** laws the maintainer needs for the planned API redesign (folding `todo.backdate`/`todo.add-logged` into `--created-at`/`--completed-at` flags on add/update/complete/cancel for BOTH kinds).

## The questions

1. **Project backdating.** Do the to-do backdating laws carry to projects? Specifically: does AppleScript `set completion date` / `set creation date of project id X` work (the P4b analogue — the ONLY existing-item surface for to-dos)? Are exact values honored? Any **child** side-effects? Does `things:///json` at-creation backdating (the P4d analogue) work for projects — and where does a completed project land? What does `set completion date` on an **OPEN** project do (the H-BACKDATE-OPEN analogue)?
2. **Date-only convention.** When a value carries no time-of-day, what clock does the app stamp? (Needed to define the CLI's date-only convention.)
3. **Resolution-flip stopDate.** When a resolved item flips Completed↔Canceled — via URL, via AppleScript, per kind — is `stopDate` **preserved** (GUI ground truth: the maintainer confirmed, prod 2026-08-05, that toggling a swept resolved item preserves both `stopDate` and sweep state) or **restamped** to now? What about re-resolving an already-completed item (idempotency)?

## Bottom line

**Projects backdate exactly like to-dos, on the same two surfaces, byte-for-byte.** AppleScript `set completion date` / `set creation date of project id X` rewrites the project's `stopDate` / `creationDate` to any value, exact — the P4b law is kind-agnostic. It touches **ONLY the project row**: a backdate leaves every child's `stopDate`/`creationDate`/`userModificationDate` byte-identical (no cascade). `things:///json` at-creation backdating (`completed:true` + `completion-date` + `creation-date`) imports a completed project exactly (status 3 + swept ⇒ Logbook) — the P4d law, also kind-agnostic — **with one caveat**: any plain **open child** in the same payload trips the §5b open-child reopen at creation, landing the project OPEN (completion-date/stopDate dropped, creation-date survives), so a logbook-import project must ship ALL children resolved.

**`set completion date` is really "set-completed-at-this-instant" — it FORCES `status=completed` regardless of the prior status.** On an OPEN item it silently completes it (and, for a project, cascade-completes open children — but stamps the *children* at NOW, not the backdated date); on a CANCELED item it silently **re-completes** it (`status 2→3`), discarding the canceled status. This is the H-BACKDATE-OPEN rationale, now confirmed for projects AND widened: the guard lets *canceled* items through, but backdating one converts it to completed. `set creation date`, by contrast, is **status-safe** (never flips status, works on open/canceled/completed alike) and **`userModificationDate`-silent** (does not bump umd), while `set completion date` bumps umd.

**Every resolution-flip surface PRESERVES `stopDate` byte-identically — the headless surfaces match the GUI ground truth exactly.** URL `update?completed=true`/`canceled=true`, `update-project?completed=true`, and AppleScript `set status`, in BOTH directions and for BOTH kinds, flip the status and **keep `stopDate` unchanged** (umd bumped). Re-resolving an already-completed item (AppleScript OR URL) is a **true no-op** — status, `stopDate`, AND umd all byte-identical, no restamp, no error. **No flip surface restamps `stopDate`**, so a swept item stays swept across any flip (B-SWEEP is sweep-invariant); the only writes that move `stopDate` are the explicit backdate and the initial resolution.

**Date-only convention:** `things:///json` **rejects** a bare date (`"2025-01-15"`, no time) — the whole command fails, no row (same failure mode as the milliseconds rejection, [oddity 2h](../things-app-oddities.md#2h)); it requires a full second-precision `…Thh:mm:ssZ` timestamp. AppleScript `date "M/D/YYYY"` (no time) stamps **midnight 00:00:00 local**. The shipped engine's choice to normalize a bare date to **local noon** (`asDateBlock` 12h / `utcNoon`) is therefore the right call: it is TZ-proof (decodes to the intended calendar date in every zone) where midnight is not, and json has no bare-date form at all.

## Project ↔ to-do parallels (the headline table)

| Capability | To-do (prior, scf2) | Project (BACKDT) | Verdict |
|---|---|---|---|
| AS `set completion date of <kind> id X` (resolved) | ✅ P4b | ✅ **B-PROJ-AS.1** stop 2026-07-05 → 2025-12-17, exact | **identical** |
| AS `set creation date of <kind> id X` | ✅ P4b | ✅ **B-PROJ-AS.2** crt → 2025-05-31, exact | **identical** |
| AS date-literal `date "M/D/YYYY"` spelling | ✅ scf3 | ✅ **B-PROJ-AS.3** stop → 2025-01-15 00:00 | **identical** |
| Child byte-diff on a `<kind>` backdate | n/a | ✅ **B-PROJ-AS** children byte-identical (no cascade) | project-only, clean |
| AS `set completion date` on an OPEN item | (guarded H-BACKDATE-OPEN) | **B-PROJ-AS-OPEN / TODO-OPEN**: silently COMPLETES (0→3), stamps given date; project cascades to children (children stamped at NOW) | **identical law, both kinds** |
| AS `set completion date` on a CANCELED item | (untested before) | **flip2 SCD**: silently RE-COMPLETES (2→3), stamps given date | **identical law, both kinds** |
| `things:///json` at-creation `completed`+dates | ✅ P4d | ✅ **B-PROJ-JSON.1** status 3, stop/crt exact → Logbook | **identical** (caveat: open child reopens, §5b) |
| URL `update?completion-date=`/`creation-date=` | 🚫 P4c no-op ([oddity 2g](../things-app-oddities.md#2g)) | not re-probed (kind-agnostic no-op assumed) | dead |

## Evidence — project backdating

### B-PROJ-AS — AS backdating on a RESOLVED project (+ child byte-diff)

Project `BD-PAS` with two open children `C1,C2`, completed via AppleScript `set status … to completed` (children cascade-complete, H-PROJECT-COMPLETE-CHILDREN), then backdated:

| step | status | `stopDate` | `creationDate` | `umd` | children (`C1`/`C2`) |
|---|---|---|---|---|---|
| PRE (open) | 0 | NULL | 2026-07-05 12:00:37 | …837.266 | open |
| complete (AS) | 3 | 2026-07-05 12:00:42 | 2026-07-05 12:00:37 | …842.563 | cascade → status 3, stop 2026-07-05 12:00:42 |
| `set completion date` `(current date)−200d` | 3 | **2025-12-17 12:00:44** | 2026-07-05 12:00:37 | …844.609 (**bumped**) | **byte-identical** (stop 12:00:42, umd …842.563) |
| `set creation date` `−400d` | 3 | 2025-12-17 12:00:44 | **2025-05-31 12:00:46** | …844.609 (**NOT bumped**) | **byte-identical** |
| `set completion date` `date "1/15/2025"` | 3 | **2025-01-15 00:00:00** | 2025-05-31 12:00:46 | …848.666 (**bumped**) | **byte-identical** |

- Both `set completion date` and `set creation date` work on a project, **exact values** (arithmetic and date-literal spellings alike) — the P4b/scf3 laws are kind-agnostic.
- A project backdate is a **single-row write**: children `stopDate`/`creationDate`/`umd` are byte-identical throughout (no cascade side-effect).
- `set completion date` **bumps** `userModificationDate`; `set creation date` **does not** (umd-silent) — see the flip2/SCRT confirmation below.

### B-PROJ-AS-OPEN + TODO-OPEN — `set completion date` on an OPEN item (the H-BACKDATE-OPEN analogue)

| target | before | after `set completion date "1/15/2025"` | child effect |
|---|---|---|---|
| OPEN **project** `BD-POPEN` (+ open child `OC1`) | status 0, stop NULL | **status 3**, stop **2025-01-15 00:00:00** (the given date) | `OC1` cascade → status 3, stop **2026-07-05 12:01:06 (NOW)** — NOT the backdated date |
| OPEN **to-do** `BD-TODO-OPENCD` | status 0, stop NULL | **status 3**, stop **2025-01-15 00:00:00** | n/a |

`set completion date` on an open item **silently completes it**, stamping `stopDate` = the given (backdated) value directly — so it is a one-step "backdated completion", but with the side effect of completing an item the caller may not have meant to complete. For a project it additionally **cascade-completes open children**, and the children are stamped at the **current clock**, not the backdated date. Contrast `set creation date` on an open item: status **stays 0** (project `BD-POPEN` crt → 2024-06-01 00:00:00 with status unchanged; to-do `BD-TODO-OPENCRT` likewise). So only completion-date backdating carries the implicit-complete hazard; creation-date backdating is safe on open items.

### B-PROJ-JSON — at-creation project backdating via `things:///json`

| payload | project result | children |
|---|---|---|
| **.1** bare project `completed:true` + `completion-date:2025-01-15T09:00:00Z` + `creation-date:2024-06-01T08:00:00Z` | **status 3**, stop **2025-01-15 09:00:00**, crt **2024-06-01 08:00:00** — exact; swept (logInterval=0 ⇒ boundary=now) ⇒ **Logbook** | none |
| **.2** completed project + `JC1` (own `completed`+dates) + `JC2` (plain open) | **status 0** (OPEN), crt **2024-03-01 08:00:00** retained, **stop NULL** (completion-date DROPPED) | `JC1` status 3, stop **2025-01-20 09:00:00**, crt **2024-03-02 08:00:00** (exact); `JC2` open |

- **.1** — the P4d law is kind-agnostic: a completed project imports exactly and lands in the Logbook. The project logbook-import / GTD-migration path.
- **.2** — a completed project with a **plain open child** lands **OPEN**: the §5b open-child reopen fires **at creation** (`status 3→0`, completion-date + stopDate discarded), while the backdated `creationDate` survives. A resolved child carrying its own `completed`+dates imports faithfully. **To import a completed project via json, every child must be resolved in the same payload.**

## Evidence — date-only stamping (B-DATEONLY)

| input form | surface | result |
|---|---|---|
| `"2025-01-15"` (bare date, no time) | `things:///json` | **REJECTED** — row never created (whole command fails, same as [oddity 2h](../things-app-oddities.md#2h) milliseconds) |
| `date "1/15/2025"` (no time) | AppleScript `set completion date` | **midnight** 2025-01-15 00:00:00 local |
| `date "6/1/2024"` (no time) | AppleScript `set creation date` | **midnight** 2024-06-01 00:00:00 local |

json has **no** bare-date form; AppleScript's bare date literal is **midnight**. Neither is TZ-robust for a "this calendar date" intent. The shipped engine normalizes a date-only value to **local noon** (`asDateBlock` sets `time … to 12*hours`; `utcNoon` builds a local-noon instant) — the correct convention: noon decodes back to the intended date in every timezone, where midnight can slip a day.

## Evidence — resolution-flip stopDate semantics (B-FLIP / B-FLIP2)

**Sweep note.** Holding an item UNSWEPT needs `logInterval=4` (Manually), settable only in the GUI Settings popup via System Events synthetic clicks — which **did not land headless this sitting** (the Settings window never opened under either `⌘,` or a menu-item click; see AX residual below). So sweep state was not manufactured; instead the preserve-vs-restamp question is answered by the `stopDate` **value**: completed-origin fixtures were BACKDATED to `2025-03-01 00:00:00` (a post-flip `2025-03-01` = **preserved**, a jump to `2026-07-05` = **restamped**), and canceled-origin fixtures compared the **exact** `stopDate` float across a 3-second gap (a restamp would advance it by ~3 s). Under the golden default `logInterval=0` the Logbook boundary is `now`, so every resolved item is swept; **preservation is therefore sweep-invariant**, and a restamp-to-now is exactly what would un-sweep an item under a manual-log boundary — but no surface restamps.

| # | flip | surface | status | `stopDate` | `umd` |
|---|---|---|---|---|---|
| B-FLIP(a) | canceled → completed | URL `update?completed=true` | 2→3 | **PRESERVED** (exact cancel instant, byte-identical) | bumped |
| B-FLIP(b) | completed → canceled | URL `update?canceled=true` | 3→2 | **PRESERVED** (backdated 2025-03-01 kept) | bumped |
| B-FLIP(c) | completed → canceled | AS `set status` | 3→2 | **PRESERVED** | bumped |
| B-FLIP(c) | canceled → completed | AS `set status` | 2→3 | **PRESERVED** (exact) | bumped |
| B-FLIP(d) | completed → completed (re-complete) | AS `set status` | 3 (no change) | **PRESERVED** | **NOT bumped** (true no-op) |
| B-FLIP(d) | completed → completed (re-complete) | URL `update?completed=true` | 3 (no change) | **PRESERVED** | **NOT bumped** (true no-op) |
| project | completed → canceled | AS `set status` | 3→2 | **PRESERVED** (backdated 2025-03-01) | bumped |
| project | canceled → completed | URL `update-project?completed=true` | (already completed via SCD contamination — no-op) | preserved | — |

**Every flip preserves `stopDate`.** The headless URL and AppleScript surfaces match the GUI ground truth (toggling preserves `stopDate` + sweep state) exactly, for both to-dos and projects, in both directions. Re-resolving an already-completed item is a **true no-op** (no restamp, no umd bump, no error) — the idempotent case. Because no flip restamps, **B-SWEEP is trivially satisfied: a swept item stays swept across any flip** (its `stopDate` is untouched relative to any boundary), and there is no restamping flip surface for the "restamp un-sweeps" branch to apply to.

### The `set completion date` re-completes-a-canceled-item law (flip2 SCD/SCRT)

| target | before | after | note |
|---|---|---|---|
| canceled to-do `SCD`, `set completion date "3/1/2025"` | status **2**, stop 2026-07-05 12:11:57 | status **3**, stop **2025-03-01 00:00:00** | **re-completes** (2→3) AND stamps the given date; umd bumped |
| canceled to-do `SCRT`, `set creation date "6/1/2024"` | status **2**, crt 2026-07-05 12:12:00 | status **2** (UNCHANGED), crt **2024-06-01 00:00:00** | status-safe; **umd UNCHANGED** (creation-date write is umd-silent) |

This is why the completed-origin backdate fixtures could not be built from canceled items — `set completion date` flipped them to completed. It also exposes a **latent gap** for the redesign: the H-BACKDATE-OPEN guard admits *canceled* items (`status === "completed" || status === "canceled"` ⇒ allow), but backdating a canceled item silently converts it to completed, discarding the canceled status — and the op's `expectedDelta` asserts only `stoppedDate`, not that the status stayed canceled, so verification would not catch the flip. The redesigned completion-date backdate should either restrict to already-**completed** items or explicitly own the canceled→completed conversion. (Evidence-only campaign — no engine change here; flagged for the redesign.)

## AX residual (parked)

`logInterval=4` (Logbook = Manually) could not be set this sitting: the Settings window never opened under System Events, via `⌘,` **or** a two-step menu-bar → "Settings…" click (`click menu item "Settings…" of menu 1 of menu bar item 2` ran without error but no window appeared within 8 s; only the main `[]`/`[Today]` windows enumerated). The golden's AXVM1 L3-accessibility grant is baked and menu enumeration worked (`About Things … Settings… … Quit Things`), but the synthetic *click* did not open the panel — a headless-synthetic-events flake, not a schema/behavior change. The flip laws above did not need it (preserve-vs-restamp resolved by `stopDate` value); manufacturing an explicit UNSWEPT resolved item for a future sweep-boundary campaign remains a parked AX residual on golden-v2.

## What this settles for the API redesign

- `--completed-at` / `--created-at` on **project** add/complete/cancel/backdate are feasible on the same wires as to-dos (AS `set completion date`/`set creation date` for existing rows; `things:///json` for at-creation). Projects need no new discovery.
- A single `--completed-at` on `complete`/`cancel` cannot be a post-flip AppleScript `set completion date` if the target is **canceled** and must stay canceled — that surface re-completes it. Backdating a canceled item to keep it canceled has **no headless surface** (the only stopDate writer for a canceled item is `set completion date`, which flips it). Model completion-date backdating as completed-only, or accept the conversion explicitly.
- Resolution flips are `stopDate`-preserving on every surface, so a `complete`/`cancel` that merely re-labels a resolved item will not disturb its Logbook position — the redesign can flip status freely without a stopDate side effect.
- Date-only inputs normalize to **local noon** (engine's existing choice, vindicated); json bare dates must be rejected/expanded before dispatch (the app rejects them outright).
