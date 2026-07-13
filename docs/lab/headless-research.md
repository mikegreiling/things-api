# Headless "closet Mac mini" research — LOCK1 + SYNC1

Feeds the `ui`-vector productization decision (up-next §1) and the `doctor` sync-health section (up-next §5). Both campaigns ran in ONE `--vnc-experimental` clone of `things-lab-golden-v1` (airgapped, clock-pinned 2026-07-05, Things 3.22.11 / macOS 15.7.7 / DB v26). Script: [lab/scripts/research-lock1.sh](../../lab/scripts/research-lock1.sh). Evidence: `lab/artifacts/things-run-lock1-20260713-091759/` (gitignored) — `report.txt`, `01-prelock.png`, `02b-locked.png`, `03-after-uiclick.png`, `05-locked-relaunched.png`, `06-after-unlock-attempt.png`, `final.sqlite`, `defaults-ThingsMac.txt`, `group-prefs.txt`, `container-tree.txt`.

## LOCK1 — locked-session vector probe

**Question.** On a headless always-on Mac whose screen is locked, which write/read vectors still function over SSH, and does a synthetic UI click leak past the lock? This bounds what a `ui` vector (VNC synthetic input) can and cannot do when the machine is left locked.

**How the lock was actually achieved (a finding in itself — the plan's "ctrl+cmd+Q via VNC" does NOT work).** Three lock methods were tried; only the last two produced a real, password-gated lock:

| Method | Result |
|---|---|
| VNC synthetic **ctrl+cmd+Q** (`vncdotool` keydown/keyup, super=Cmd) | **No effect** — framebuffer unchanged. The macOS Lock-Screen keyboard shortcut is not honored from vncdotool's synthetic modifier+Q chord. |
| Legacy `defaults -currentHost write com.apple.screensaver askForPassword 1` | **Ignored on Sequoia** — the screensaver engages but is NOT password-gated; a single click dismisses it straight back to the live desktop (proven in an earlier run: the "lock" screenshot was the Things desktop). |
| `sudo sysadminctl -screenLock immediate -password …` (supported CLI) + `open -a ScreenSaverEngine` | **Works** — enables the immediate password gate; the screensaver becomes a genuine lock. |
| `SACLockScreenImmediate` (login.framework) via **`launchctl asuser <uid>`** | **Works, rc=0** — the exact loginwindow immediate-lock that ctrl+cmd+Q invokes. Run over a *plain* SSH shell it returns **rc=22 (EINVAL)** and does nothing; it must run inside the console user's bootstrap (`launchctl asuser`). |

Lock confirmed visually: `03-after-uiclick.png` is the real macOS lock screen ("Sunday, July 5 / 12:00", user avatar, "Managed via Tart", **Enter Password** field), not the Things window.

> **Doctrine for a real closet Mac:** to lock (or keep locked) a headless Mac programmatically, use `sysadminctl -screenLock immediate` + `SACLockScreenImmediate` via `launchctl asuser`. Do **not** rely on a synthetic keystroke.

**Verdict table** (all vectors fired over SSH while the loginwindow lock was up; DB diffed after each). Matches the up-next predictions exactly — a–e work, f hits the lock screen.

| # | Vector | Under lock? | Evidence |
|---|---|---|---|
| a | SQLite read (`main.sqlite?mode=ro`) | **WORKS** | `SELECT COUNT(*)` → 37 rows returned while locked |
| b | `open -a Things3` launch (app quit first, session stays locked) | **WORKS** | after `quit` pid=DEAD; after SSH `open -a` pid=794 (app launched under lock) |
| c | `things:///add` URL mutation | **WORKS** | `LOCK-URL` row absent→present (0→1) |
| d | AppleScript `make new to do` | **WORKS** | `LOCK-AS` row absent→present (0→1); AS returned the new id |
| e | `shortcuts run things-proxy-create-heading` (Shortcuts proxy, like s-suite) | **WORKS** | `LOCK-SC` heading in LAB-PROJ-HEADINGS absent→present (0→1); `[exit 0]` |
| f | VNC coordinate click at a Things UI location (1024,760) | **HITS LOCK SCREEN** | woke the black-locked display to the **Enter Password** prompt (`03-after-uiclick.png`); never reached Things |

**Arm 2 (launch under lock).** Quitting Things while locked, then `open -a Things3` over SSH, launched a fresh instance (pid 794) that immediately accepted a `things:///add` (`LOCK-RELAUNCH-URL` 0→1). A locked session is a presentation/input barrier owned by loginwindow, **not** an execution barrier: LaunchServices, Apple-event dispatch, the URL handler, and the Shortcuts runner all continue to serve the background Aqua session.

**Unlock-over-VNC (noted; not relied on for the vectors).** Typing the guest password into the lock field via VNC (`type admin` + Return) **unlocked** the session (`06-after-unlock-attempt.png` = desktop restored, Inbox now 5 = the three under-lock writes visible). So VNC keystrokes DO reach the password field — the whole-machine-control caveat for the `ui` vector: a VNC-reachable locked Mac can be unlocked by anyone who can drive VNC and knows the password.

**AX-under-lock remains the unprobed unknown.** Element-based driving (`AXPress`) under lock is the most valuable open question for the `ui` vector but is not probe-able in a VM — Accessibility consent is SIP-blocked in the golden (UI1, `osascript` System Events → −1719). Needs the real-hardware sitting if the `ui` vector proceeds.

## SYNC1 — last-sync signal archaeology (no Things Cloud account)

**Question.** Is there a machine-readable "last synced / data-freshness" signal a `doctor --sync` could read? Inventoried every candidate home WITHOUT a cloud account (the golden has none).

### Signal inventory

| Source | Finding | Sync-useful? |
|---|---|---|
| **DB `BSSyncronyMetadata`** (Cultured Code's "Syncrony" sync framework) | **0 rows** — empty without an account | Would be THE home for a sync cursor once an account exists — **unverifiable here** |
| **DB `Meta`** | only `databaseVersion`, `didCreateDefaultTags`, `didRemoveOrphanHeadings` (plist blobs) | No — no sync cursor/timestamp |
| **DB `TMMetaItem`** | 1 row, 46-byte blob | Unlikely (opaque; not obviously sync) |
| **DB `TMSettings`** | columns: `logInterval`, `manualLogDate`, `groupTodayByParent`, `uriSchemeAuthenticationToken` | No sync/account/lastSync column exists in v26 |
| **DB `TMTombstone`** | 0 rows (deletion tracking for delta sync) | Structural only; empty pre-account |
| **DB `TMTask.userModificationDate`** | `MAX() = 2026-07-05 13:14:17 UTC` | **YES — "last local edit" freshness proxy** (per-row mtime; take the table max) |
| **`defaults read com.culturedcode.ThingsMac`** | only Sparkle updater keys: `SULastCheckTime`, `SULastProfileSubmissionDate`, `SUEnableAutomaticChecks`, `SUHasLaunchedBefore` | No — update-check timestamps, not sync |
| **Group-container plist** (`…/Library/Preferences/JLMPQHK86H.com.culturedcode.ThingsMac.plist`) | `importantInformationLastForegroundDate = 2026-07-05 12:01:01`, `importantInformationLastCheckedDate`, `whatsNewLastCheckedDate`/`…Checksum` | **`…LastForegroundDate` = a liveness/last-foreground signal** (marketing-check plumbing, but tracks app foreground); no sync keys |
| **Container files** | group container holds only `ThingsData-*/…thingsdatabase`, `Backups/`, `Library/{Application Support,Preferences,Application Scripts,Caches}` | No Cloud/Syncrony/push/account-shaped files without an account |
| **WAL mtime** (`main.sqlite-wal`) | advanced 12:01:36 → 12:01:41 across a single `things:///add` | **YES — confirmed live freshness proxy** for app write activity |
| **Unified log** (`log show --predicate 'process == "Things3"'`) | **0 lines**, even with an absolute `--start` and no predicate | **Uncharted — the airgapped tart clone retains no queryable log store** (see caveat) |

### Buildable today (feeds `doctor` sync-health, up-next §5)

- **(a) app-running check** — `pgrep -x Things3`; no app = frozen DB, there is no background sync daemon.
- **(b) WAL freshness proxy** — `main.sqlite-wal` mtime; advances on every app write (confirmed). Pair with…
- **(b′) last-local-edit** — `MAX(TMTask.userModificationDate)`; the newest content-edit timestamp in the library.
- **(b″) last-foreground** — group-container plist `importantInformationLastForegroundDate` (when the app was last frontmost).

None of these is an authoritative "last synced with the server" timestamp — they are *local* liveness/edit proxies. A true server-sync timestamp, if it exists, would live in `BSSyncronyMetadata`, which is empty without an account.

### Unverifiable without a cloud account (SYNC2 scope)

1. Whether `BSSyncronyMetadata` (and/or `TMMetaItem`) populate with a sync cursor / device id / **last-sync timestamp** once an account is attached — the single most important open question for `doctor --sync`.
2. Whether any human-readable "last synced" datetime materializes anywhere (DB column, plist key, container file) after account linking.
3. The **unified-log sync taxonomy** — subsystem/category names and sync-error lines under `com.culturedcode.*`. **Could not be captured at all here**: `log show` returned zero lines in the clone (empty/absent log store in the tart guest; the clock pin also skews `--last` windows). Needs real hardware or a logging-persistent VM.
4. Push/Syncrony state files that would appear in the container once Things Cloud is provisioned.
5. Conflict-resolution semantics — that is SYNC2 proper (networked, throwaway test account).

## Reproduce

```
TART_HOME=/Volumes/Workspace/tart \
VNCDO=/path/to/vncdotool/venv/bin/vncdo \
  bash lab/scripts/research-lock1.sh
```

Requires `vncdotool` (host pip is externally-managed → throwaway venv) and `sshpass`. Without `$VNCDO` the lock/VNC-click/unlock arms are skipped; the SSH vectors and all of SYNC1 still run. The script tears down its clone on exit.
