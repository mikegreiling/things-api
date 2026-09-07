# CHORD3 — the to-do arrow-chord reorder, built and certified

**Certified under: `things-lab-golden-v4h` · Things 3.23 · DB v27 · macOS 15.7.7 · guest clock pinned 2026-07-05 (trial wall 2026-07-18) · helpers 1.4.0 installed, granted and ROUTED inside the guest.** Disposable clones (`gscr-chord-*`), destroyed at the end of each run. All fixtures synthetic. Driver: [`lab/scripts/stage5-rc-run.sh`](../../lab/scripts/stage5-rc-run.sh) with the cell script [`lab/guest/stage5-cells-chord.sh`](../../lab/guest/stage5-cells-chord.sh):

```sh
TART_HOME=/Volumes/Workspace/tart VM_NAME=gscr-chord-1 \
  RC_DIST="$PWD/dist" GUEST_CELLS=lab/guest/stage5-cells-chord.sh \
  bash lab/scripts/stage5-rc-run.sh
```

This is a BUILD campaign, not a probe campaign: [CHORD2](chord2-reorder-laws.md) measured the laws and this wires them into the shipped `reorder` operation as a third VECTOR, then certifies that vector in the routed guest through the production CLI. What CHORD2 left open and this closes is named per cell below; what it did not touch is in §6.

---

## The shape that shipped

`reorder` is one operation with three implementations now, chosen by the pipeline:

| vector | when it is chosen | what it costs |
|---|---|---|
| **applescript** (the private `index` re-rank) | `allow-experimental` on, the app still applies the command | one call — but Things 3.23 applies it and changes nothing, so it is version-gated off |
| **ui** (the arrow chords — NEW) | `ui-enabled` on, Accessibility standing present, session unlocked | one keystroke per slot, one row's rank per keystroke |
| **url-scheme** (the `when=` bounce) | whenever the chord cannot run | two verified mutations per item, each taking the row out of its container and back |

