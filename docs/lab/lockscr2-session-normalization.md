# LOCKSCR2 — the session, normalized (issue [#732](https://github.com/mikegreiling/things-api/issues/732) follow-ons)

**Version stamp:** three exploratory rounds and two certification arms, run 2026-09-05.

| arm | VM | golden | transport | Things | macOS | DB |
|---|---|---|---|---|---|---|
| **probe (3 rounds)** | `lockscr2probe`, `lockscr2probe2`, `lockscr2probe3` | `things-lab-golden-v4` clones | raw `osascript`, no CLI | **3.23** (32300036) | **15.7.7** | — |
| **direct** | `lockscr2cert` | `things-lab-golden-v4` clone | `THINGS_API_UI_DIRECT=1 THINGS_API_WRITE_DIRECT=1` | 3.23 (32300036) | 15.7.7 | **27** |
| **routed** | `things-rc-stage5-20260905-151411` | `things-lab-golden-v4h` clone | the **deputy** (helpers **1.4.0**, `helpers-enabled true`) | 3.23 (32300036) | 15.7.7 | 27 |

All arms: airgapped · guest clock pinned **2026-07-05 12:00** (trial wall 2026-07-18) · fixtures fully synthetic (`LOCKSCR2-*`) · every clone destroyed on teardown · the goldens never booted. The certification arms ship the CLI built from this branch; the direct arm ALSO ships the merge-base bundle (`1dde6481`, the LOCKSCR1 tip) so cell (a) can count both on the same guest in the same sitting. Immutable snapshot per the [harness](harness.md) version-stamping policy.

Drivers: [`lab/scripts/research-lockscr2.sh`](../../lab/scripts/research-lockscr2.sh) (the exploratory rounds, cells in [`lab/guest/lockscr2-probe.sh`](../../lab/guest/lockscr2-probe.sh), [`-probe2.sh`](../../lab/guest/lockscr2-probe2.sh), [`-probe3.sh`](../../lab/guest/lockscr2-probe3.sh)), [`lab/scripts/research-lockscr2-cert.sh`](../../lab/scripts/research-lockscr2-cert.sh) (direct) and [`lab/scripts/stage5-rc-run.sh`](../../lab/scripts/stage5-rc-run.sh) with `GUEST_CELLS=lab/guest/lockscr2-cells.sh` (routed). One cell file, [`lab/guest/lockscr2-cells.sh`](../../lab/guest/lockscr2-cells.sh), runs in both.

---

## 0. What was asked

[LOCKSCR1](lockscr1-locked-session.md) made the drive ask whether the screen is locked before inferring anything from the window inventory, which fixed #732's wrong sentence. The maintainer then asked three things of the result, verbatim:

1. *"The fact that it takes a quarter of a second to check whether the screen is locked or not isn't great, especially if that is going to be a preamble to every GUI-driven workflow. Is there any way to make that shorter?"*
2. *"do we have any way to wake up a screensaver that doesn't have a password protected unlock enabled without requiring direct user input?"*
3. *"the window being closed situation feels like something we can surmount ourselves. Can we not just open a new window if there are no open things windows?"*

The answers are: **it costs nothing now**, **yes — with one synthesized modifier key, and never against a password**, and **yes, and the window stays open**.

---

## 1. Waking a screen saver: what does and does not work

Three exploratory rounds, each on its own clone, each state reached with `sudo sysadminctl -screenLock {off|immediate} -password admin` followed by `open -a ScreenSaverEngine`. A screen-saver sitting that is not dismissed leaves the session locked for the rest of that login ([LOCKSCR1 §1](lockscr1-locked-session.md) law 2), so the two password states were measured on separate boots.

### 1.1 The ladder, in the order it was tried

| mechanism | saver, **no** password | saver, password **required** |
|---|---|---|
| IOKit `IOPMAssertionDeclareUserActivity` (JXA ObjC bridge, `kIOPMUserActiveLocal`) | **`rc=0`, nothing happens** — saver up, session locked | same |
| `caffeinate -u -t 2` (the shipped tool over the same API) | nothing happens | — |
| `CGEventCreateMouseEvent(kCGEventMouseMoved)` at the current point, posted to `kCGHIDEventTap` | **nothing happens** | same |
| the same, ±1 px round trip | nothing happens | same |
| `killall ScreenSaverEngine` | process dies; **`CGSSessionScreenIsLocked` stays set** | same |
| `CGEventCreateKeyboardEvent` — **Escape** (key code 53) | **saver dismissed, session clears** | nothing happens |
| `CGEventCreateKeyboardEvent` — **left Shift** (key code 56) | **saver dismissed, session clears** | nothing happens |

