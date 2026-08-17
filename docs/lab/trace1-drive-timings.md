# TRACE1 — make-repeating UI-drive step timings + the #487 hang adjudication

**Probed under: `things-lab-golden-v3` · Things 3.22.14 (build 32214000) · macOS 15.7.7 · DB schema v26 · pinned clock 2026-07-05 12:00.** ONE disposable clone `trace1` of golden-v3 (golden untouched; every write inside the clone), airgapped. golden-v3 carries the baked L3-accessibility grant, so the ui vector drives and the per-step trace is collected over SSH. Ground truth = the dev-mode trace JSONL the CLI writes under `~/.local/state/things-api/trace/`. Fixtures fully synthetic (`TRACE1 *` titles). The live-host incident (maintainer's desktop, 2026-08-17) is reproduced here in shape only; the real host's uuids/titles are deliberately kept out of the repo.

This campaign calibrates the **in-CLI UI-drive watchdog default** and gives future hang reports a lab baseline to compare against. See the ruling in [docs/design/decisions.md](../design/decisions.md) 2026-08-17 and the fix in `src/write/vectors/ui.ts` / `src/trace/tracer.ts` / `src/cli/interrupt.ts`.

## The report (#487)

`todo make-repeating <uuid> --frequency weekly --interval 2 --weekdays wednesday --when 2026-08-26 --reminder 18:00 --dangerously-drive-gui --json` on the maintainer's large, actively-syncing production host: the Repeat dialog appeared and every field filled correctly, then the modal **sat open for tens of seconds**; the caller (an agent with a ~30s timeout) received **empty stdout — no JSON, no error, no retained exit code**; no CLI process remained afterward; the modal later closed on its own and the template landed correctly (rule + first occurrence + reminder all verified).

## Hypothesis adjudication (from code; each link holds independent of the others)

1. **No signal handler existed → a killed process emitted nothing. CONFIRMED.** Before this change there was no `process.on("SIGTERM"|"SIGINT")` anywhere (`grep -rn "process.on" src/`), and `runCli()` schedules the async write without a top-level await — so a SIGTERM during the drive tore the process down with zero output. This alone produces the exact "empty stdout, no exit code" report.

2. **Per-step osascript + a parent-side kill timer → the in-flight step orphans and completes. CONFIRMED structurally.** `defaultRun` (src/write/vectors/ui.ts) dispatches **one `osascript`/`open` per primitive** via `execFile`, and the drive `await`s them strictly sequentially. Node's `execFile({ timeout })` arms the kill timer **in the parent**; when the parent (node) is killed, that timer dies with it, so the lone in-flight `osascript` is **no longer bounded and runs to completion as an orphan** — which is why the modal eventually closed and the rule landed after the CLI was already gone. Subsequent steps never ran (the orchestrator was dead), so the orphan window is exactly one step. This is the deliberate **orphan policy**: per-step execution means a kill halts at a step boundary, and the single in-flight step is allowed to finish cleanly (a clean OK-commit is benign); no detached/daemonized process is ever spawned.

3. **The stall is aggregate, not one slow call. CONFIRMED as the dominant link.** There was **no overall drive budget**. A full-vocabulary make-repeating recipe is ~10–12 steps; each `osascript` is capped at `STEP_TIMEOUT_MS = 15_000`, candidate resolution at `RESOLVE_CANDIDATE_TIMEOUT_MS = 5_000`, and several primitives run their own internal retry loops (`axSetValueScript` attempts=3; `axSelectPopupCandidatesScript` re-clicks up to 20×; `axSetDateTimeScript` polls up to 20×), plus a fixed `SETTLE_AFTER_REVEAL_MS = 1_500`. On a production DB (large + Things-Cloud syncing) each dialog re-layout and the final OK commit land **several times slower** than on the airgapped golden, so the sum comfortably exceeds a 30s caller timeout though no single osascript hits its 15s cap. The golden **will not reproduce the slowness** (tiny DB, no sync) — which is why #487 was never seen in-lab and why the watchdog default multiplies the lab baseline by a wide safety factor rather than tracking it.

### Falsified: the "future-dated instance-discovery poll" hypothesis

The maintainer separately proposed the hang was **post-drive** — the pipeline polling for a not-yet-spawned instance because the first occurrence was future-dated (`--when 2026-08-26`). **Falsified three ways:**

- `discoveryOf` (src/write/promote-clone.ts) is explicitly instance-null-tolerant: `instanceUuid: rep?.instanceUuid ?? null`. A future-dated series simply reports `instanceUuid: null` and returns.
- The verify poll is hard-capped: `verifyTimeoutMs ?? (appRunning ? 6000 : 10_000)` with `RECOVERY_VERIFY_TIMEOUT_MS = 2000` — it cannot hang for "tens of seconds".
- The live observation (modal still OPEN during the stall) places the stall **at/before the OK press**, upstream of any discovery poll.

Locked by a regression test: `test/unit/repeat-discovery.test.ts` → "future-dated first occurrence: instanceUuid null and the delta is satisfied promptly (#487)" asserts the discovery yields `instanceUuid: null` and the delta is `satisfied` (so the poller returns on its first attempt).

## The trace as shipped

A development checkout (a `-dev` build, or `things config set trace true` / `THINGS_API_TRACE=true`) writes one JSONL file per write invocation to `~/.local/state/things-api/trace/<ISO-stamp>-<pid>.jsonl`. Each line is `{ ts, elapsedMs, phase, … }`, flushed synchronously (a SIGKILL still leaves every line up to the last checkpoint). Phases: `invocation` (sanitized argv + version + pid), `stage` (pipeline milestones: execute-start/execute-done/verify), `ui-dispatch` (one row per osascript hop — primitive, label, durationMs, ok, timedOut), `watchdog`, `result`, `signal`, `invocation-end`. One file reconstructs a hang: the `ui-dispatch` rows show exactly which step's osascript was in flight, and for how long, when the timeline stops. **LOCAL-ONLY** — a trace may contain real task titles/uuids from the running database; it must never be committed to the public repo or attached to a public issue.

## Per-step timing baseline (golden-v3, airgapped)

Collected by [`lab/scripts/research-trace1.sh`](../../lab/scripts/research-trace1.sh) on 2026-08-17: ONE `trace1` clone of golden-v3, airgapped, clock pinned 2026-07-05 12:00; the shipped production bundle driven with `THINGS_API_TRACE=true`; a synthetic `TRACE1 weekly` to-do made repeating with the FULL #487 vocabulary (`--frequency weekly --interval 2 --weekdays wednesday --when 2026-08-26 --reminder 18:00 --dangerously-drive-gui --json`). The drive **succeeded** (`ok`, exit 0 — #487 is a slowness/interruption fault, not a drive failure), so the numbers are a clean end-to-end baseline. Each row is one `ui-dispatch` osascript hop, in drive order; `attempts` counts the osascript dispatches under that label (retry loops internal to a single osascript are invisible here — they show only as that hop's wall time). Trace + logs (gitignored): `lab/artifacts/trace1-lab/`.

| step (label) | primitive | wall ms | attempts |
| --- | --- | ---: | ---: |
| session-reachability probe | resolve | 252 | 2 |
| reveal the target (`things:///show?id=`) | reveal | 17 | 1 |
| bring Things to the foreground | activate | 46 | 1 |
| Items ▸ Repeat… (canary resolve) | resolve | 72 | 1 |
| confirm target selected + Repeat… enabled | assert-eligible | 82 | 1 |
| Items ▸ Repeat… | press | 71 | 1 |
| the Repeat dialog | wait | 428 | 1 |
| frequency = weekly (resolve) | resolve | 63 | 1 |
| frequency = weekly | select-popup | 421 | 1 |
| interval = 2 (resolve) | resolve | 75 | 1 |
| interval = 2 | set-value | 1583 | 1 |
| weekday = wednesday (resolve) | resolve | 62 | 1 |
| weekday = wednesday | select-popup | 440 | 1 |
| Next (first occurrence) = 2026-08-26 | set-datetime | 676 | 1 |
| check Add reminders (resolve) | resolve | 80 | 1 |
| check Add reminders | press | 185 | 1 |
| reminder = 18:00 | set-datetime | 447 | 1 |
| press "OK" (resolve) | resolve | 75 | 1 |
| press "OK" | press | 56 | 1 |

**Total osascript wall time: 5131 ms (~5.1s). Whole invocation (incl. the 1.5s post-reveal settle + verify poll): 7408 ms (~7.4s), exit 0.** The slowest single hop is the `interval` `set-value` (1583 ms — it types, Tab-commits, and reads the field back, retrying up to 3× internally against the dialog's group re-layout); the pop-ups and date areas are ~0.4–0.7s each; the OK press itself is fast on the golden (56 ms) because the airgapped DB commits instantly.

### Watchdog default derivation

The default budget is `DEFAULT_UI_DRIVE_BUDGET_MS = 90_000` (src/config.ts) — roughly **12× the ~7.4s golden total**. The wide factor is deliberate and does not track the golden number: #487 fired on a large, actively-syncing production DB where the drive ran "tens of seconds" past a 30s caller timeout, i.e. **several times the golden**, dominated by the OK-press commit and each dialog re-layout waiting on the synced store (all near-instant here). 90s covers that production slowdown with headroom while sitting comfortably below the **≥120s** timeout callers are told to allow — so the CLI's watchdog is always the first to give up, returning a structured `uncertain` timeout with the trace path instead of leaving the caller to kill an empty-stdout process. Because the watchdog preempts at step boundaries (each osascript is separately capped at `STEP_TIMEOUT_MS = 15_000`), the effective stop lands within ~15s of the budget. Configurable per host via `things config set ui-drive-budget-ms <ms>` / `THINGS_API_UI_DRIVE_BUDGET_MS`.
