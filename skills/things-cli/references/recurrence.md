# Repeating to-dos and projects

Verbs: `things todo make-repeating <ref>` / `things project make-repeating <ref>` (turn an existing item into a repeater), `things project create-repeating "<title>"` (new repeating project), `… reschedule-repeat <ref>` (change an existing rule in place). Base flags: `--frequency <daily|weekly|monthly|yearly>` and required `--interval <n>` (use `--interval 1` for every unit). Repeating operations require `--allow-disruptive`, including dry runs. For a new weekly to-do, first run `things todo add "<title>" --json`, then `things todo make-repeating <returned-uuid> --frequency weekly --interval 1 --weekdays monday,thursday --allow-disruptive`; supply all requested weekdays comma-separated in that one rule.

## The two repeat modes

- **Fixed schedule** (default): occurrences land on calendar dates regardless of when you finish. NOTE: making an item fixed-repeating REPLACES it — the original becomes a hidden template plus a fresh first occurrence, so its UUID changes; re-find the item by title afterward rather than reusing the old UUID.
- **`--after-completion`**: the next occurrence is scheduled N units after you complete the current one. The item keeps its UUID.

## Rule vocabulary (compose with frequency)

- Weekly on specific days: `--weekdays monday,thursday,friday` — one rule handles MULTIPLE weekdays; never create two repeaters for "every Thursday and Friday".
- Monthly/yearly by date: `--on-day <1–31|last>`.
- Monthly/yearly by nth weekday: `--on-weekday <day> --on-ordinal <1–5|last>`; yearly adds `--yearly-month <1–12>`. Example — "the last Sunday of December, every year": `--frequency yearly --yearly-month 12 --on-weekday sunday --on-ordinal last`.
- End bound: `--ends-after <n>` occurrences or `--ends-on YYYY-MM-DD`. Each occurrence can carry `--reminder HH:mm`; `--deadline` + `--start-days-earlier <n>` make occurrences due-dated with early starts.

## Behavior worth knowing

- Only the CURRENT occurrence is a visible to-do; completing an after-completion occurrence schedules (but does not yet show) the next one.
- `things show <ref> --json` on an occurrence exposes `repeating.templateUuid` — use it as the `<ref>` for `reschedule-repeat`.
- `--dry-run` first for any unfamiliar rule: the plan output shows exactly what will be created.
