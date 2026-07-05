# E-suite results — editing-completeness campaign

Suite: [lab/suites/e-suite.json](../../lab/suites/e-suite.json) (10 probes, E01–E10). Locked 2026-07-04 after discovery (one adjustment: E08 → unsupported) + acceptance ×2 identical. All tier 0, app running in background, no crashes. Closes the "cheap editing gaps" batch from [docs/gaps.md](../gaps.md).

| Probe | Finding | Verdict |
|---|---|---|
| E01 | `set name of area` renames; old title gone, uuid stable | supported |
| E02 | `set name of tag` renames; **existing TMTaskTag assignments survive** | supported |
| E03 | `set parent tag of tag` re-parents an existing root tag (creation-time parenting was A05) | supported |
| E04 | URL `append-notes` appends with a **newline separator** (`BASE` + `TAIL` → `BASE\nTAIL`) | supported |
| E05 | URL `prepend-notes` prepends, same newline separator (`HEAD\nBASE\nTAIL`) | supported |
| E06 | AppleScript `move … to list "Inbox"` de-schedules: `start=0`, `startDate` NULL | supported |
| E07 | **URL `duplicate=true` on update works**: exact copy (same title/notes), fresh uuid + creationDate | supported |
| E08 | AppleScript `duplicate` is REFUSED: "Selected to dos can not be copied. (-1717)", zero delta — URL is the only duplicate path | unsupported |
| E09 | `update-project?when=<future date>` schedules a project: `start=2`, `startDate` set (firms up the thin U08 evidence) | supported |
| E10 | `set keyboard shortcut of tag` works; TMTag.shortcut stores the raw character (`"9"`) | supported |

## Template duplication (E13, Phase 12b)

`duplicate=true` on a repeating TEMPLATE does **nothing to the data** (zero new rows; template untouched) and instead opens **new windows** (tier 3 disruption). The clone-and-rename path to de facto repeat creation is dead; repeat creation remains UI-only. Locked as `unsupported`/tier 3, quarantined last in the suite.

## Feed into Phase 9b

New/extended operations, all tier 0 on already-validated vectors: `area.update` (rename — AppleScript), `tag.update` (rename/re-parent/shortcut — AppleScript), notes `append`/`prepend` modes on todo.update + project.update (URL), `todo.move` gains the Inbox destination (AppleScript), `todo.duplicate` (URL only), `project.update --when` now fully evidence-backed.

## Not probed (still open)

Sidebar ordering (areas among areas, projects within an area); `duplicate=true` on `update-project`; whether append-notes skips the newline when the existing note is empty (edge for the delta-assertion; verify at implementation time).
