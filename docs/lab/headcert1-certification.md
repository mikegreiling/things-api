# HEADCERT1 — `heading.convert-to-project` certified (the LAST uncertified ui op)

**Verdict (2026-07-17): LAB-CERTIFIED against Things 3.22.11 / macOS 15.7.7 / DB v26.** The one remaining uncertified ui-vector op is now `lab-certified` in `src/write/vectors/ui-certification.ts` (evidence `["UI2-d","UIC1-a","HEADCERT1"]`), the blocker removed — **every ui op is now lab-certified**. Driven end-to-end through the **production CLI** (guest e2e bundle, `ui.enabled` + `--dangerously-drive-gui`), DB-verified, against Things 3.22.11.

Ran in ONE disposable `--vnc-experimental` clone of `things-lab-golden-v1` (airgapped, clock-pinned 2026-07-05, SIP on), Accessibility granted via the AXVM1 rung-b VNC toggle; everything else over SSH. Ground truth = guest Things-DB row deltas (read-only SQLite) + the production CLI's `--json` envelope. Companions: [uic1-certification.md](uic1-certification.md) (the original blocker), [uic5-build-certification.md](uic5-build-certification.md) (the row `select`-action primitive this reuses), [native1-spike.md](native1-spike.md) (the HID-click alternative, not needed), [axvm1-accessibility.md](axvm1-accessibility.md) (the grant).

## The blocker, and why the post-UIC1 primitives cracked it

UIC1 (2026-07-14) failed `heading.convert-to-project` because `things:///show?id=<heading>` **does not select a heading** — the reveal URL selects to-dos only, so the selection went empty, the window fell back to "Today", and `Items ▸ Convert to Project…` stayed **disabled** → the drive no-oped. Two primitives arrived *after* that verdict and were never tried on heading rows:

- **UIC5 `select-row` action** — walk the content table, issue the row `select` action (pure System Events, background-capable).
- **NATIVE1 HID click** — resolve the row's AX frame, synthesize a `CGEventPost(kCGHIDEventTap)` click at its center.

UI2-d had already proved the heading→project **transform** works once a heading is *selected* (via a VNC coordinate click): the heading uuid dies, a new type=1 project is promoted into the parent project's **area**, children reparent (`project`:=new, `heading`:=NULL). So the only open question was **selection**.

## AX-tree findings (HEADCERT1-a)

Revealing the heading's **parent project** (`things:///show?id=<project>`) shows the project view, whose content `table 1 of scroll area 1 of <AXStandardWindow>` renders each heading as a ROW. Dumping it (JXA ObjC bridge):

- Heading rows carry **no AXStaticText, no AXDescription, no AX actions** (`statics=[]`, `acts=[]`) — the same non-addressability UIC1/NATIVE1 found for main-list rows. Their frames ARE resolvable.
- The heading **title** is exposed only via a HOVER-dependent "More" affordance (`AXUnknown` desc `"More. <title>"` / `"‎<title>"` with a leading U+200E LTR mark, plus `AXImage` desc `"Heading More Template"`), reachable only through `entire contents` **after** the row is selected — and it did not render reliably headless (mouse-hover-dependent). **Not a usable identity handle.**

## Selection paths tried (HEADCERT1-b)

| Path | Result |
|---|---|
| **(a) row `select` action** (UIC5) | **WORKS.** `select (row i of theTable)` **does engage a heading row** — unlike `things:///show`, the heading takes selection: `selected of (row i)` → true AND `name of selected to dos` → **empty** (a heading is not a to-do). With the heading so selected, `Items ▸ Convert to Project…` is **enabled** and the convert drives. This is the path shipped (pure System Events, background-capable, no focus steal). |
| **(b) HID click** (NATIVE1) | Not needed. Frame-resolved HID clicks landed on the rows, but path (a) is cleaner (no foreground requirement). Kept in reserve. |
| **menu-`enabled` read gotcha** | A menu item's `enabled` attribute read *without opening the menu* is **stale** (macOS revalidates only on menu open) — every background `enabled=false` read was a false negative. The drive presses Convert via System Events (which opens the Items menu, triggering revalidation), so this never bites the recipe; it only confused early probes. |

