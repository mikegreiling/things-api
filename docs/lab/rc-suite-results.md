# RC-suite results — the dated-reminder CLEAR campaign

**Question:** is the Apple Shortcuts vector truly the ONLY way to clear a DATED reminder from a Things to-do/project, or are there working non-Shortcuts paths we never actually probed?

**Answer: FALSE as stated.** Shortcuts is the only *in-place, schedule-preserving, atomic, single-call* clear — but **two non-Shortcuts paths also clear a dated reminder**: the URL `when=today`→re-date bounce (pure URL, the guard's own recommended workaround, now verified end-to-end) and the AppleScript move-to-Inbox de-schedule. Both work; both are disruptive (they mutate the schedule as a side effect) and non-atomic. A third avenue (an AppleScript reminder-property write) is conclusively dead.

Suite: [lab/suites/rc-suite.json](../../lab/suites/rc-suite.json) (RC01–RC03). Ran + locked 2026-07-11 on the golden clone; acceptance ×2 identical (`rc-20260711-172432` discovery, `rc-20260711-*` re-validation), all tier 0, app running in background, no crashes. Avenues C and D were run outside the JSON harness in the same `--keep-vm` clone. Codec: `reminderTime = hour<<26 | minute<<20` (15:00 = 1006632960); `startDate = year<<16 | month<<12 | day<<7` (2026-07-09 = 132805760, 2026-07-05/pinned-today = 132805248). Golden pinnedDate = 2026-07-05.

## Verdict table

| # | Avenue | Vector | What was done | Observed field delta | WORKING dated-reminder clear? |
|---|---|---|---|---|---|
| RC01 | B, leg 1 | URL | dated item + dated reminder, `update?...&when=today` | `reminderTime` 1006632960 → **NULL**; `start` 2 → 1; `startDate` 132805760 (07-09) → **132805248 (07-05 = today)** | **YES** — but the item is ALSO re-dated to today (the keyword-clear R07 wins over the dated-sticky carry R20/R21) |
| RC02 | B, leg 2 | URL | re-date the cleared item back: `update?...&when=2026-07-09` | `start` 1 → 2; `startDate` 132805248 → **132805760** (restored); `reminderTime` stays **NULL** (no re-attach) | **YES (end-to-end)** — the two-leg bounce is a pure-URL dated-reminder clear; final state = original date, no reminder |
| RC03 | A | AppleScript | dated item + dated reminder, `move to do id X to list "Inbox"` | `reminderTime` 1006632960 → **NULL**; `start` 2 → 0; `startDate` 132805760 → **NULL** | **YES** — the reminder DROPS when the date it hangs on is removed; but the item is de-scheduled (loses date + lands in Inbox) |
| C | AS reminder property | AppleScript | sdef inspection + write attempts | no `reminder`/`alarm` property exists; only read-only `activation date` (`actd`, access=r) and read-only `_private_experimental_ json` (`tdjs`, access=r). `set … json` → **error -10006**; `set activation date` → **error -10006** | **NO — conclusively dead.** No writable reminder term; the json property that exposes the reminder on read (R08) is read-only |
| D | Shortcuts on a PROJECT | Shortcuts | `add-project?when=2026-07-09@15:00` (reminder attaches at creation), then `things-proxy-set-detail {detail:"Reminder Time", value:""}` | `reminderTime` 1006632960 → **NULL**; `start` 2 (unchanged); `startDate` 132805760 (**unchanged**) | **YES — in-place, headless.** Project reminder clear matches the to-do P3b path; consent inherited by the clone (exit 0, no prompt). Closes the capability-matrix:43 untested cell |

Row-level evidence: `lab/artifacts/rc-20260711-172432/evidence/RC0{1,2,3}.json` (gitignored). Avenue C/D transcripts captured in this session; the clone was `things-run-rc-20260711-172432`.

## Bottom line — is "Shortcuts is the only way" TRUE?

**TRUE-with-caveats, and the caveats are load-bearing.** Shortcuts (`things-proxy-set-detail` Reminder Time = `""`, scf P3b / avenue D) is the only surface that clears a dated reminder **in place**: `startDate`/`start` untouched, one call, headless, and it works on both to-dos and projects. But it is NOT the only surface that *removes a dated reminder*. Two others do:

- **Avenue B — URL bounce (`when=today` → re-date).** Pure URL scheme, no Shortcuts, no AppleScript. Cost: **not atomic** (two calls) and **not schedule-preserving mid-flight** — leg 1 re-dates the item to *today* (a caller crash between legs leaves the item mis-dated at today with the reminder gone). The end state is correct (original date restored, reminder cleared). This is exactly the "re-schedule-via-today" remediation that the H-REMINDER-SCOPE guard already recommends — now proven to work end-to-end.
- **Avenue A — AppleScript move-to-Inbox.** One AppleScript call de-schedules the item (`start=0`, `startDate=NULL`) and the reminder drops with the date. Cost: **most disruptive** — the item loses its date entirely and moves to Inbox; restoring it to its date is a second call, and the container/schedule are not auto-restored (matches E06/E15). Effectively "clear the reminder by throwing away the schedule."

**Repeating-item compatibility (the surviving edge for Shortcuts):** avenue B is DEAD on repeating templates — a URL `when=` on a repeating to-do/project CRASHES Things (oddity §1/§7, U12/R09/P14-A4). Avenue A (move a repeating template to Inbox) is unprobed and dubious (the schedule is owned by the rule). So for a repeating item carrying a dated reminder, the URL bounce is unusable and Shortcuts `set-detail` remains the only demonstrated in-place clear. This is the one case where "Shortcuts only" may hold literally — flagged for follow-up, not proven here.

**Net for the copy:** replace "the ONLY surface that clears a dated reminder" with "the only **in-place / schedule-preserving** clear (URL bounce and AS de-schedule also clear it, but both mutate the schedule and are non-atomic; the bounce additionally crashes on repeating items)."

## Implementation note (deferred to Mike — NOT changed here)

`todo.clear-dated-reminder` currently ships Shortcuts-only and `H-REMINDER-SCOPE` blocks the URL `reminder:null` on dated whens with a re-schedule-via-today remediation. Given RC01/RC02, that remediation is a **working pure-URL path** the tool could execute itself (a two-call bounce: `when=today` then `when=<original-date>`), removing the Shortcuts dependency for non-repeating items. Trade-off: non-atomic + transient Today re-date + must be gated OFF for repeating items (crash). Whether to add a URL-bounce fallback vector (and keep Shortcuts as the atomic/repeating-safe path) is a doctrine call for Mike — no write LOGIC, guard, op, CLI, or MCP was changed in this campaign; this is copy/doc correction only.

## New facts banked along the way

- **`add-project?when=<date>@<time>` attaches a dated reminder at project creation** (start=2, startDate, reminderTime via the to-do codec) — the matrix previously documented project reminders via `update-project?when=` only. Both work.
- **Avenue C sdef facts (Things 3.22.11):** the `to do` class (inherited by `project`) exposes writable date properties `creation date` / `modification date` / `completion date` / `cancellation date` / `due date` only. `activation date` (the start date) and `_private_experimental_ json` are read-only. There is no reminder/alarm/notification term anywhere in `Things.sdef`. Error -10006 ("Can't set …") is the read-only refusal.