The migrated columns in PR 1 are `area-someday` (an area's someday members, `index` axis) and `anytime` (the area-less loose anytime block, `index` axis). `today`/`evening` are PR 2.

**The driver is a closed loop** ([src/write/vectors/ui-chord-todo.ts](../../src/write/vectors/ui-chord-todo.ts)), the same shape the heading sibling uses: read the column out of SQLite → compute the ONE chord that advances it → post exactly that chord → read the column back → assert the order, the single-row write, every member's containment and every member's `userModificationDate` → repeat. A step that produces no delta stops the drive and names the boundary; it is never re-fired.

**Three fences the heading op did not need**, each from a CHORD2 law:

1. **No ⌘⌥ endpoint chord.** §3d measured ⌘⌥ as scoped to the APP's bucket. For a heading that bucket IS the project's heading list; for a to-do column that is a subset of the rows its view renders, one dispatch could carry the row past the column's own first member. The driver walks ±1 and pays N dispatches.
2. **A visibility census before anything is posted.** §4bf: the chord counts DISPLAYED slots, so a view hiding a member makes a single ±1 jump two slots of the list the caller asked about. One plural AX read of the table's labels answers it (novel path 86).
3. **A containment + `umd` tripwire per chord.** §3a/§3f/§4be2: a chord at a bucket edge REPARENTS the row silently instead of declining, and no beep marks it. §6a gives the discriminator — a pure rank move stamps no `umd`, and every measured crossing did.

---

## §1 — The cell table

Run `gscr-chord-2` (2026-09-07), production CLI, routed guest. Columns: what the cell asked, what happened, verdict.

| # | cell | verdict |
|---|---|---|
| 2 | **move up N** — the last row of the anytime column to the front, `reorder <uuid> --in anytime --start` | *(see §1.1)* |
| 3 | **move down N** — the same row to the end | **PASS.** Four slots, exit 0, order exact, `vector=ui result=ok` in the audit trail, Finder frontmost before and after |
| 4a/4b | **to top / to bottom** — an area's someday column, `--in <area> --start` then `--end` | **PASS.** Both landed exactly; `vector=ui` on both |
| 5 | **the `umd` tripwire** — every fixture row's modification date across four reorders | **PASS.** Byte-identical. A pure rank move stamps nothing (CHORD2 §6a reproduced through the shipped op) |
| 6a | **cross-bucket, named onto an axis** — one area-someday row + one anytime row, `--in <area>` | **PASS (exit 2, usage).** *"--in "CH3-AREA" (area …) but these items are not in it: …"* |
| 6b | **cross-bucket, bare** — the same pair with no `--in` | **PASS (exit 4, blocked).** *"the items span different containers (… in the area-someday …; … in the anytime list), so they cannot be repositioned together"* |
| 7a | **a repeating template, named onto the anytime axis** | **PASS (exit 2, usage).** Refused at the axis check — the template is someday-stage |
| 7b | **a repeating template, named onto its own axis** | **PASS (exit 4, `blocked:H-REORDER-SCOPE`).** The day-group refusal names the template by uuid |
| 8 | **a filtered view** — a tag filter applied to the Anytime view first | **PASS, by a route the fence did not have to take: the reorder LANDED correctly (exit 0).** The recipe's own reveal opens the unfiltered list, which clears the filter, so the visibility census found nothing missing. Recorded as a measured property, not as an untested fence — see §3 |
| 9 | **the fallback** — `ui-enabled false`, same request | **PASS.** Exit 0, order exact, `vector=url-scheme` in the audit trail |
| 10 | **undo** — a chord reorder, then `undo --txn <its token>` | *(see §1.1)* |
| 11 | **latency** — one warm reorder, then a four-slot one | **MEASURED.** §4 |

### 1.1 — What the first two runs cost, and what they taught

Run 1 was RED at 17 failures for one reason and one reason only: **`things reorder` addresses its movees by UUID or partial-UUID and never by title.** Every cell had named its fixture by title, the way every other write verb in this CLI accepts, and got *"no to-do, project, heading, or area matches"* back. The verb's axis ref (`--in "Home"`) DOES take a title — a different resolver — which is what makes the asymmetry read as a bug rather than a convention. Filed in up-next; the cells now resolve uuids from the database first.

Run 2 was RED at 3, all expectation errors in the cell script rather than product faults: cell 6b's bare cross-container request refuses as `blocked` (exit 4) and the cell expected the `--in` form's usage error (exit 2), and `things undo` has no `--yes` flag, so the undo cell exited 1 on a commander usage error and the assertion that followed it failed too. Cell 2 was also a no-op in run 2 — the seed order already had the row at the front — so the "move up N" arm did not measure a climb. Both are fixed in the committed cell script (`--txn <token>` for the undo, and the LAST row for the climb).

---

## §2 — Selecting a row by uuid

The shipped `select-row` primitive matches a TITLE. CHORD2 §10.3 recorded why that is not enough for this gesture — two rows can carry the same label and the chord moves whatever is selected — so the op ships `axSelectRowByIdScript`: the same walk, the same VMRES1 settle-then-`selected of (row i)` guard, and `id of selected to dos` as the comparison. It is an identity check rather than a label match, at no extra round-trip. Novel path 85.

The cost is the walk: ~0.25 s per row probed, paid ONCE per run of chords on the same row (the selection follows the row as it moves — HEADORD1 cell 1h5), which is what makes a multi-slot move cheaper per slot than a single-slot one on a long list. See §4.

---

## §3 — The filtered view, and the answer that was better than the fence

The fence exists because §4bf measured the chord as view-relative. Cell 8 applied a genuine tag filter to the Anytime view and then ran the reorder through the production CLI. **The reorder landed correctly, exit 0, order exact** — because the recipe's first step reveals the column's own list, and that reveal opens it UNFILTERED. The filter is cleared before a single chord is posted.

That is a stronger property than the fence, and it is the reason the fence is still there: it is the backstop for the state the reveal does not reach (a search field the reveal leaves standing, a collapsed group, a future Things that keeps the filter across a show). The census refuses only on a POSITIVE sighting of a missing member — the MODALX1 preflight precedent — so a probe that cannot answer never blocks a reorder that would have worked.

**What is NOT measured:** whether a Quick Find search survives the reveal the way the tag filter does not. The fence covers it if it does; nothing has confirmed which.

---

## §4 — Latency in the clone

Wall times through the production CLI, routed guest, warm app:

| move | wall |
|---|---|
| a request already satisfied (0 chords) | **0.6–0.8 s** |
| one slot | **3.4 s** (cell 10a) / **14.6 s** (cell 11a) |
| three slots (area-someday, to bottom) | **8.5 s** |
| four slots | **6.0 s** (cell 11b) / **22.2 s** (cell 3) |

The spread inside a single slot count is the point: the cost is dominated by the SELECT WALK (a `select` + 0.25 s settle + a readback per row probed, until the wanted uuid answers) and by the post-chord DB poll granularity (250 ms steps), not by the chords. A row near the top of the table is found in two probes; a row near the bottom of a five-row table is found in five. **Per-chord cost, net of the walk, is roughly 1.5 s in the clone.** These are clone numbers on an idle app and they are systematically optimistic about round-trips ([SBSCR1](sbscr1-sidebar-scroll.md) SS8) — real-hardware latency is the maintainer's own measurement, taken at his discretion.

The obvious optimization, unbuilt and worth its own cell: the walk probes rows in table order, but the driver already knows the row's POSITION in the column from the database, so it could start the walk near it. It would not be sound to trust that position as an ordinal (the view renders more than the column), but it is a sound place to start looking.

---

## §5 — Tier 0, certified

Every drive in the routed run was bracketed by a frontmost read, with Finder deliberately put in front first (Things is frontmost by default in the guest, which would have hidden a focus steal):

```
frontmost before the drive: Finder
ok   [1] 02-anytime-up-n — exit 0
     frontmost:   Finder -> Finder
```

Finder before, Finder after, on every cell that drove. The recipe carries no `activate` step and its reveal is backgrounded (`open -g` — `UiStep.backgroundReveal`, added by this build). This is CHORD2 §1 reproduced by the SHIPPED op on a routed host rather than by a probe script.

**A discrepancy found while building it:** the heading chord op's recipe documents the same background delivery and does NOT get it — the shared `reveal` primitive shells a plain `open`, which activates the handler app. `backgroundReveal` is set on the to-do recipe only, because flipping it on a certified op wants its own routed cell. Filed in up-next.

---

## §6 — What this campaign does NOT establish

* **The locked-screen path.** The op refuses under a lock and a screen saver (the LOCKSCR1 gate, `H-UI-SESSION-UNREACHABLE`), by the 2026-09-07 ruling rather than by capability — [CHORDLK1](chordlk1-chord-under-lock.md) measured the chord LANDING under both states with a URL-set selection. Enabling it needs a cell proving the URL-selected VIEW equals the target container, because a show URL navigates and the chord is view-relative. The fallback to the bounce is the shipped answer, and cell 9 certifies the fallback MECHANISM (with the vector switched off rather than with the screen locked).
* **Columns at scale.** Every fixture was 4–5 rows. The select walk is O(rows probed) and the chord count is O(slots), so a 200-row Anytime block is an unmeasured wall time.
* **`today` / `evening`.** PR 2. Their axis is `todayIndex`, their view mixes to-do and project rows on one axis, and This Evening's top edge is the one measured section crossing (§4be2).
* **Cloud sync.** Airgapped clone. The chord's rank write is an ordinary attribute change and SYNC2's 3-way merge should treat it as one, but nothing here measured it.
* **A search-filtered view.** §3.
* **Beeps.** The sentinel reported none on any run, but no cell deliberately drove a chord the app would decline, so the count is uninformative rather than clean.

---

## Reproduce

```sh
export TART_HOME=/Volumes/Workspace/tart
npm run build
VM_NAME=gscr-chord-N RC_DIST="$PWD/dist" GUEST_CELLS=lab/guest/stage5-cells-chord.sh \
  bash lab/scripts/stage5-rc-run.sh
```
