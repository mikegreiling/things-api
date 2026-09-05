# LOCKSCR1 — the locked screen, asked directly (issue [#732](https://github.com/mikegreiling/things-api/issues/732))

**Version stamp:** two arms, one cell file, run back to back on **2026-09-04**.

| arm | VM | golden | transport | Things | macOS | DB |
|---|---|---|---|---|---|---|
| **direct** | `lockscr1` | `things-lab-golden-v4` clone | `THINGS_API_UI_DIRECT=1 THINGS_API_WRITE_DIRECT=1` | **3.23** (32300036) | **15.7.7** | **27** |
| **routed** | `things-rc-stage5-20260904-222255` | `things-lab-golden-v4h` clone | the **deputy** (helpers 1.4.0, `helpers-enabled true`) | 3.23 (32300036) | 15.7.7 | 27 |

Both: airgapped · guest clock pinned **2026-07-05 12:00** (trial wall 2026-07-18) · fixtures fully synthetic (`LOCKSCR1-*`) · the CLI built from this branch and shipped into each guest (`dist/` + node + commander) · both clones destroyed on teardown · the goldens never booted. Immutable snapshot per the [harness](harness.md) version-stamping policy.

Drivers: [`lab/scripts/research-lockscr1.sh`](../../lab/scripts/research-lockscr1.sh) (direct) and [`lab/scripts/stage5-rc-run.sh`](../../lab/scripts/stage5-rc-run.sh) with `GUEST_CELLS=lab/guest/lockscr1-cells.sh` (routed). One cell file, [`lab/guest/lockscr1-cells.sh`](../../lab/guest/lockscr1-cells.sh), runs in both.

---

## 0. What was under test

