# Probe: `thingscli` (dynamic, in-VM)

**Date:** 2026-07-02 · **Environment:** scratch Tart VM (macos-sequoia-vanilla 15.7.7), Things 3.22.11 trial (build 32211007), fresh first launch · **Method:** [`lab/scripts/probe-thingscli.sh`](../../lab/scripts/probe-thingscli.sh) — 40-word command wordlist + subcommand/key sweeps · **Raw evidence:** `lab/artifacts/thingscli/probe-raw.txt` (regenerate by re-running the script).

## Verdict

`Things3.app/Contents/MacOS/thingscli` is a **hidden app-settings utility, not a task API**. The wheel-reinvention concern is closed: nothing in the bundle provides CRUD over GTD data; this project's reason to exist stands.

## Complete command surface (observed)

| Invocation | Behavior |
|---|---|
| `thingscli` | `thingscli: no command provided` |
| `thingscli <anything else>` | `thingscli: unsupported command '<x>'` — for all of: help, version, settings, read, write, list, show, export, import, backup, restore, repair, rebuild, reindex, migrate, library, database, db, sync, token, url(s), scheme, diagnostics, doctor, debug, log(s), reset, check, verify, info, status, config, get, set, delete, open, quicksilver, json |
| `thingscli defaults` | Dumps the app-settings dictionary (old-style plist format); `{ }` before first launch state accrues |
| `thingscli defaults read` | Dumps the full dictionary |
| `thingscli defaults read <key>` | Prints one key or `defaults read: key '<k>' not found` |
| `thingscli defaults write` | `defaults write: missing arguments` (accepts key+value) |
| `thingscli defaults delete` | `defaults remove: missing argument for key to remove` |
| `thingscli defaults <other>` | `defaults: unsupported subcommand '<x>'` (list/help/dump/keys/domains all unsupported) |

**`defaults` is the only command.** Exit code is `0` in every case, including errors — output must be parsed; exit codes carry no signal.

## Observed settings domain (fresh trial, post-first-launch)

```
THCDataFolderCurrentDataFolderPath: ThingsData-3ZIWM
collapsedAreaUUIDs: ( )
firstAppLaunchDate: 2026-07-02 14:59:43 +0000
parentUUIDsWithCollapsedLaterItems: ( )
recentlyDisplayedListIdentifiers: ( today )
todayWidgetCanLaunchThings: 0
version: 2
whatsNewLastCheckedDate: …
whatsNewLastCheckedParameterChecksum: …
windowAutoCascadeTopLeftPoints: { TXMainWindowAutoCascadeIdentifier = "{29, 714}"; }
```

`calendarEventsEnabled` / `remindersInboxEnabled` (seen in static strings) are absent until those features are toggled.

## Byproduct findings

1. **Container parity (probe P0-3) ANSWERED:** the direct-download trial creates `~/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/` with a `ThingsData-<suffix>` data folder — identical layout to the MAS build. Schema knowledge and DB discovery carry over unchanged.
2. **`firstAppLaunchDate` is readable** → the lab runner's trial watchdog can compute the remaining trial window legitimately: `thingscli defaults read firstAppLaunchDate`. (We do not manipulate this value; trial-clock integrity is handled by pinned-clock airgapped clones and, if needed, an extension from Cultured Code.)
3. **`THCDataFolderCurrentDataFolderPath` is readable** → cross-check for DB discovery inside guests (which `ThingsData-*` folder is live).
4. Legitimate golden-image seeding uses: potentially suppress what's-new checks / window cascade state via `defaults write` for determinism (evaluate in Lab-2).

## Sanctioned uses in things-api

- Lab runner: trial-window watchdog (read `firstAppLaunchDate`).
- Lab runner: data-folder resolution cross-check (read `THCDataFolderCurrentDataFolderPath`).
- Not part of the production write-vector set.
