# Headless "closet Mac mini" research — LOCK1 + SYNC1 + SYNC2

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

## SYNC2 — Things Cloud conflict semantics (networked, throwaway account)

**Question.** With two clones signed into ONE real Things Cloud account, how does Things Cloud resolve concurrent offline edits — the SYNC1 open questions (does `BSSyncronyMetadata` populate with a last-sync signal once an account exists? what is the unified-log sync taxonomy?) plus the headline: is same-field conflict resolution timestamp-LWW or arrival-order-LWW? Script: [lab/scripts/research-sync2.sh](../../lab/scripts/research-sync2.sh). Evidence: `lab/artifacts/things-run-sync2-20260713-124441/` (gitignored) — `report.txt`, `A-*/B-*.png` (the VNC account-create + login walkthrough), `scenario-snapshots/*.sqlite` (both clones per phase), `bssync-{A,B}-raw.txt`, `log-*.txt`, `account-credentials.env`.

**Documented airgap exception (sanctioned).** This probe REQUIRES the sync server, so the airgap step was deliberately skipped: network stayed UP and the guest clock NTP-synced to real time (Mon Jul 13 2026). Preflight verified in-guest that the golden's trial is still valid at the real date — Things launched un-nagged ("5 days left", `A-01-launch.png`), trial expiry ~2026-07-18. Two clones (A, B) of `things-lab-golden-v1`, one at a time (2-VM budget), both signed into a single throwaway account. The host Things app/container was never touched.