**Identity = POSITIONAL.** Because heading rows expose no stable AX title, the target heading is addressed by **ordinal**: the driver walks the content table and counts rows that take selection (`AXSelected` true) AND read back an empty `selected to dos` — those are the headings, in top-to-bottom = DB `index` order. The Nth such row (0-based `ordinal`, computed in pre-state from the project's non-trashed headings ordered by `"index"`) is left selected. Two same-titled headings are therefore unambiguous.

## What shipped

- `classifyHeadingConvert` ([src/write/pre-state.ts](../../src/write/pre-state.ts)) — reads DB truth, returns `{ projectReveal, ordinal }` (or refuses not-a-heading / no-project / not-found).
- `headingConvertToProjectRecipe` ([src/write/vectors/ui-recipes.ts](../../src/write/vectors/ui-recipes.ts)) — reveal the parent project → `select-heading-row` by ordinal → `Items ▸ Convert to Project…` → confirm sheet (`action-button-1`).
- `select-heading-row` driver primitive ([src/write/vectors/ui.ts](../../src/write/vectors/ui.ts) `axSelectHeadingRowScript`) — the ordinal walk with the empty-readback heading discriminator; returns `OK` / `NOMATCH`, fail-closed.
- `heading.convert-to-project` compile ([src/write/commands.ts](../../src/write/commands.ts)) now builds the new recipe from the taxonomy; manifest flipped to `lab-certified`.

## Certification through the production CLI (HEADCERT1-c)

Seeded a fresh 2-heading project via the `things:///json` vector (HX0): `HCERT2` in `LAB-AREA-A` with headings `Hx1` (index −563, **ordinal 0**) and `Hx2` (index 0, **ordinal 1**), each with one child. Every case ran `things heading convert-to-project <ref> --dangerously-drive-gui` through the guest e2e bundle; ground truth = guest DB diff. (The golden's own seed `LAB-PROJ-HEADINGS`/Alpha/Beta were consumed during discovery, so the CLI cert used json-seeded subjects.)

| Case | Command | Verdict | DB evidence |
|---|---|---|---|
| **HEADCERT1-c1** ordinal 1 | `heading convert-to-project Hx2 …` | **PASS** | `ok=true`, new project `DLVTfqJYLSHEDZYGTs7684` returned; `Hx2` uuid gone; **`Hx1` UNTOUCHED** (positional identity correct — ordinal 1 counted past the first heading); new project in `LAB-AREA-A`; child `x2c` reparented (`project`:=new, `heading`:=NULL); `x1c` untouched under `Hx1` |
| **HEADCERT1-c2** ordinal 0 | `heading convert-to-project Hx1 …` | **PASS** | new project `Urgw8kP6izvTmx1obQwJpq` in `LAB-AREA-A`; `Hx1` gone; child `x1c` reparented (`heading`:=NULL) |
| **HEADCERT1-c3** gating | `heading convert-to-project <h>` (no ack) | **PASS** | **blocked** `H-UI-DRIVE`, exit **4**, no mutation |
| **HEADCERT1-c4** gating | `… --dangerously-drive-gui` with `ui-enabled false` | **PASS** | **unsupported**, exit **6**, no mutation |

The DB deltas match the UI2-d convert evidence exactly (identity replacement; area-promote; children reparent `heading→NULL`). Both certified conversions also carried the expected result-envelope warnings (GUI-driven + lab-certified-not-on-device) and passed the pipeline's read-after-write verify.

## Harness note (cost several false silent-noops)

An early `scp -r dist remote:.../dist` where the remote `dist` already existed created a **nested `dist/dist`**, so the guest kept running the OLD (pre-wiring) recipe — every "cert failure" was the original reveal-heading blocker, not the new code. Fixed by `rm -rf` the remote `dist` before each re-ship. A single-invocation reproduction of the exact recipe steps had converted cleanly throughout, which is what flagged the ship (not the wiring) as the fault.