`IOPMAssertionDeclareUserActivity` DOES bridge — `ObjC.import('IOKit')` resolves it and it returns `kIOReturnSuccess` — so this is a measured negative, not a missing API. It wakes a sleeping display; it does not dismiss a saver.

### 1.2 The discriminator that made the negative legible

The natural reading of "a synthesized mouse move changes nothing" is that synthetic input is being swallowed — the session dictionary reports `kCGSSessionSecureInputPID` the instant the saver starts, and secure input is exactly the macOS feature that drops injected events. **It is not what is happening.** Round 2 posted a mouse-move to a coordinate the pointer was *not* at and read the pointer back:

```
     TELEPORT from 320,240 -> (200,200): pointer now 200,200   [control: unlocked]
     ScreenSaverEngine pid: 689     session: {"locked":true,"secureInputPid":155}
     TELEPORT from 200,200 -> (480,360): pointer now 480,360   [the saver is UP]
```

Synthetic input reaches the input path with the saver up and secure input engaged. The saver simply does not treat a mouse move as a reason to go — and it does treat a key press as one. That is the whole finding, and it is why a wake is possible at all.

### 1.3 The key we post, and why it is Shift

A lone **left-Shift down/up pair**. It types nothing, presses nothing, and cancels nothing, so it is inert wherever it lands — which is the property that matters, because the one thing that can go wrong is the saver having gone between the read and the post. Escape works identically and is deliberately NOT used: it would cancel a dialog if it ever reached a desktop.

Reproduced twice on one boot, and again in both certification arms:

```
     saver: running   session: {"locked":true,"secureInputPid":154,"lockedTime":1}
     KEY-SHIFT posted
     after SHIFT:  saver=gone  session={"locked":null,"secureInputPid":null,"lockedTime":null}
     AX standard windows for Things3: 1
```

### 1.4 There is no way to tell a password gate apart in advance

| key | unlocked | saver, no password | saver, password required | locked (`SACLockScreenImmediate`) |
|---|---|---|---|---|
| `CGSSessionScreenIsLocked` | absent | **true** | **true** | **true** |
| `CGSSessionScreenLockedTime` | absent | present | present | present |
| `kCGSSessionSecureInputPID` | absent | **present** (155) | **present** (154) | **present** |
| `kCGSSessionOnConsoleKey` | true | true | true | true |
| everything else (`CGSSessionUniqueSessionUUID`, `kCGSSessionAuditIDKey`, `kCGSSessionGroupIDKey`, `kCGSSessionLoginwindowSafeLogin`, `kCGSSessionSystemSafeBoot`, `kCGSSessionUserIDKey`, `kCGSSessionUserNameKey`, `kCGSessionLoginDoneKey`, `kCGSessionLongUserNameKey`, `kSCSecuritySessionID`) | present | present | present | present |

The two saver columns are **identical**. LOCKSCR1 read `kCGSSessionSecureInputPID` as absent under a hard lock and present under a saver and proposed it as the saver-vs-lock discriminator — it is that, and it is **not** a password-gate discriminator (and note this campaign read it as PRESENT under the hard lock too, on a session that had already hosted a saver; the LOCKSCR1 reading was taken on a session that had not).

So there is nothing to branch on, and the nudge is **closed-loop by necessity rather than by taste**: post the key once, re-read the session, and believe only the re-read. With a password required the saver stays up, the session stays locked, and the drive refuses — a wake that is *attempted and honestly fails*, leaving nothing changed.

### 1.5 What the guest golden's state is

`golden-v4`/`v4h` ship with the screen lock as macOS left it; every cell here **sets it explicitly** (`sysadminctl -screenLock off` for the dismissible state, `-screenLock immediate` for the gated one) rather than inheriting it, because the setting is the independent variable. `sysadminctl -screenLock status` is printed beside each cell.

---

## 2. `NSWorkspace.runningApplications` is a frozen snapshot inside one script

The first certification run failed cell (c) in a way worth recording, because the wake had actually worked:

```
     [c-screensaver-nopw] exit=4 wall=4573ms   session: activate/screensaver,wake/screensaver
     "the screen saver is up and did not clear when the Mac was nudged…"
     ScreenSaverEngine after the drive: gone
     session state after the drive: unlocked
```

