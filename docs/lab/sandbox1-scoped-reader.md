# SANDBOX1 — the sandboxed reader: a durable, directory-scoped grant to the Things container

**Golden:** `things-lab-golden-v3` · Things 3.22.14 · macOS **15.7.7 Sequoia** · probed **2026-08-21** (campaign script [`lab/scripts/sandbox1.sh`](../../lab/scripts/sandbox1.sh), probe source [`lab/guest/sandbox-probe/`](../../lab/guest/sandbox-probe/main.swift)).

## Question

The maintainer's host measurement (2026-08-21, live deputy ceremony) established that `kTCCServiceSystemPolicyAppData` — the class guarding `~/Library/Group Containers` — issues **allow-once-per-process** grants (pid + boot_uuid-pinned, `auth_value 5`): every fresh process re-prompts, which is unusable for a headless helper. The only Apple-provided durable alternative for an unsandboxed process is Full Disk Access. Question: does **App Sandbox + powerbox selection + app-scoped security bookmark** give a sandboxed tool a DURABLE grant scoped to exactly one directory — another app's group container — with no consent churn?

## Verdict: YES — every cell green

| Cell | Result |
|---|---|
| (a) grant ceremony | `NSOpenPanel` presented by the sandboxed probe under launchd, driven by AX (⌘⇧G → container path → Return → Open) → `GRANT-OK`, app-scoped `.withSecurityScope` bookmark minted for `…/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac` |
| (b) fresh-process read | launchd-hosted probe (NO sshd TCC inheritance) resolves the bookmark, `startAccessingSecurityScopedResource`, reads `main.sqlite` READ-ONLY (37 `TMTask` rows) **and** the prefs plist (1776 bytes) — **no prompt, no kernel stall**, completes in seconds incl. bootstrap |
| (c) per-process durability | two further fresh launchd processes: identical `READ-OK` — the exact axis that breaks AppData grants |
| (d) reboot durability | `tart stop`/`run`, fresh boot, launchd read: `READ-OK` |
| (e) scoping is OS-enforced | without resolving the bookmark, the same container listing is DENIED by the sandbox immediately (errno 1) — no prompt, no stall, no access |
| (f) WAL SQLite correctness | read-only open of the live WAL db + row count + plist bytes through the scope |
| (g) socket serving | UNIX socket bound + echo round-trip at the sandbox container home (`~/Library/Containers/<id>/Data/reader.sock`) |
| (h) rebuild churn immunity | a REBUILT probe (new hash, re-signed bundle, same identifier + Developer ID) resolves the existing bookmark and reads — **no re-grant** |

## Two constraints that shape the production reader

1. **amfid refuses ad-hoc signatures on sandboxed executables** (`AppleMobileFileIntegrityError -423 "adhoc signed or signed by an unknown certificate chain"`, instant `EXC_BREAKPOINT` in `_libsecinit_appsandbox`). A real certificate chain is mandatory — the probe runs Developer-ID-signed. Consequence: the reader inherits the deputy's existing signing story; the self-signed ceremony cert would need guest/host trust-store installation to work.
2. **secinit refuses to sandbox a BARE executable** — the same `_libsecinit_appsandbox` trap persists with a valid Developer ID signature until the binary ships inside a minimal `.app` bundle (`Contents/Info.plist` with `CFBundleIdentifier` + `Contents/MacOS/<bin>`). Consequence: **things-reader ships as a tiny LSUIElement .app bundle**, and its sandbox container (`~/Library/Containers/com.pixelcog.things-reader/`) is the natural home for its bookmark, socket, token, and logs.

## Probe-fidelity note

All read/noscope cells ran **under launchd** (one-shot RunAtLoad plists), never via ssh: ssh-spawned guest processes inherit `sshd-keygen-wrapper`'s TCC standing (that grant is how the lab reads the guest DB at all), which would mask the exact semantics under test. The grant ceremony also runs under launchd — ssh-spawned AppKit has no reliable WindowServer standing (`-10006` from System Events, panel never presents).

## Production consequence (design ratified by the maintainer 2026-08-21)

Split the deputy: **things-reader** (sandboxed .app, bookmark-scoped, serves `sql`/`read-file`/`locate` on a socket in its container) + **things-deputy** (unsandboxed, serves `osascript`/`shortcuts`). One open-panel ceremony replaces both the per-process AppData churn and the Full-Disk-Access escalation; the reader's reach is enforced by the OS at exactly one directory.
