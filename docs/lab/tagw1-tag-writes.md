# TAGW1 — tag-write semantics (disposable clone `tagw1-lab`, golden v1, guest 2026-07-15)

DB is the oracle (no AX grant). Golden untouched; clone stopped+deleted after the run.

- **TAGW1-a (URL scheme, silent drop + partial apply):** `add?tags=Existing,GhostA` and `update?tags=Existing,GhostB` each landed ONLY `Existing` in `TMTaskTag`; neither `GhostA` nor `GhostB` appeared in `TMTag`. Unknown tags are dropped, known tags still apply (partial write), and the missing tag is never created.
- **TAGW1-b (AppleScript `set tag names`, SILENT CREATE — diverges from URL):** `set tag names of to do id … to "Existing, GhostC"` landed BOTH tags and CREATED `GhostC` in `TMTag` (root, index 0). AppleScript creates unknown tags as a side effect; the URL scheme drops them. Recorded in oddities.
- **TAGW1-c (duplicate names uncreatable via app surfaces):** `make new tag {name:"DupRoot"}` twice returned the SAME uuid and left ONE row (same for `DupF`); the same-name-under-two-parents attempt also collapsed to one row. `make new tag` coalesces to the existing same-named tag; the URL scheme cannot create tags at all. Two tags therefore cannot share a name through any available write surface.
- **TAGW1-d (`/` legal in a tag name):** `make new tag {name:"sl/ash"}` stored the literal title `sl/ash`; it matched literally when applied via BOTH AppleScript `set tag names` and URL `tags=sl%2Fash`. Path-syntax needs a literal-over-path precedence rule.
- **TAGW1-e (GUI filter bar):** not obtained (vncdo unavailable; screencapture did not transfer; and duplicates could not be staged per (c)). Deferred.
- **TAGW1-f (duplicate resolution determinism):** MOOT — no real duplicate pair could be created (c), and synthesizing one would require a forbidden direct SQLite write. The library therefore keeps the fail-closed-with-candidates posture for the Cloud-sync-only duplicate case rather than adopting an app policy that cannot be verified to exist.