Field incident (things-api **0.20.11**, helpers 1.4.0, routed, Things 3.23.3 / macOS 15.4.1 on the maintainer's M1). A GUI `area reorder … --first --dangerously-drive-gui` was attempted while the Mac was **locked**. Twice, 5.77 s and 5.67 s, exit 3:

```
verify-failed:silent-noop
transport failed (exit 1): ui drive stopped at "drag the area "SOURCE_AREA" to the top of the
area list" (Things is running but has no open window — only the placeholder it keeps in the
background. Open the Things window (click its Dock icon) and re-run. No sidebar change was left
behind.). Completed: bring Things to the foreground (the pointer must reach the sidebar).
```

An independent computer-use check then reported the Mac locked and could not unlock it.

The sentence is inference, and the inference had no premise. A locked session enumerates **zero windows for every process** — that is the whole SESSGATE discriminator ([#480](https://github.com/mikegreiling/things-api/issues/480), [sessgate-session-reachability.md](sessgate-session-reachability.md) §B) — so "no window in the inventory" is exactly as consistent with a locked screen as with a closed window, and the drive picked one and asserted it. It then sent the operator to click a Dock icon behind a lock screen, and reported the outcome as a **verify failure** although nothing had been posted.

Two things had to change, and only one of them is a new capability:

1. **The ORDER.** Ask the session whether it is locked BEFORE inferring anything from the window inventory.
2. **The honesty of the fallback.** When the session cannot be established, the window sentence must say so rather than choose.

---

## 1. The session dictionary, measured in three screen states

`CGSessionCopyCurrentDictionary()` through the JXA ObjC bridge. Prompt-free by construction: it reads the caller's own login session, targets no application, and is not TCC-gated (permissions doctrine, Article I). Identical readings on both arms.

| key | unlocked | screen saver (no password gate) | locked (`sysadminctl -screenLock immediate` + `SACLockScreenImmediate`) |
|---|---|---|---|
| `CGSSessionScreenIsLocked` | **absent** | **true** | **true** |
| `CGSSessionScreenLockedTime` | absent | present | present |
| `kCGSSessionSecureInputPID` | absent | **present** | absent |
| `kCGSSessionOnConsoleKey` | true | true | true |
| `kCGSessionLoginDoneKey` | true | true | true |
| `CGSSessionUniqueSessionUUID`, `kCGSSessionAuditIDKey`, `kCGSSessionGroupIDKey`, `kCGSSessionLoginwindowSafeLogin`, `kCGSSessionSystemSafeBoot`, `kCGSSessionUserIDKey`, `kCGSSessionUserNameKey`, `kCGSessionLongUserNameKey`, `kSCSecuritySessionID` | present | present | present |

**Three laws come out of this table.**

**(1) Absence is the unlocked reading.** macOS ADDS `CGSSessionScreenIsLocked` when the screen locks and DROPS it when it unlocks — it is never written `false`. So a dictionary that resolved without the key is positive evidence of an unlocked screen, not a gap in the evidence, and the shipped interpreter treats it that way.

**(2) The window server counts a bare screen saver as locked.** With `sysadminctl -screenLock off` and a plain `open -a ScreenSaverEngine`, `CGSSessionScreenIsLocked` is **true** and `kCGSSessionSecureInputPID` appears. There is no password gate in that state and yet the session reports itself locked — which is the *right* answer for our purposes (a click would dismiss the saver, not reach Things) and means the distinct `screensaver` verdict in the code is a FALLBACK rung, reachable only on a session that reports no lock while `ScreenSaverEngine` runs. It did not fire on this build. Killing the saver did **not** clear `CGSSessionScreenIsLocked`: the session stayed locked for the rest of the sitting.

**(3) It answers an `ssh` login too.** This campaign was built expecting the opposite — a process with no window-server session of its own getting nothing back — and therefore runs every session-sensitive cell through `launchctl asuser` (`gui`, the field shape) while recording the plain ssh reading beside it. **The two are byte-identical in every state.** `unknown` is therefore rare in practice; it remains the reading the code refuses to guess past, because a confident wrong answer is the whole defect.

The probe is **1,699 bytes**, makes **zero AX round-trips** (`axOps: 0`), and on the routed arm the deputy's broker accepted it (`deputy.log`: `scriptBytes: 1699, ok: true`, 128 ms and 38 ms) — it contains none of the broker's banned phrases, which `test/unit/ui-script-broker-safety.test.ts` now pins through the shared script catalog.

---

## 2. The cells — both arms, identical results

`FAILURES: 0` on each. `LOCKSCR1-A1…A3` are synthetic areas; `LOCKSCR1-REP` a synthetic to-do, both minted while unlocked.

| cell | what | direct (v4) | routed (v4h) |
|---|---|---|---|
| **0** | the Aqua-session wrapper re-enters as uid 501 | ok | ok |
| **P/1** | the session dictionary, unlocked, in-session vs over ssh | identical, `unlocked` | identical, `unlocked` |
| **A** | `area reorder LOCKSCR1-A3 --first --dangerously-drive-gui` on an unlocked screen | **exit 0**, 2,766 ms, `A3` first, `vector: ui` | **exit 0**, 2,718 ms |
| **A** | `doctor --ui-state` session row | `unlocked` | `unlocked` |
| **D** | window genuinely CLOSED (⌘W, 0 standard windows), screen unlocked | **exit 3** `verify-failed:silent-noop`, 2,789 ms — *"Things is running but has no open window … click its Dock icon"*, sidebar unchanged | **exit 3**, 2,606 ms, identical |
| **C** | screen saver up, no password gate | session reads **locked**; `area reorder` **exit 4**, 254 ms, the lock sentence; sidebar unchanged | **exit 4**, 326 ms, identical |
| **B** | LOCKED: `area reorder` | **exit 4**, **221 ms**, `blocked:H-UI-SESSION-UNREACHABLE`, sidebar unchanged, **0** `sidebar-*` trace lines | **exit 4**, **289 ms**, identical |
| **B** | `doctor --ui-state` session row under the lock | `locked` | `locked` |
| **B2** | LOCKED: `todo make-repeating … --dangerously-drive-gui` | **exit 4**, 247 ms, the lock sentence, **no rule written** | **exit 4**, 317 ms, identical |

The refusal, verbatim:

```
Refused to drive the Things window: the screen is locked, so no window can be read or clicked.
Nothing was changed.
  remediation: Unlock the Mac and re-run.
```

and from a composite's pre-seed gate, the same clause with the promise it can actually make:

```
Refused to drive the Things window: the screen is locked, so no window can be read or clicked.
Nothing was created.
```

The `session-state` trace record the field will read this off:

```json
{"phase":"session-state","gated":true,"state":"locked","source":"session-dictionary",
 "keys":["CGSSessionScreenIsLocked","CGSSessionScreenLockedTime","CGSSessionUniqueSessionUUID",
 "kCGSSessionAuditIDKey","kCGSSessionGroupIDKey","kCGSSessionLoginwindowSafeLogin",
 "kCGSSessionOnConsoleKey","kCGSSessionSystemSafeBoot","kCGSSessionUserIDKey",
 "kCGSSessionUserNameKey","kCGSessionLoginDoneKey","kCGSessionLongUserNameKey",
 "kSCSecuritySessionID"],"onConsole":true,"screenSaver":false,"axOps":0}
```

**Cell D is the control that makes cell B mean something.** It is the field's own sentence, reproduced deliberately — and correctly, because there the window really is closed and the session really is unlocked. The categorical claim is not a bug; asserting it without asking was. On a session that could NOT be established the same branch now reads *"no Things window could be read — the window may be closed, or the Mac's screen may be locked, or the window may be on another desktop"*, which is unit-covered (`test/unit/ui-drag.test.ts`) because the lab could not stage an unestablished session on either arm.

**Where the two refusals come from.** `area reorder` is stopped by the DRIVE's gate, one hop before the activate preamble. `make-repeating` never reaches the drive: it is a clone-then-promote composite, and its PRE-SEED preflight (`gateUiPreflight`, [#480](https://github.com/mikegreiling/things-api/issues/480)/[#512](https://github.com/mikegreiling/things-api/issues/512)) now asks the lock question ahead of its reachability probe for the same reason the drive does. Before this change B2 refused with SESSGATE's hedged sentence — *"the Mac's screen is locked, or a full-screen app is covering the desktop"* — which was measured on the first pass of this campaign and is what sent the fix into the orchestrator as well.

**5.77 s → 221 ms.** The field's two attempts each spent ~5.6 s reaching a wrong conclusion through the AX tree. The lock question costs one osascript hop and no AX round-trips at all.

---

## 3. What this campaign does NOT establish

- **The maintainer's own re-run.** Lab certification is not field confirmation ([AGENTS.md](../../AGENTS.md), issue lifecycle): #732 stays open until the reorder is re-attempted on the M1 that reported it, locked and then unlocked.
- **The `unknown` branch, live.** Both arms resolved the session dictionary in every state, over ssh and in-session alike, so the uncertainty sentence and the non-refusal on an unread probe are unit-covered only.
- **The `screensaver` verdict, live.** macOS 15.7.7 reports a bare screen saver as locked (§1 law 2), so the fallback rung never fired. It remains as over-caution for a build that reports otherwise.
- **A full-screen Space.** Untouched here; SESSGATE's `window`/`session` discriminator still owns that case, and a full-screen session now reads `unlocked` from this probe, which is correct and leaves the hedged sentence to SESSGATE where it belongs.
- **Multi-user / fast-user-switching.** `kCGSSessionOnConsoleKey` was `true` throughout; a session switched away from the console was not probed.

## Reproduce

```sh
TART_HOME=/Volumes/Workspace/tart bash lab/scripts/research-lockscr1.sh                     # direct arm
TART_HOME=/Volumes/Workspace/tart RC_DIST="$PWD/dist" \
  GUEST_CELLS=lab/guest/lockscr1-cells.sh bash lab/scripts/stage5-rc-run.sh                 # routed arm
```

Artifacts (gitignored): `lab/artifacts/lockscr1/` and `lab/artifacts/things-rc-stage5-*/` — `report.txt` / `stage5-transcript.log` (the full transcript), `out/*.json` (per-cell envelopes), `deputy.log` (the routed arm's broker record).
