# SBCOL1 — the sidebar disclosure chevron: folding the AXDRAG5 wall out of the way

**Probed under: `things-lab-golden-v4` · Things 3.23 (build 32300036) · DB v27 · macOS 15.7.7 · guest clock pinned 2026-07-05 (never rolled — the trial wall is 2026-07-18).** One disposable clone (`sbcol1-lab`), destroyed at the end. All fixtures synthetic. Driver: [`lab/scripts/research-sbcol1.sh`](../../lab/scripts/research-sbcol1.sh):

```sh
TART_HOME=/Volumes/Workspace/tart bash lab/scripts/research-sbcol1.sh setup   # clone + boot + airgap + clock pin + shipped bundle
                                                           … seed      # the two-wall sidebar
                                                           … axdump    # the area row's AX descendants, ± a pointer hover
                                                           … chevron   # actuate the toggle; census both directions, twice
                                                           … where     # where the collapse state lives
                                                           … persist   # does it survive a relaunch?
                                                           … assisted  # manual collapse → SHIPPED drag → restore
                                                           … multi     # the same across TWO walls
                                                           … auto      # the same move with NO manual collapse
                                                           … abort     # restore-on-failure: kill the app mid-fold
                                                           … toggle    # fixture hygiene (the collapse is persistent)
                                                           … reship / teardown
```

**Why.** [AXDRAG5](axdrag5-field-stall.md) proved the tall-section **wall**: an area's sidebar section is its row plus every project row Things renders under it, and both shipped drag rungs need the grab point and the drop boundary visible AT ONCE, so a section taller than one drag's usable span can never be crossed. #659 shipped an honest pre-flight refusal that told the *user* to collapse the blocking area. This campaign asks whether the *driver* can do it — and put the sidebar back.

---

## The answers, in one table

| Cell | Question | Verdict |
|---|---|---|
| **axdump** | what is the chevron, really? | **Two nodes, and AXDRAG2-b measured the wrong one.** An inert `AXImage d="Source Toggle Template"` (18×18) sits inside an `AXUnknown` wrapper (16×16) that DOES advertise `AXPress`. Identical with and without a pointer hover — **not hover-drawn**. |
| **chevron** | can it be actuated? | **YES — by a frame-targeted CGEvent click.** `AXPress` on the wrapper that advertises it returns `AXError = 0` and changes **nothing** (REPX1 §1.2 holds). A click at the image's own resolved frame toggled a 22-row section to 2 and back, **both directions, twice**, deterministically. **Zero beeps, zero focus steal, no new window.** |
| **chevron (alternatives)** | is there a cheaper gesture? | **NO.** A single click and a double-click on the row BODY both leave the census byte-identical (they navigate, they do not fold). |
| **where** | where does the collapse state live? | **`collapsedAreaUUIDs`** — an array of area uuids in the group-container prefs plist. **The database is byte-identical across the toggle** (every table, rows + digest): the gesture is **umd-silent**, so it is not a sync event. The app's own `com.culturedcode.ThingsMac` prefs domain is untouched too. |
| **persist** | does it survive a relaunch? | **YES.** So restoring it is not politeness — an unrestored fold is a **durable change to the user's sidebar**. |
| **assisted** | does a manual collapse make the wall crossable? | **YES.** The AXDRAG5 wall move — refused in 10 s by the shipped driver — landed in **29 s**, placement reached, count + assignments invariant, sidebar restored. |
| **multi** | two walls on one span? | **YES.** A ten-position move across two oversized sections landed in **32 s**; both folded, both restored, census identical. |
| **auto** | can the DRIVER do it unaided? | **YES.** Same wall, no manual step: the collapse rung folds, crosses, and unfolds — **86 s** (one wall) / **154 s** (two walls). |
| **abort** | what happens when the drive dies mid-fold? | **It says so.** Killing Things after the fold landed exposed **two real holes** in the first cut of the rung (§6); both are fixed, and the failure detail now names the area it could not re-expand. |

---

## The fixture (synthetic)

Fourteen seeded areas plus the golden's two, 57 projects, **two** oversized sections. Window **935×420**, sidebar viewport **240×346 @ y 63** (usable single-drag span **322 pt**).

| area | project rows | note |
|---|---|---|
| **Eta** | **24** | **WALL** — 26 rows / 616 pt |
| **Sigma** | **20** | **WALL** — 22 rows / 520 pt |
| Zeta 4 · Lambda 3 · Epsilon 3 · Alpha 2 · Mu 1 | | ordinary sections |
| Delta, Theta, Iota, Kappa, Tau, Beta, Gamma | 0 | empty |

All sixteen areas landed at `index = 0` — the AXDRAG1 unmaterialized state, with the rendered order matching `(index, uuid)` ASC (AXDRAG3 reconfirmed a third time, now at a 16-way tie).

## §1 — axdump: the chevron is two nodes, and the actionable one is a decoy