**Throwaway account (LIVE — burnable).** Created inside A's Things app via a disposable [mail.tm](https://mail.tm) inbox (readable over HTTPS from the host: `POST /token` → `GET /messages`) + random password, no Apple ID. Credentials recorded in `account-credentials.env`:
- Things Cloud email `sync2labc9c6ca5c@web-library.net`, password `6s844pso7xwqjpaa` (16 lowercase+digits — vncdo can't type shifted chars).
- mail.tm inbox password `PQOq8o4s-Y7jSRqi`. Verification: the confirmation mail from `thingscloud@culturedcode.com` carried a 6-digit code (one-time `112780`).
- **Cleanup state: account is LIVE.** Web account management at `https://cloud.culturedcode.com` is reachable (HTTP 200) but deletion was not automatable headlessly this run. The account is safely burnable — throwaway email (mail.tm inboxes lapse) + recorded random password; both VMs deleted. Left for optional manual web deletion.

### `BSSyncronyMetadata` — the SYNC1 headline, answered

**YES — it populates the moment an account is attached: 0 rows (SYNC1, no account) → 11 rows.** Values are binary plists. Decoded (keys are opaque 22-char base62 ids but were **identical across both independently-attached clones**, i.e. app-deterministic, not random-per-device):

| key (stable) | decoded value | role |
|---|---|---|
| `WrEsQjsPnAqJYj12iDJHh7` | `sync2labc9c6ca5c@web-library.net` | account email |
| `XqhSTrhuoVfTqCeYdmi2H8` | `199f528b-1243-4ebf-8151-1284598cb3da` | account/sync-history UUID (**shared across devices**, not a per-device id) |
| `5WPYRFuhkhgEcy39zNsbur` | `SYPrepActionNone` | sync-prep action state |
| **`GryCJ44xPcJG6go5KeTZp1`** | **NSDate double ≈ now** (e.g. `805659262.1` = 2026-07-13 18:14:22 UTC) | **last-sync timestamp — advances on every sync** |
| `YKhPrdihQUt2oFaNb8CiVN` | NSDate double = last-sync **+ 31 years** (2057-…) | lease/expiry sentinel (recomputed as now+31y each sync) |
| `3Zig…`,`XRKJ…`,`Ciuf…`,`QPYu…`,`G5Qb…` | small ints (1→2→3…) | monotonic sync sequence counters (per-slot) |
| `5jY8…` | `{}` | empty dict |

**Doctor signal answer.** `BSSyncronyMetadata.GryCJ44xPcJG6go5KeTZp1` (bplist double, NSDate 2001-epoch) is the authoritative-looking **last-sync timestamp** — it advanced every sync and its key is stable across devices. Two caveats for `doctor --sync`: (1) it **also advanced while offline**, so it tracks the sync engine's last *attempt*, not a confirmed server round-trip — pair it with reachability if you need "successfully synced"; (2) the opaque key was stable across two devices on the *same account* but was not tested across a *different* account, so a robust reader should either key off `GryCJ44xPcJG6go5KeTZp1` OR use the value-based heuristic "the `BSSyncronyMetadata` bplist-double nearest to now" (the only other double is the now+31y sentinel). New plist keys also appear post-account in the group container (`thingsCloudEverUsed = 1`, `thingsCloudSyncDidStartWithInitialSyncAction`), but no timestamp lives there.

### Conflict-resolution verdict table

Baseline to-dos synced to both clones; each clone taken TRULY offline (see infra note) and edited from the same baseline version; reconnected in a controlled order; final state diffed on **both** clones after full re-sync.

| # | Scenario | Verdict | Evidence |
|---|---|---|---|
| S1 | Different fields, same to-do (A sets **title**, B sets **deadline**) | **Clean per-attribute merge** — both survive | `T-DIFF` → title=`T-DIFF-Atitle` (A) + deadline set (B), notes untouched |
| S2 | Same field **notes**, different text each side | **3-way TEXT MERGE, not LWW** — no side dropped | `T-NOTES` notes = `A-EARLY\n\n--\n\nB-LATE` |
| S3 | Same field **title**, timing vs arrival **disagree** (see tiebreak) | **3-way TEXT MERGE** — ordered by edit timestamp, arrival-independent; both clones **converge identically** | `T-TIE2` title = `TIE2-B-first -- TIE2-A-second` on A and B |
| S4 | Checklist items added on both sides | **Merge (union)** | `T-CHECK` has both `CL-FROM-A` and `CL-FROM-B` |
| S5 | Delete-vs-edit (A trashes, B edits notes) | **Per-attribute merge, no data loss** — ends in Trash (A) carrying B's note | `T-DEL` trashed=1, notes=`B-edited` (recoverable) |

### The tiebreak (headline)

**The premise — "same-field concurrent edits are last-writer-wins, one side silently dropped" — is FALSIFIED for text fields.** Things Cloud does a **deterministic per-attribute 3-way text merge**:

- Both `notes` (block field) and `title` (single-line) merge rather than clobber. Separator is `--` (block `\n\n--\n\n` for notes, inline ` -- ` for title).
- **Merge order is by EDIT TIMESTAMP** (earlier-modified text first, later appended second), **independent of sync arrival order.** Two cycles with opposite arrival orders both put the earlier-timestamp text first:
  - Cycle 1: A edited earlier & **arrived last**, B later & arrived first → `A-EARLY -- B-LATE`.
  - Cycle 3: B edited earlier & **arrived last**, A later & arrived first → `TIE2-B-first -- TIE2-A-second`.
- The merged row's own `userModificationDate` = the **later** of the two edit times (max).
- **Both devices converge to the identical merged string regardless of reconnect order** — no split-brain, no merge UI, no duplication. So the answer to "timestamp-LWW vs arrival-order-LWW" is: **neither for text — it's a timestamp-ordered merge that converges deterministically.** (A genuinely scalar field — two different dates/enums on the same slot — was not isolated; title, the expected scalar-LWW candidate, turned out to merge.)

This is benign (no data loss) so it is **not** logged as an oddity, though the concatenated-title result is user-visibly surprising.

### Unified-log sync taxonomy

`sudo log show` works on a normal-clock networked boot (**resolving the SYNC1 "0 lines" mystery — that was the zsh `log` builtin shadowing `/usr/bin/log`, not an absent log store**). But the taxonomy is thin: **Things3 emits NO custom `com.culturedcode.*` os_log subsystem** (`subsystem BEGINSWITH "com.culturedcode"` → empty). Sync activity is visible only indirectly through Apple frameworks: `com.apple.network:boringssl` TLS handshakes to the sync host, and a telling `Failed to register for remote notifications … Application not properly entitled for push notifications` (APNs push is unavailable in the VM, so push-triggered sync degrades to polling). A `doctor` unified-log scan therefore has little Things-specific signal to key on — only generic network/TLS lines.

### Lab-infra finding (reused in the script)

**`route delete -inet default` does NOT airgap a networked tart guest** — the IPv6 default route survives and Things Cloud syncs happily over IPv6 (`curl https://cloud.culturedcode.com` → 200 after the IPv4 route was deleted; edits leaked to the server). True offline requires deleting **both** `-inet` and `-inet6` defaults AND quitting Things first (so no live keep-alive sync socket pushes the pending edit), verified by `curl -m5 https://cloud.culturedcode.com` == `000`. Reconnect by rebooting the clone (clean DHCP); mid-session `ipconfig set en0 DHCP` hangs the SSH session. VNC text entry is done via the clipboard (`pbcopy` + Edit-menu Paste) because vncdo's shifted-char/modifier handling is broken here (`type "@"`→`2`, `key super-a`→literal `a`).

## Reproduce

```
TART_HOME=/Volumes/Workspace/tart \
VNCDO=/path/to/vncdotool/venv/bin/vncdo \
  bash lab/scripts/research-lock1.sh     # LOCK1 + SYNC1 (airgapped clone)

TART_HOME=/Volumes/Workspace/tart \
VNCDO=/path/to/vncdotool/venv/bin/vncdo \
  bash lab/scripts/research-sync2.sh     # SYNC2 (networked; provisions a throwaway account)
```

Requires `vncdotool` (host pip is externally-managed → throwaway venv) and `sshpass`. For `research-lock1.sh`, without `$VNCDO` the lock/VNC-click/unlock arms are skipped; the SSH vectors and all of SYNC1 still run. `research-sync2.sh` REQUIRES `$VNCDO` (account creation is VNC-driven) and network; it provisions its own disposable account and tears down both clones on exit. Both scripts tear down their clones on exit.
