# HEADARC — archived-heading MOVE semantics

**Probed under:** golden `things-lab-golden-v1` · Things **3.22.11** · macOS 15.7.7 · DB schema v26 · guest clock pinned **2026-07-05**. Campaign **2026-08-03**, one disposable clone (`lab/artifacts/things-run-headarc-20260803-011123/`, gitignored), no crash. Script: [`lab/scripts/research-headarc.sh`](../../lab/scripts/research-headarc.sh). Discovery run (no assertions); DB row deltas are ground truth.

> The golden is Things 3.22.11; the host app has drifted to 3.22.12. Per the [harness](harness.md) version-stamping policy this campaign was probed under — and is stamped with — the GOLDEN's 3.22.11, not the host build.

## The question

Maintainer GUI observation: **moving an OPEN to-do into an ARCHIVED (status=completed) heading RE-OPENS the heading.** Nobody had probed whether the *headless* write surfaces share that semantic — and our `resolveHeadingRef` has **no status filter** (`type = 2 AND trashed = 0 AND project = ?`, [src/read/queries.ts](../../src/read/queries.ts):801), so `todo move --to-heading` / `todo add --heading` will happily resolve an archived heading. If a headless move did NOT re-open the heading, it would file an open to-do under a section invisible in normal use — the [PLOG1](plog1-research.md) stranding hazard's heading cousin.

**Bottom line: the hazard does not materialize.** Every headless surface that lands an open child under a completed heading RE-OPENS the heading (byte-identical to the AppleScript unarchive op and, per the maintainer, to the GUI), heading-only (its swept children stay resolved). Because the heading reopens, the moved to-do is never stranded under an invisible section — the section becomes visible again. `resolveHeadingRef`'s missing status filter is therefore SAFE for the move/add path (no resolver guard is required).

## Fixtures

Five projects built in one `things:///json` call (the HX0 path — a new project with `items` produces real `type=2` heading rows, no Shortcuts): `HEADARC-PA/PB/P2/P3/P4`, each holding one heading (`HA/HB/H2/H3/H4`) with two children (`*-c1`, `*-c2`), plus one open unheaded movee (`MA/M2/M3a+M3b/M4`) added at the project root afterward. Each heading was then archived with the certified recipe — AppleScript `set status of to do id "<H>" to completed` ([heading-research](heading-research.md) P10d/P10b-b1) — which set the heading to `status=3` + `stopDate`, cascading both children to `status=3` + `stopDate` (the archive cascade, P10b-b1, re-confirmed here). All movees stayed `status=0`, unheaded, at the project root.

## ARM 1 — URL surface

### HEADARC-1a — `things:///update?id=<open todo>&list-id=<P>&heading=<archived-heading NAME>`

Move the open `MA` into the archived `HA` by heading NAME.

| row | field | BEFORE | AFTER |
|---|---|---|---|
| `HA` (heading) | status | 3 | **0** |
| `HA` | stopDate | 1783252848.9109 | **NULL** |
| `MA` (movee) | status | 0 | 0 |
| `MA` | project | `HEADARC-PA` | **NULL** |
| `MA` | heading | NULL | **`HA`** |
| `MA` | index | 0 | 0 |
| `HA-c1` | status / stopDate | 3 / 1783252848.91058 | 3 / 1783252848.91058 (**unchanged**) |
| `HA-c2` | status / stopDate | 3 / 1783252848.91069 | 3 / 1783252848.91069 (**unchanged**) |

**Verdict (HEADARC-1a):** the heading FK LANDS on `MA` (`heading=HA`, `project`→NULL — a headed row carries a NULL project). The archived heading RE-OPENS: `status 3→0`, `stopDate→NULL`. The two swept children stay completed (byte-identical `status`+`stopDate`) — the reopen is **heading-only**, exactly the un-archive law (P10b-b2). No stranding: `MA` lands under a now-visible heading.

### HEADARC-1b — `things:///add?...&heading=<archived-heading NAME>` (+ bad-name control)

Add `B-NEW` with `heading=HB` (archived) and, as a control, `B-CTRL` with `heading=HB-NONEXISTENT`.

| row | status | project | heading |
|---|---|---|---|
| `HB` (heading) | 3 → **0** (stopDate 1783252850.25184 → **NULL**) | `HEADARC-PB` | — |
| `B-NEW` | 0 | NULL | **`HB`** |
| `B-CTRL` | 0 | **`HEADARC-PB`** (root) | **none** |
| `HB-c1/c2` | 3 / 3 (**unchanged**) | — | `HB` |

**Verdict (HEADARC-1b):** `add?heading=<archived name>` name-MATCHES the archived heading — `B-NEW` is created headed under `HB`, and `HB` RE-OPENS (`3→0`, stopDate→NULL). So oddity **2c**'s "matches an *existing* heading" INCLUDES archived (completed) headings — an archived heading is not treated as missing. The bad-name control confirms 2c's drop path: `B-CTRL` (heading name with no match) is created **un-headed at the project root**, no reopen, no error.