Every area row exposes the same subtree (`Sigma`, row frame `(44,536 240×24)`):

```
(row)     AXRow/AXTableRow                                    actions=(none)
/0        AXCell                                              actions=(none)
/0/0      AXUnknown   d=Sigma.        (44,536 240x24)         actions=AXIncrement,AXDecrement,AXCancel,AXPress
/0/0/3    AXImage                     (62,538 20x20)          actions=(none)
/0/0/4    AXUnknown                   (250,540 16x16)         actions=AXIncrement,AXDecrement,AXCancel,AXPress   ← the wrapper
/0/0/4/1  AXImage  d=Source Toggle Template  (249,539 18x18)  actions=(none)                                     ← the chevron
/0/0/6    AXUnknown   d=Sigma         (86,539 42x17.5)        actions=AXIncrement,AXDecrement,AXCancel,AXPress
```

**Byte-identical with and without a real pointer hover over the row** — the chevron is persistent, not hover-drawn, confirming AXDRAG2-b's structural finding under 3.23.

**What AXDRAG2-b missed.** It read the ROW's action names (empty) and the IMAGE's action names (empty) and concluded "frame-resolvable but only mouse-actuatable". Between them sits `/0/0/4`, an `AXUnknown` that advertises `AXPress`. That looked like the cheap answer — a pointerless, focus-free collapse.

It is not. See §2.

## §2 — chevron: `AXPress` is a decoy; the click is the vector

**Arm 0 — `AXUIElementPerformAction(wrapper, AXPress)`:**

```
AXError=0  action=AXPress  wrapperFrame={"x":250,"y":300,"w":16,"h":16}
census delta: NONE — Sigma still renders 22 rows
```

**`AXError = 0` and zero effect.** This is [REPX1 §1.2](repx1-instance-semantics.md) exactly: `AXPress` on Things' custom row elements is DECORATIVE — the AX layer accepts it and the app does nothing. The lesson generalizes past content rows to the sidebar.

**Arm 1 — a CGEvent click at the image's own resolved frame** (flags set explicitly to zero on every event, a `MOVED` settle first, `kCGMouseEventClickState = 1`):

| pass | direction | click point | `Sigma` section after |
|---|---|---|---|
| 1 | collapse | (258, 308) | **2 rows** (was 22) |
| 1 | expand | (258, 308) | **22 rows** |
| 2 | collapse | (258, 308) | **2 rows** |
| 2 | expand | (258, 308) | **22 rows** |

Four actuations, four clean toggles. **Beep sentinel: 0 alert beeps** on every one. **Disruption monitor: tier 0 — no focus steal, no new window** on every one.

**Arm 2 — the cheap alternatives, both negative.** A single click and a double-click on the row BODY at `(164, 308)` left the census **byte-identical** — they select and navigate, they do not fold. The chevron's own 18×18 frame is the only target.

## §3 — where the state lives, and how long it lives

Captured expanded → collapsed → re-expanded, three ways:

| store | expanded → collapsed |
|---|---|
| **the database** (every table, row count + content digest) | **IDENTICAL** — not one table touched |
| `defaults read com.culturedcode.ThingsMac` | **IDENTICAL** |
| **group-container prefs plist** | **CHANGED** — one key |

```
--- ~/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/Library/Preferences/
      JLMPQHK86H.com.culturedcode.ThingsMac.plist
  "collapsedAreaUUIDs" => [
    0 => "61N5cQ8e2rEGd8JZvDoryB"      ← Sigma
  ]
```

The round trip is exact: re-expanding returned all three stores to byte-identical.

**Two consequences.**

1. **It is umd-silent.** No `TMArea` / `TMTask` column moves, no `umd` bump, nothing to sync. Collapsing an area is not a data edit, and Things Cloud never hears about it — **per-device UI state**.
2. **It is DURABLE.** The `persist` cell collapsed `Sigma`, quit Things, relaunched, and re-censused: **section row counts identical** — still collapsed. So the driver's restore is not a courtesy. A fold left behind is a change to the user's sidebar that outlives the process, the drive, and the next launch.

That is why the rung's restore runs on *every* exit path, and why a restore that could not run has to be **said out loud**.

## §4 — collapse-assisted crossing: the wall is not a wall

The AXDRAG5 wall move, `Zeta --before Gamma`, whose path crosses `Eta` (616 pt against a 322 pt span).

