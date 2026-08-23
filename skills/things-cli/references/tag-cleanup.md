# Mass tag cleanup — reshaping a tag vocabulary without flooding the timeline

A tag cleanup ("we have 40 tags, six of them mean the same thing") touches hundreds of items, and the naive version re-dates every one of them: `things changes --since <moment>` — and any watcher or sync-driven review keyed on the modification date — then reports the whole library as freshly changed, burying whatever really happened that day.

It does not have to. **Two of the three moves cost nothing on the timeline, and the third has a flag.** Work in that order.

## The three moves, cheapest first

| Move | Command | Timeline cost |
| --- | --- | --- |
| **Rename a tag** (merge a synonym into the survivor's name, fix casing, re-word) | `things tag update <ref> --title "<new>"` | **none** — the assignment stores the tag's identity, not its text, so no member item is touched. Existing assignments follow the rename. |
| **Delete a tag** (retire it everywhere, including its whole nested subtree) | `things tag delete <ref> --dangerously-permanent [--acknowledge-subtree]` | **none** — the tag is removed from every item without re-dating any of them. Permanent: tags do not go to the Trash. |
| **Apply or remove a tag on items** (`--set` replaces the tag set, `--add` merges) | `things todo tags <uuid> --add "<tag>"` / `things project tags <ref> --set "<a>,<b>"` | **one re-date per item** — this is the only move that lands on the timeline, and the only one that wants `--preserve-modified`. |

So: **reshape the vocabulary first, re-tag items last.** A rename that turns `errands`, `Errand`, and `errand-run` into one surviving tag costs nothing; every item you can leave alone by renaming instead of re-tagging is an item that never reaches the timeline.

## The recipe

1. **Look before you write.** `things tags` lists the hierarchy; `things anytime --tag <name> --all --json` (or `things search`) enumerates what a tag actually holds. Decide which tag survives.
2. **Rename the survivor into the name you want** (`tag update`), rather than creating a new tag and re-tagging into it. Free.
3. **Fold the synonyms.** For each doomed tag, the items that carry it and NOT the survivor need the survivor added — this is the only pass that re-dates anything, so run it with `--preserve-modified`:
   ```sh
   things todo tags <uuid> --add "errand" --preserve-modified
   ```
   Repeat it per item (a shell loop over the uuids a `--json` read gave you). **`things batch` does not carry `--preserve-modified` today** — neither as a run flag nor as a per-line option — so a batched re-tag lands on the timeline even though each item's own verb would not. Until that changes, a cleanup that must stay silent runs the per-item verb; use `batch` when the timeline does not matter and you want one `undoToken` for the whole submission.
4. **Delete the doomed tags** (`tag delete … --dangerously-permanent`, plus `--acknowledge-subtree` when the tag has children — deleting a parent deletes its whole subtree). Free, and it also removes the tag from anything you missed in step 3, so a stray assignment does not survive as a ghost.
5. **Check the timeline you were protecting**: `things changes --since <the moment you started>` should show only what you meant to surface.

## `--preserve-modified` in one paragraph

It captures each pre-existing edited item's modification date before the write and restores it (to the whole second) afterwards, so the edit does not surface in `changes`. It is universal — every write verb takes it — and a no-op on a pure create. The restore is best-effort: a failure is reported per item and the change itself still stands, so a cleanup never half-applies because a restore missed. It is **safe against a synced library**: the restored date propagates to your other devices and survives the round-trip, so the item stays off the timeline everywhere; the one edge is a genuinely concurrent edit to the same item on another device, which re-dates it through Things Cloud's per-attribute merge — the edit resurfaces rather than being silently hidden (SYNC2B).

Full contract: the `--preserve-modified` bullet in [../SKILL.md](../SKILL.md); per-operation detail in `things <verb> --help`.

## The adjacent cleanup: retiring an area

The same "make the free move first" logic applies to an `(archived)`-style area you want to dissolve. **Deleting an area treats its members by status:**

- an **open** direct member (to-do or project) is moved to the **Trash** and re-dated;
- a **logged** member (completed or canceled) is merely **detached** — its area link is cleared, it stays live in the Logbook, and it is **not** re-dated.

So deleting a long-dead area full of finished work is mostly free: the history stays in the Logbook, unlinked, off the timeline. Only the open remnants move, and those are exactly the ones you should look at first. Deleting an area is **permanent** (areas do not go to the Trash) and a non-empty one is refused unless you pass `--allow-non-empty`:

```sh
things area delete "Old Client (archived)" --dangerously-permanent --allow-non-empty --preserve-modified
```

Preview it first — `--dry-run` reports the plan — and if you want the open remnants kept, move them out before deleting rather than restoring them from the Trash afterwards.

## What this rests on

The laws above are measured, not assumed: the rename/delete/apply modification-date footprint (TAGMOD), the area-delete status-dependent trash-vs-detach split (TAGMOD-T4, refining AREADEL), and the sync round-trip that makes the restore safe on a real Things Cloud account (SYNC2B). The evidence lives with the project's lab documentation, indexed by those names.