## ARM 2 — AppleScript surface

### HEADARC-2i — is there an AS heading-PLACEMENT verb? (there is none)

| AppleScript | result |
|---|---|
| `get heading of to do id "<M2>"` | error **−1700** "Can't make heading of to do id … into type specifier" |
| `set heading of to do id "<M2>" to "H2"` | error **−1700** (no such property) |
| `move to do id "<M2>" to to do id "<H2>"` (heading as container) | error **301** "Cannot move to-do" |
| `set project of to do id "<M2>" to project id "<P2>"` | succeeds, but lands `M2` at the project ROOT — `heading` stays NULL |

**Verdict (HEADARC-2i):** AppleScript exposes **no heading-placement verb**. A to-do has no `heading` property (−1700); a heading is not a movable container (301); `set project` reaches only the project root, never a heading. This is why our planner compiles heading placement to **URL-scheme only** — `todo.move`'s compile emits `things:///update?id=<u>&list-id=<project>&heading=<TITLE>` and the AppleScript branch handles only project/area ([src/write/commands.ts](../../src/write/commands.ts):601–618). There is no "AppleScript move leg" for `--to-heading`; the ARM-1a URL path IS the move-triggered reopen, and there is no distinct AS-move reopen to compare against.

### HEADARC-2ii — un-archive-reopens-heading-only baseline (AS)

`set status of to do id "<H2>" to open` on the archived `H2`:

| row | status BEFORE | status AFTER | stopDate AFTER |
|---|---|---|---|
| `H2` (heading) | 3 | **0** | **NULL** |
| `H2-c1` | 3 | 3 (**unchanged**) | 1783252851.60191 (unchanged) |
| `H2-c2` | 3 | 3 (**unchanged**) | 1783252851.60183 (unchanged) |

**Verdict (HEADARC-2ii):** re-confirms the un-archive law ([heading-research](heading-research.md) P10b-b2) under 3.22.11 — the AS unarchive reopens the heading only (`3→0`, stopDate→NULL); children stay resolved byte-identical. This is the baseline the move-triggered reopen (ARM-1a/1b/3) is compared against in ARM 4.

## ARM 3 — our CLI (`things todo move`)

Guest production bundle (node + dist + commander), `allow-experimental` OFF (golden default). Ran `todo move <movee> --to-project HEADARC-P3 --to-heading <H3>` — the archived `H3` addressed BY NAME (`H3`) and BY UUID.

**`--dry-run --json` (both name and uuid, identical plan):**

```json
{"kind":"move-plan","data":{"movees":["…"],"membership":"1 membership leg(s)",
 "placement":"reorder scope=heading container=landed-heading → top of bucket (default)",
 "placementClass":"guaranteed","note":"membership + top-of-bucket placement"}}
```

**Real execution (by NAME then, re-archiving `H3` between, by UUID):**

- **Membership leg** — `kind:ok`, `observed:{heading.uuid:<H3>}`, `vector:"url-scheme"`, `tier:0`. The movee lands under `H3`, `project`→NULL. `H3` RE-OPENS (`status 3→0`, `stopDate→NULL`). Children `H3-c1/c2` stay completed.
- **Placement (reorder) leg** — `kind:blocked` (`H-REORDER-SCOPE`, "not an open member of this scope") → `placementClass:"app-default"`. The heading in-bucket reorder rides the private experimental surface, which is OFF on the golden, so placement falls back to app-default position. **Harmless** — the membership move (the load-bearing part) succeeded; only the fine-grained slot within the heading was left to the app default. Enabling `allow-experimental` would wire the placement leg.

**Verdict (HEADARC-3):** both BY-NAME and BY-UUID resolve the archived heading — `resolveHeadingRef`'s missing status filter is confirmed end-to-end through the real planner. The CLI's heading move rides the same url-scheme membership leg as ARM-1a, produces the same reopen (`3→0`, stopDate→NULL), children preserved. (Side note: re-archiving `H3` between the two arms cascade-completed `M3a` — the by-name movee now sitting under `H3` — expected archive-cascade behavior, not a move artifact.)

## ARM 4 — reopen byte-equivalence, the odd state, and GUI rendering

### HEADARC-4-eq — is the move-triggered reopen the SAME write as the unarchive op?

| heading | reopened by | status AFTER | stopDate AFTER |
|---|---|---|---|
| `HA` | ARM-1a URL move | 0 | NULL |
| `H2` | ARM-2ii AS `set status … open` | 0 | NULL |

**Verdict (HEADARC-4-eq):** the reopen byte delta is **identical** across surfaces — `status 3→0` + `stopDate→NULL` on the heading row, nothing else. The URL-move-triggered reopen, the AppleScript unarchive op (`project.unarchive-heading` = `set status … to open`), and — per the maintainer's oracle — the GUI's reopen all converge on the same single-row write. The GUI's "re-open" IS our unarchive write.

### HEADARC-4-odd — can an archived heading hold an OPEN child? (no — the app self-heals)

