# APPRUN1 — closed-app launch-readiness law + auto-launch certification (issue #486)

**Probed under:** `things-lab-golden-v3` · Things 3.22.14 (build 32214000) · DB v26 · macOS 15.7.7 · pinned clock 2026-07-05 12:00 · airgapped disposable clone. Immutable snapshot (harness version-stamping policy). Driver: [`lab/scripts/research-apprun1.sh`](../../lab/scripts/research-apprun1.sh) + [`lab/scripts/apprun1-measure.py`](../../lab/scripts/apprun1-measure.py). Artifacts: `lab/artifacts/apprun1-lab/` (gitignored).

## The report

With Things quit, `things todo complete <uuid> --json` returned `verify-failed:silent-noop` (exit 3): the write was dispatched into a not-running app and nothing landed. `doctor` separately knew the app was not running. Expected: launch-and-verify, or a clear preflight environment error.

## Method

ONE disposable golden-v3 clone; airgapped; clock pinned before Things launched; production e2e bundle shipped; fixtures fully synthetic (`APPRUN1-*`); ground truth = read-only guest SQLite. A guest-side Python measurement runs everything on ONE clock: quit Things → `open -g -a Things3` → immediately fire a staggered bank of raw complete-URLs (`things:///update?id=…&completed=true&auth-token=…`) at 15 distinct synthetic to-dos (one every 0.5 s), while sampling candidate readiness signals every 0.2 s. The lowest-offset to-do that ends up completed marks the moment writes start landing.

## Findings

### The startup URL-drop window did NOT reproduce in a clean clone

The FIRST fired URL — dispatched ~0.031 s after `open -g` — **landed**. All 15 targets completed; **zero dropped**. So in a clean airgapped golden-v3 clone there is no observable startup drop window: a URL sent essentially the instant the process exists is applied.

This is the same "does not reproduce on a clean 3.22.14 clone" pattern as #479/#480 (see the golden-v3 certification ruling): the reported silent-noop very likely arises from host session/environment state the lab does not model — a loaded production DB, active Things Cloud sync, or a slow cold launch under memory pressure — not from the app-version/schema. Notably the reported failure survived the pre-fix code's fixed **2 s** post-launch settle, which implies the real-host window (when it occurs) is either longer than 2 s or not purely time-based. The lab's fast SSD + small synthetic DB launch too quickly to exhibit it.

### Signal correlation — WAL-advance is the meaningful post-launch signal

First-trip offset after `open -g` (one guest clock):

| Signal | First trip | Notes |
|---|---|---|
| `pgrep -x Things3` (process present) | **0.031 s** | instant |
| `lsappinfo` StatusLabel ≠ "Not Finished Launching" | 0.031 s | at 0.031 s the label is `[ NULL ]` (no status); it becomes `{ "label"="8" }` at ~0.9 s — never reports "Not Finished Launching" in this fast launch, so it does not distinguish "registered" from "ready" |
| AppleScript `count of areas` answers | 0.031 s | instant — but needs Automation consent, so unusable on the consent-free URL path |
| **WAL mtime advanced** (`main.sqlite-wal`) | **0.907 s** | the app wrote to its DB (Today/repeat recompute) ~0.9 s after launch — a real, non-trivial post-launch signal |
| first URL write LANDED | 0.031 s | (no drop in this environment) |

The **WAL-advance** signal is the only candidate that reflects the app actually *doing work* after launch rather than merely existing. It needs no Apple Event (a file `stat`), so it never drags Automation consent onto the consent-free URL path — unlike an AppleScript readiness read. It is therefore the shipped readiness signal (a DB-write-capability signal, per the ratified design), used as a **defensive floor**: on this fast launch it costs ~0.9 s; on a slow real cold launch it waits until the app has genuinely written; and because the drop window is not deterministically reproducible, any residual drop is still caught by verify and attributed `app-not-running` (retry guidance), never left as a mystery.

### (d) Foreground state — confounded in the headless session

Across the launch window the "frontmost process" read as `Things3` for every sample. This is **not a clean backgroundedness verdict**: the headless lab session has only Finder and Things, so the just-launched app reads as frontmost with no competing foreground app, and the measurement was also firing `open -g` URLs at it. `open -g` is the codebase-canonical least-disruptive launch (u-suite: `open -g` keeps AppleScript ops at tier 0 and avoids the focus-steal that an AppleEvent to a closed app causes, A40/A41), and it is what ships here. True on-workstation backgroundedness (with a real foreground app holding focus) is a pending on-hardware confirmation, like other GUI-adjacent cells — not contradicted by this run, just not cleanly certifiable in a single-app headless session.

## Certification cells (production CLI, end-to-end)

| Cell | Setup | Result |
|---|---|---|
| **(a) auto-launch on (default)** | quit app → `todo complete APPRUN1-A --json` | **PASS** — `ok`, `vector:url-scheme`, `tier:1`, `status:completed`; `warnings:["Things was not running, so it was launched in the background for this write"]`; app now running. The closed-app write auto-launched, readied, landed, and disclosed the launch. |
| **(b) auto-launch off** | `config set auto-launch false` → quit app → `todo complete APPRUN1-B --json` | **PASS** — `blocked:environment`, exit 4, `likelyCause:app-not-running`, message "Things is not running, and auto-launch is turned off", remediation names `config set auto-launch true`. Target stayed `open`; **app stayed quit** (zero dispatch, no launch). |
| **(c) drop-window characterization** | staggered URL bank into a fresh launch | **no drop window** in a clean clone (0/15 dropped; first URL at 0.031 s). Documented above. |
| **(d) launched-app foreground** | frontmost during the launch window | confounded in the headless single-app session (reads `Things3`); `open -g` is the shipped least-disruptive launch; on-hardware confirmation pending. |

## Design as shipped

1. **Preflight** on every real-transport write: the ONE `pgrep -x Things3` shape (`automation-probe.ts` `isThingsRunning`, shared with `doctor`/sync-health — no second process-check form).
2. **Closed app + auto-launch on (default):** background-launch (`open -g`), wait for the process, then wait CLOSED-LOOP on the WAL-advance readiness floor (cap 12 s; proceed on trip or cap), dispatch, verify normally; disclose the launch in `warnings[]`.
3. **Closed app + auto-launch off:** preflight `blocked:environment`, zero dispatch, app untouched.
4. **Failure attribution:** a residual silent-noop/timeout when the app had to be launched → `likelyCause:app-not-running` ("ran during the app's startup window … retry now that Things is up").
5. **Reads are unaffected** — they hit the DB directly and never launch anything.

Ruling: [docs/design/decisions.md](../design/decisions.md) 2026-08-17.