The saver was gone and the session unlocked *4 s after the drive gave up on it*. The wake loop had been polling `screenSaverRunning()`, which reads `$.NSWorkspace.sharedWorkspace.runningApplications` — a **KVO-backed cache that refreshes when the process returns to its run loop**, which an osascript sitting in a polling loop never does. The saver bit was therefore frozen `true` for the whole life of that script no matter what happened on screen.

`CGSessionCopyCurrentDictionary` has no such problem: it is a fresh window-server read on every call. It is also the authoritative signal — macOS keeps `CGSSessionScreenIsLocked` set for exactly as long as the saver covers the screen, in every state measured here — so the wake loop watches the **dictionary**, and when it clears, the stale process-list bit is corrected rather than believed. Cell (c) passed on the next run, in 3.3 s.

This is a general caution for any long-lived JXA hop in this repo: process-list reads are point-in-time, dictionary and AX reads are live.

---

## 3. The gate costs no hop

The lock question rides the preamble's `activate` — the first SCRIPT any gated recipe runs — instead of a spawn of its own. The pre-seed preflight in the promote composites asks it only once the SESSGATE reachability probe (which runs anyway) says something is already wrong; a locked session cannot produce an AX-visible window, so the happy path never reaches the question. Measured on the direct arm, same guest, same fixtures, both bundles:

| operation | hops before | hops after | the lock hop's own ms, before | after | drive ms (sum of hops) |
|---|---|---|---|---|---|
| `area reorder LOCKSCR2-A3 --first --dangerously-drive-gui` | **7** | **6** | 42 | **0** | 2,201 → 2,108 |
| `todo make-repeating … --frequency weekly --interval 1` | **16** | **14** | 94 | **0** | 2,531 → 2,433 |

`make-repeating` sheds **two** hops because it asked twice — once in the composite's pre-seed preflight and once in the drive — and both are gone. The 42 ms / 94 ms are the guest's numbers; the field's are LOCKSCR1's 221–289 ms for the same spawn, which is what the maintainer measured and what this removes.

The refusal path still spends what it needs to: a locked `make-repeating` pays one 60 ms lock hop *after* the reachability probe has already established that something is wrong (cell b2, 3 hops, 454 ms end to end).

### 3.1 What now runs before the gate

The preamble's `reveal` — a `things:///show?id=` URL opened through LaunchServices. It reads no window inventory and changes no data, so nothing it does can be mistaken for the evidence the gate exists to supply, and the refusal's *"Nothing was changed"* still holds. `area reorder` has no reveal at all: its first step IS the activate, so its gate is exactly as early as it was.

A gated recipe with no `activate` in its preamble would fall back to the standalone probe hop. There is none today; the fallback exists so a future one cannot silently lose the gate, and it is unit-covered.

---

## 4. The cells — both arms

`FAILURES: 0` on each. `LOCKSCR2-A1…A3` are synthetic areas and `LOCKSCR2-REP1…4` synthetic to-dos, all minted while unlocked.

| cell | what | direct (v4) | routed (v4h) |
|---|---|---|---|
| **0** | the Aqua-session wrapper re-enters as uid 501 | ok | ok |
| **a** | happy-path hops, before vs after (§3) | reorder **7 → 6** hops, `make-repeating` **16 → 14**; lock hop 42/94 ms → **0** | after half only — reorder **5** hops, `make-repeating` **13**; lock hop **0** |
| **e** | window ⌘W-CLOSED, screen unlocked | **exit 0**, 4,402 ms, `A1` first, note *"Things had no open window, so one was reopened to run this — it was left open"*, **1** standard window afterwards | **exit 0**, 4,352 ms, same note, 1 window |
| **c** | SCREEN SAVER, `-screenLock off` | session reads **`screensaver`**; **exit 0**, 3,309 ms, `A3` first, note *"the screen saver was up and was dismissed to run this — the Mac did not ask for a password, and the screen is awake now"*; saver gone, session `unlocked` | **exit 0**, 3,304 ms, identical note and end state |
| **d** | screen saver, `-screenLock immediate` | **exit 4**, 4,598 ms — *"the screen saver is up and did not clear when the Mac was nudged, so the Mac is asking for a password"*; saver STILL RUNNING, sidebar unchanged | **exit 4**, 4,663 ms, identical |
| **f** | window closed AND hard-locked | **exit 4**, **330 ms**, the LOCK sentence — the session question outranks the inventory, and the no-window sentence never fires | **exit 4**, **358 ms**, identical |
| **b** | LOCKED: `area reorder` | **exit 4**, **282 ms**, `blocked:H-UI-SESSION-UNREACHABLE`, *"the screen is locked…"*, sidebar unchanged | **exit 4**, **317 ms**, identical |
| **b2** | LOCKED: `todo make-repeating` | **exit 4**, 454 ms, the same clause with *"Nothing was created"*, **no rule written** | **exit 4**, 566 ms, identical |