Attempt to manufacture the odd state directly: `things:///update?id=<H4-c1>&completed=false` — reopen ONE completed child of the archived `H4`, without touching the heading.

| row | status BEFORE | status AFTER | heading |
|---|---|---|---|
| `H4` (heading) | 3 | **0** | — |
| `H4-c1` (child) | 3 | **0** | `H4` (still headed) |

**Verdict (HEADARC-4-odd):** reopening a completed CHILD of a completed heading **also reopens the heading** (`H4` 3→0). The app maintains the invariant that a completed heading cannot own an open child: any write that would produce one reopens the heading. So the odd state (archived heading + open child) is **not reachable** by any of the headless surfaces probed here (move-in, add-in, or reopen-in-place) — each self-heals by reopening the heading. This is the §5b family generalized from projects to headings.

### GUI rendering oracle (VNC screenshots, `lab/artifacts/…/*.png`, not committed)

Screenshots (framebuffer 2048×1536) taken after the probes. Note every fixture heading had been reopened by a probe, so no *archived* heading remained on screen — the captures document the reopened-heading and swept-children rendering:

- **`41-PA-reopened-heading.png`** — `HEADARC-PA` project view: the reopened `HA` renders as an ordinary active (blue) heading section header with a hover `⋯` affordance; the moved `MA` sits directly beneath it as an open (unchecked) row. The two swept children are NOT shown under the heading — they collapse into a project-level **"Show 2 logged items"** toggle at the bottom of the project.
- **`40-P4-archived-heading-open-child.png`** — `HEADARC-P4`: `M4` (open, root), then the reopened `H4` heading with its reopened child `H4-c1` beneath it, and a **"Show 1 logged item"** toggle (the still-completed `H4-c2`). Confirms an open headed child renders inside its heading's active group; completed siblings sit in the project-level logged toggle.
- **`42-P2-logged-section.png`** — `HEADARC-P2`: `M2` (root), reopened `H2` heading with no live children under it, and **"Show 2 logged items"** (`H2-c1`, `H2-c2`). Swept children do NOT render nested under their heading — they are pulled out to the flat, project-level logged toggle.
- **`43-logbook.png`** — the global **Logbook** lists every completed child (`HA-c1/c2`, `HB-c1/c2`, `H2-c1/c2`, `H3-c1/c2`, `H4-c2`, `M3a`) each stamped `today` with the parent **PROJECT** as its sublabel (`HEADARC-PA`, `-PB`, `-P2`, `-P3`, `-P4`) — **never** the heading. Confirms: the Logbook labels the parent project, never the heading. (The heading rows themselves are absent from the Logbook — all were reopened.)

**Rendering-fidelity spec (for a follow-up rendering PR):** in the project view, an OPEN heading is an active section header with its open children beneath; **swept (completed) headed children collapse into a single project-level "Show N logged items" toggle**, not a per-heading logged group. The Logbook attributes each logged item to its PROJECT, never its heading. **Not captured (follow-up):** how an *archived heading itself* (a `type=2`, `status=3` row) renders inside the "Show N logged items" toggle — every fixture heading here was reopened by the move probes, so an archived heading in the logged section was never on screen. A dedicated capture needs a heading left archived (no reopening write) with completed children.

## Standing open item — closed

[heading-research](heading-research.md)'s tail asked: *"whether the UI renders an archived heading's still-open children anywhere odd."* **Closed (HEADARC-4-odd):** the state does not arise via the headless surfaces — the app reopens the heading the moment any child would be open under it, so there are no "still-open children" of an archived heading to render oddly. Residual (follow-up, not probed): a PLOG1-style trash-restore (Put Back a trashed child of an archived heading) might reproduce the odd state for a heading the way it does for a project (oddities §6¾) — the restore path was out of scope here.

## Per-arm verdict summary

| Probe | Surface | Verdict |
|---|---|---|
| HEADARC-1a | URL `update?…&heading=<archived name>` | heading FK lands; heading RE-OPENS (`3→0`, stopDate→NULL); children stay resolved |
| HEADARC-1b | URL `add?…&heading=<archived name>` | name-matches archived heading (extends oddity 2c); RE-OPENS; bad-name control drops un-headed at root |
| HEADARC-2i | AppleScript heading placement | **no verb** — −1700 (no `heading` property) / 301 (heading not a container); `set project` reaches root only |
| HEADARC-2ii | AppleScript `set status … open` | un-archive reopens heading-only (P10b-b2 re-confirmed, 3.22.11) |
| HEADARC-3 | our CLI `todo move --to-heading` (name + uuid) | both resolve archived heading; url-scheme membership leg RE-OPENS; placement leg app-default (experimental off) |
| HEADARC-4-eq | reopen byte-equivalence | URL-move reopen == AS unarchive == (per maintainer) GUI: single-row `status 3→0` + `stopDate→NULL` |
| HEADARC-4-odd | reopen a child of an archived heading | reopens the heading too — the odd (archived heading + open child) state is not headlessly reachable |
