# Safety, errors, and recovery

- **Preview before risky writes**: `--dry-run` prints the exact plan (operation, target, expected change) without executing. Use it for anything destructive, bulk, or unfamiliar.
- **Undo**: `things undo` reverses recent changes made through this tool (its own audit trail — not arbitrary app history). Prefer targeted fixes when you know them; undo is the safety net.
- **Deletes are trashes**: `todo delete` moves to Trash and is restorable (`todo restore`). Emptying the trash is permanent and requires explicit intent — don't do it unless the user asked.
- **Ambiguous refs**: when a name matches several items, the command fails and lists candidates with UUIDs — retry with the UUID (or a unique prefix). Never guess between candidates for a destructive action; ask the user or pick by inspecting details.
- **Exit codes**: 0 verified success · 2 usage error (your invocation — read the message, fix, retry) · 3 verify-failed (the app did not apply the change; the message carries the reason and remediation) · others: unexpected — stop and report.
- **Truncation**: JSON output marks `shown < total`; retrieve the rest before summarizing "everything".
- **Refusals**: if the user's request would require a capability the tool reports as unsupported (`things capabilities`), say so plainly rather than improvising through unrelated commands.