The routed arm's hop counts are LOWER than the direct arm's, not higher, and that is DEPOBS1 rather than anything in this batch: helpers 1.4.0 host the settle ledger, so a routed drive's cross-hop waits are socket round-trips instead of osascript hops. The lock column is 0 in both, which is the claim under test.

**The broker accepted every script in the batch.** The routed arm's `deputy.log` records **200** `osascript` calls, `ok: true` on every one, `rejected-script` on none — including the saver nudge, whose `CGEventPost` is the first synthesized KEY event this project posts at the global HID tap.

The two success notes, verbatim, as they ride a `notes` array:

```
"the screen saver was up and was dismissed to run this — the Mac did not ask for a password, and
 the screen is awake now"
"Things had no open window, so one was reopened to run this — it was left open"
```

and the refusal a saver that would not clear produces:

```
Refused to drive the Things window: the screen saver is up and did not clear when the Mac was
nudged, so the Mac is asking for a password. Nothing was changed.
  remediation: Unlock the Mac and re-run.
```

**Cell d is what makes cell c mean something,** and cell f is what makes the reopen rung safe: the rung fires only on a session PROVEN unlocked, so a closed window behind a lock screen still gets the lock refusal rather than a reopen attempt nobody could see.

### 4.1 A lab sequencing artifact worth naming

On the first pass, a `make-repeating` started immediately after a sidebar drag refused `blocked:environment — a dialog is already open in Things`. The drag leaves something in the AX tree that the open-dialog preflight reads as a sheet for a few seconds. It is a cell-ordering artifact rather than an operation under test — the cells now settle 6 s between a drag and a composite — but it is a real reading of the real census and is recorded here in case it turns up in the field as a spurious refusal on back-to-back GUI commands.

---

## 5. What this campaign does NOT establish

- **The maintainer's own re-run.** Lab certification is not field confirmation ([AGENTS.md](../../AGENTS.md), issue lifecycle): #732 stays open until the reorder is re-attempted on the M1 that reported it.
- **A real display.** Every measurement here is on a headless (`--no-graphics`) Tart guest. The saver runs and the window server sets its keys, but a Mac with a physical display asleep may need the display to wake before the same key lands — the closed loop degrades correctly if so (the dictionary does not clear, the drive refuses), but the *success* case is unconfirmed on real hardware.
- **A saver dismissed onto a full-screen Space.** Untouched; SESSGATE's `window`/`session` discriminator still owns that case.
- **The reopen rung for the DIALOG-class ops.** `make-repeating` and its siblings still take SESSGATE's *"Things has no open window"* refusal when there is no window — the rung shipped here lives in the sidebar drag ladder, which is where #732 was reported. Extending it is a separate decision, deliberately not taken inside this campaign.
- **Multi-user / fast-user-switching.** `kCGSSessionOnConsoleKey` was `true` throughout.

## Reproduce

```sh
# the three exploratory rounds
TART_HOME=/Volumes/Workspace/tart bash lab/scripts/research-lockscr2.sh
TART_HOME=… VM=lockscr2probe2 ROUND=probe2 SKIP_PHASE3=1 bash lab/scripts/research-lockscr2.sh
TART_HOME=… VM=lockscr2probe3 ROUND=probe3 PHASE1=shift-nopw PHASE2=shift-nopw PHASE3=shift-pw \
  bash lab/scripts/research-lockscr2.sh

# certification
TART_HOME=… LOCKSCR2_BEFORE_DIST=/path/to/base/dist bash lab/scripts/research-lockscr2-cert.sh
TART_HOME=… RC_DIST="$PWD/dist" GUEST_CELLS=lab/guest/lockscr2-cells.sh \
  bash lab/scripts/stage5-rc-run.sh
```

Artifacts (gitignored): `lab/artifacts/lockscr2probe*/` and `lab/artifacts/lockscr2cert/` — `report.txt` (the full transcript), `out/*.json` (per-cell envelopes) — and `lab/artifacts/things-rc-stage5-*/` for the routed arm, whose `deputy.log` is the second witness that the broker accepted every script in this batch.