**Baseline (the shipped #659 driver, no collapse):**

```
verify-failed:silent-noop after 10s
  "…the area "Eta" and the 25 row(s) Things renders under it stand between this area and
   "Gamma", and that block is taller than the sidebar shows at once (about 616pt of rows
   against 346pt of visible list)…"
after: unchanged   count PASS · assignments PASS
```

**With `Eta` collapsed by hand first:**

```
ok   29s   moved with the ladder
after: … Alpha < Mu < Zeta < Gamma …    placement reached: YES
count PASS · assignments PASS
restore: Eta re-expanded — section row counts match the pre-drive census exactly
```

**`multi` — two walls (`Eta` + `Sigma`) on one span,** `Mu --before Lambda`, a ten-position move:

```
collapse Eta, collapse Sigma  →  table rows 104 → 60
ok   32s   placement reached: YES   count PASS · assignments PASS
restore Sigma, then Eta (reverse order)  →  census identical
```

The wall was never a property of the geometry. It was a property of the geometry *we were willing to leave alone*.

## §5 — the rung, driving itself

The shipped ladder's pre-flight now folds instead of refusing. Same clone, same fixture, no manual step:

| move | walls on the span | result |
|---|---|---|
| `Zeta --before Iota` | Eta | **ok, 86 s** — 1 hop + final drag, `Eta` folded and restored |
| `Alpha --before Lambda` | Eta + Sigma | **ok, 154 s** — 2 hops + final drag, both folded, both restored |
| `Gamma --before LAB-AREA-A` | Eta | **ok, 100 s** — 1 hop + final drag, `Eta` folded and restored |

Every one: `placement reached: YES`, area count invariant PASS, assignment digest invariant PASS, and the post-drive census's section row counts **identical to the pre-drive census**. The success result carries the disclosure as a `note`:

```
"Eta" in the sidebar was collapsed to clear the drag path and expanded again
afterwards; the sidebar looks as it did
```

## §6 — the abort cell, and the two holes it found

The epilogue claims the sidebar is put back on every exit. The `abort` cell makes that claim earn its place: start the drive, watch `collapsedAreaUUIDs` until the fold has actually landed, then **quit Things underneath it**.

It failed twice, and both failures were real.

**Hole 1 — the notice was dropped on the transport-recovered path.** The first run's drag landed just before the kill; the restore could not run; the ui vector returned through its *failure* constructor, which carried `steps` but not `notices`; the pipeline's transport-failure re-verify then found the change HAD landed and re-shaped the whole thing into a **success** — with no mention of the area still collapsed on disk. The one path where a failed restore is most likely was the one path that stayed quiet. **Fixed**: notices ride every exit the ui vector has — partial, watchdog, and clean.

**Hole 2 — the ledger recorded confirmations, not actions.** The second run died *during the fold's own re-census*. The click had gone out and the app had collapsed the area (`collapsedAreaUUIDs = 1`), but the ledger was written only after verification, so it held nothing: the epilogue had nothing to restore and nothing to report, and a durable change went unmentioned again. **Fixed**: the ledger keys off the CLICK. A gesture that went out but could not be verified is still a gesture to answer for — while the *ladder* still refuses to move forward on it, which is the over-caution direction the AX-scrutiny doctrine asks for.

**After both fixes**, the same kill produces:

```
verify-failed:silent-noop after 64s
  "…could not scroll the area's row into view. No sidebar change was left behind after 1 hop(s).
   ("Eta" collapsed to clear the path, but "Eta" could not be expanded again — the sidebar is
   left collapsed there until you click the arrow (or Things is relaunched, which keeps it
   collapsed))"
```

The fold outlived the drive, because the app it lived in was killed — and the driver names it. That is the correct outcome; silence was the bug.

## §7 — what the rung costs

The collapse path is not cheap, and the reason is the one AXDRAG5 already filed: **one `sidebar-snapshot` costs ~3.4 s** on a 100-row sidebar, and the rung adds a scroll-to-band loop, the click, and a verification snapshot **per wall**, plus the re-plan.

| move | before | after |
|---|---|---|
| one wall | refusal in 10 s | **ok in 86–100 s** |
| two walls | refusal in 10 s | **ok in 154 s** |

Two notes for the record:

- **The drive budget does not bound this.** `DEFAULT_UI_DRIVE_BUDGET_MS` is 90 s and the watchdog is checked at *step* boundaries; the whole drag ladder is ONE step, so a 154 s ladder never meets the check. That is pre-existing (AXDRAG5's field case ground for 332 s under the same budget), not new here — but the collapse rung makes long-but-successful drives ordinary rather than exceptional, which raises the value of profiling the snapshot.
- **The trade is still plainly right**: the alternative was not a faster answer, it was **no** answer.

## App craft filed

[the disclosure chevron is a real toggle with a real frame](../things-app-craft.md) — persistent (not hover-drawn), umd-silent, stored per-device by uuid rather than by index, and exactly reversible. Nothing about it leaks into the synced data, which is why a driver may borrow it and hand it back.

## What remains

- **On-device confirmation.** The rung is certified in-clone; the maintainer's own re-run against a real sidebar is the real-hardware confirmation ([ui-certification-runbook](ui-certification-runbook.md)).
- **Snapshot cost, again.** ~3.4 s per snapshot is now the dominant term in a collapse-assisted move as well as in the AXDRAG5 grind and #651. Still the highest-value profiling target in the drag driver.
- **The chevron is area-only.** Project and heading rows were not probed for an equivalent; nothing in the ladder needs one yet.
