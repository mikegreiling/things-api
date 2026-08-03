# HEADARC2 — archived-heading residual captures (rendering + trash-restore)

**Probed under:** golden `things-lab-golden-v1` · Things **3.22.11** · macOS 15.7.7 · DB schema v26 · guest clock pinned **2026-07-05**. Campaign **2026-08-03**, one disposable clone (`lab/artifacts/things-run-headarc2-20260803-013316/`, gitignored — screenshots `A-*/B-*/C-*.png` + `final.sqlite` + `report.txt`), no crash. DB row deltas are ground truth; the GUI captures were read off the VNC framebuffer (2048×1536).

Sibling to [HEADARC](headarc-archived-heading-moves.md) (the archived-heading MOVE campaign, #370) — that doc is an immutable snapshot and is **not** edited here. HEADARC closed the move/add/reopen surfaces but left three residuals explicitly flagged ("Not captured (follow-up)" + the standing open item). This campaign closes all three and wires the WG-6 recurring lock.

## The three residuals (all closed)

1. **A — how an *archived heading itself* renders inside the "Show N logged items" toggle.** HEADARC never had an archived heading on screen (every fixture heading was reopened by a move probe), so this was uncaptured.
2. **B — the muted sublabel on a pre-archive-swept child row** (heading still OPEN): heading name, project name, or none? And how the same row re-renders once its heading is archived.
3. **C — a PLOG1-style trash-restore (Put Back) of a child of an archived heading** (heading-research standing item): does it reopen the heading (self-heal) or reproduce the completed-heading-owns-open-child odd state that HEADARC-4-odd proved unreachable via the *update* surface?

## Fixtures

Three projects built in one `things:///json` call (the HX0 path — real `type=2` heading rows), each in `LAB-AREA-A`: `HEADARC2-A2P/B2P/C2P` with headings `A2H/B2H/C2H`. Movees/children added afterward. Per-arm build differs (below). Contaminants from the §5n isolation probes (`ISO-*`) were trashed before the arm-A/B captures.

---

## ARM A (HEADARC2-A) — an archived heading renders as a GROUPED logged section

Build: `A2H` + two children `A2H-c1/c2`; **complete the children** (URL `update?completed=true`), **then archive the heading** (certified AS `set status … to completed`, [heading-research](heading-research.md) P10d/P10b-b1). Final DB state (all headed, none touched again):

| row | type | status | stopDate | heading |
|---|---|---|---|---|
| `A2H` | 2 | 3 | 1783252839.10079 | — |
| `A2H-c1` | 0 | 3 | 1783252834.45564 | `A2H` |
| `A2H-c2` | 0 | 3 | 1783252836.74524 | `A2H` |

**Logged HIDDEN (default project view, `A-02-hidden-clean.png`):** the project body is **empty except a single "Show 3 logged items" toggle** — the archived heading does **not** appear anywhere in the visible view. An all-swept archived heading is entirely absent from the default project view (heading + its 2 children = the 3 logged items).

**Logged SHOWN (`A-03-shown.png`):** the archived heading **`A2H` renders as a grouped section header** — bold title, a hover `⋯` affordance on the right, and a divider rule — **identical styling to an active heading section header**, but living *inside* the expanded logged region (below the "Hide logged items" button). Its two swept children nest **under it**: `☑ today  A2H-c2` / `☑ today  A2H-c1` (checked, completion-date sublabel `today`, most-recent first). No per-child heading sublabel — the grouping header supplies the heading context.

**Verdict (HEADARC2-A):** an archived heading with all-swept children is invisible in the default view and, when logged items are expanded, renders as a **grouped section** (heading header + nested swept children) — **confirming the maintainer's iOS recollection on macOS**. This is the piece HEADARC could not capture. Contrast HEADARC's finding for a *reopened/active* heading (§below): there the swept children are pulled OUT to the flat project-level logged toggle and are NOT grouped under the heading. **Grouping-under-the-heading in the logged section happens iff the heading itself is archived (a logged item).**

---

## ARM B (HEADARC2-B) — the swept-child sublabel is the HEADING (while the heading is open)

Build: `B2H` (kept OPEN) + one child `B2H-c1`, child completed (URL). State: `B2H` status 0 (open); `B2H-c1` status 3, headed, swept.

**Heading OPEN, logged shown (`B-02-shown-open.png`):** `B2H` renders as an ordinary **active (blue) section header** with **no open children under it** (empty section). Its swept child sits in the **flat project-level logged toggle** ("Hide logged item"), rendered as `☑ today  B2H-c1` **with a muted "B2H" sublabel beneath the title** — i.e. the child row carries a **muted HEADING sublabel** (the heading name).

**Then archive `B2H`** (AS `set status … completed`; `B2H` → status 3, stopDate 1783253364.13423; `B2H-c1` unchanged status 3 stopDate 1783252841.97808, still headed) and re-render:

**Heading ARCHIVED, logged shown (`B-04-shown-archived.png`):** the blue active header is **gone** from the visible view (`B-03-after-archive-hidden.png` shows the default view collapses to "Show 2 logged items"). Expanded, `B2H` now renders as the **grouped section header** (as in arm A) and `B2H-c1` nests under it as `☑ today  B2H-c1` **with NO sublabel** — the heading grouping replaces the sublabel.

**Verdict (HEADARC2-B):** the in-project logged toggle labels a swept headed child with a **muted heading sublabel** — **while the heading is OPEN** (child in the flat toggle). Once the heading is archived, the child regroups under the heading section header and the sublabel disappears. Confirms the maintainer's iOS recollection on macOS. **Note the two-view asymmetry:** the *in-project* logged toggle labels the HEADING; the *global Logbook* labels the PROJECT ([HEADARC](headarc-archived-heading-moves.md) `43-logbook.png`) — same row, different sublabel by view. **No iOS/macOS rendering delta was observed** — macOS matches the maintainer's iOS-observed structure on both arm A and arm B.

---

## ARM C (HEADARC2-C) — trash-restore (Put Back) STRANDS an open child under an archived heading (§6¾ for headings)

The completed-child delete path had to be worked around first: AS `delete to do id <completed child>` fails **−1728** (oddities §5n; re-confirmed here as completion-general — see below). So the state was built the **PLOG1-faithful** way — trash the child while it is still OPEN, then archive the heading (the archive cascade skips the trashed child, exactly as the completion modal ignores trashed children, §6¾):

`HEADARC2-CCP` / heading `CCH` + children `CCH-c1/c2`. Trash `CCH-c1` while OPEN (AS delete, works on an open row) → `CCH-c1` `trashed 0→1`, **status stays 0 (open), heading FK survives** (`CCH`). Then archive `CCH` (AS set status completed):

| row | status | stopDate | trashed | heading |
|---|---|---|---|---|
| `CCH` (heading) | 3 | 1783252939.17275 | 0 | — |
| `CCH-c1` | **0 (open)** | — | **1 (trashed)** | `CCH` (survives) |
| `CCH-c2` | 3 (cascade) | 1783252939.17259 | 0 | `CCH` |

So: **an archived heading owns a trashed, still-OPEN, still-headed child.** (`CCH-c1`'s Trash row is sublabelled with the PROJECT `HEADARC2-CCP`, not the heading — `C-01-trash.png`.)

### HEADARC2-C-putback — GUI Put Back (VNC right-click → Put Back, `C-02-rightclick-menu.png`)

| row | field | BEFORE | AFTER Put Back |
|---|---|---|---|
| `CCH` (heading) | status | 3 | **3 (unchanged)** |
| `CCH` | stopDate | 1783252939.17275 | **1783252939.17275 (unchanged)** |
| `CCH-c1` | trashed | 1 | **0 (restored)** |
| `CCH-c1` | status | 0 | **0 (open)** |
| `CCH-c1` | heading | `CCH` | **`CCH` (restored in place, still headed)** |

**Verdict (HEADARC2-C-putback):** Put Back restores the trashed child **in place under the archived heading** and **does NOT reopen the heading** (`CCH` stays `status=3`, stopDate byte-identical). This **reproduces the completed-heading-owns-open-child odd state** that HEADARC-4-odd proved unreachable via `update?completed=false` (which self-heals by reopening). Put Back is the **heading analog of §6¾** (the project trash-restore bug): unlike every *headless* add/move/reopen (§5b / §5o / HEADARC), Put Back does not reopen the container.

**Rendering of the odd state (`C-03/C-04`):** the open child is a **black hole**. Default view shows only "Show 2 logged items" — `CCH-c1` (open, actionable) is **not** in the visible project area. Expanded, `CCH` renders as the grouped logged section header with `CCH-c1` beneath it as an **open (unchecked) row** — reachable only by expanding logged items. AppleScript list membership confirms `CCH-c1` is absent from **Today / Anytime / Inbox / Someday / Upcoming** and is not a Logbook member (it is `status=0`). An open, actionable to-do is invisible to every normal workflow view because its parent heading is archived.

### HEADARC2-C-restore — our `todo.restore` leg CANNOT create the odd state (safe)

Our `todo.restore` compiles to AS `move to do id … to list "Inbox"` ([src/write/commands.ts](../../src/write/commands.ts):920–943, E15) — an un-trap-to-Inbox, not an in-place restore. Probed directly on a completed headed child (`CCH-c2`, status 3): it **succeeds** (a completed to-do IS AppleScript-addressable for `move`/`get name`, only `delete` is refused — §5n) and lands `CCH-c2` in the **Inbox** — `status 3→0` (reopened), `trashed 0`, **heading FK → NULL, project → NULL** (severed) — while **`CCH` stays archived** (status 3, stopDate unchanged). Because the child leaves the heading entirely, no open child ever sits under the archived heading via our surface.

**Verdict (HEADARC2-C-restore):** the odd state is reachable **only via GUI Put Back**; our shipped un-trash op (Put-Back-to-Inbox) severs the child to the Inbox and never reopens — nor strands under — the source heading. This is the heading twin of the PLOG1 guard note in §6¾ ("we cannot CREATE this state — our only to-do un-trash op is the scriptable Put-Back-to-Inbox").

**Read-side follow-up (flagged, not fixed here):** §6¾ made `project show` emit an `openChildrenWhileResolved` advisory for a completed/logged *project* holding open children. The archived-*heading* analog (an open child buried under an archived heading) is **not** currently surfaced by the reader — worth a follow-up to decide whether `project show` should count open children living under an archived heading the same way. No code change in this probes-only PR.

---

## §5n re-confirmation (delete −1728 is completion-general, not heading-specific)

The completed-child delete failure that reshaped arm C was isolated across three shapes (`report.txt` ARM C.0c): AS `delete to do id <X>` errors **−1728** on a completed **loose** to-do, a completed child of an **open** heading, AND a completed child of an **archived** heading — while the **open-loose control deletes fine**. `get name` and `move … to "Inbox"` succeed on the same completed rows. This strengthens oddities **§5n** (SIT5 saw one completed-loose case): the `delete`-verb refusal is keyed on **completion (status=3)**, independent of heading membership. Automation impact unchanged from §5n (our `todo.delete` = `delete to do id` is OPEN-only; a completed row must be trashed via `move … to list "Trash"`).

---

## WG-6 recurring lock (wired + certified)

The [assumption-register](../reference/assumption-register.md) WG-6 row (archived-heading reopen — no stranding on `--heading`) carried a **pending** lock after HEADARC. This campaign wires it as **u-suite U21** (`heading.reopen-via-moved-child`): self-seeds a project + heading + child via `things:///json`, adds an open movee, archives the heading (osascript), then dispatches `things:///update?id=<movee>&list-id=<P>&heading=<H>` and asserts `heading status=0` + `stopDate` NULL + movee `heading` FK + child `status=3` (children stay resolved). **Certified GREEN** against `things-lab-golden-v1` (Things 3.22.11) — targeted run `wg6-20260803-065423`, `U21 supported / tier 0 / crash false / ok`, schema fingerprint verified. It now rides `npm run lab:regress` as the recurring lock.

---

## Per-arm verdict summary

| Arm | Question | Verdict |
|---|---|---|
| HEADARC2-A | how an archived heading + swept children render | invisible in default view; under "Show N logged items" a **grouped section** (heading header + nested swept children); confirms iOS recollection |
| HEADARC2-B | swept-child sublabel while heading is open | **muted HEADING sublabel** in the flat project logged toggle; once the heading is archived the child regroups under the heading header (no sublabel); in-project toggle labels HEADING vs global Logbook labels PROJECT |
| HEADARC2-C-putback | trash-restore of a child of an archived heading | GUI Put Back restores in place, **does NOT reopen** the heading → reproduces the completed-heading-owns-open-child **odd state** (§6¾ for headings); the open child is invisible to every actionable view |
| HEADARC2-C-restore | our `todo.restore` on such a child | severs to Inbox (reopens child, heading FK→NULL), heading stays archived — **cannot create the odd state** (safe) |
| §5n | delete −1728 scope | completion-general (loose / open-heading / archived-heading), not heading-specific |
| WG-6 | recurring lock | u-suite **U21**, certified GREEN (3.22.11) |
