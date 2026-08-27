# SEWAKE1 — waking a dormant System Events, prompt-free

**Probed under: `things-lab-golden-v4` · Things 3.23 (build 32300036) · DB v27 · macOS 15.7.7 · guest clock pinned 2026-07-05 (never rolled — the trial wall is 2026-07-18).** One disposable clone (`sewake1-lab`), destroyed at the end. Driver: [`lab/scripts/research-sewake1.sh`](../../lab/scripts/research-sewake1.sh):

```sh
TART_HOME=/Volumes/Workspace/tart bash lab/scripts/research-sewake1.sh
```

A **one-cell mechanism certification** for the fix to [#610](https://github.com/mikegreiling/things-api/issues/610), not a probe campaign. Things is never launched and no fixture is touched: the subject is macOS, not the app.

---

## The claim under test

`AEDeterminePermissionToAutomateTarget(askUserIfNeeded: false)` — the deputy's prompt-free Automation probe (`deputy/src/tcc.swift`) — answers **procNotFound (-600)** for a target that is not running, which the deputy relays as `automation.systemEvents: "not-running"`. System Events is an on-demand agent that macOS reaps whenever it has been idle, and the durable TCC grant does not expire with it, so a fully onboarded machine drifts into that state on its own. The GUI preflight read every non-`granted` value as a missing grant, which is why an onboarded machine was refused `blocked:environment` and steered back through `things helpers setup --gui`.

The fix (`src/deputy/wake.ts`) resolves liveness before it judges authorization: **start the target with a plain background LaunchServices dispatch, then re-read the determination.** The order is the whole point — waking the target by *sending* it an Apple event auto-launches it AND raises the consent dialog where no grant is on record, while an app launch is not a TCC-gated act at all. This cell measures whether that sequence really resolves the state, and whether it stays silent.

The probe is a ctypes replica of `tcc.swift`'s call — same function, `typeApplicationBundleID` address descriptor, `typeWildCard` for both event class and event id, `askUserIfNeeded: false` — because a clone has no helper bundle to ask. The TS loop around it is covered by `test/unit/deputy-wake.test.ts`; what only a VM can answer is whether launch-then-determine resolves prompt-free.

## The guest's standing

The AXVM1 layer's Automation grants, read out of the guest's user TCC database before anything ran:

```
/usr/libexec/sshd-keygen-wrapper|com.apple.systemevents|2
/usr/libexec/sshd-keygen-wrapper|com.culturedcode.ThingsMac|2
```

`auth_value=2` for System Events — the *granted* context the issue describes, which is exactly the context in which the bug bites: the grant is held and the preflight still refuses.

## The cells

| cell | what it measures | result |
|---|---|---|
| **a** inventory | System Events at boot; the determination for a LIVE target | **DOWN at boot** (macOS starts it on demand — the dormant state is the ordinary one, not an edge case). After one background launch: `0 granted`, 10 ms |
| **b** the dormant state | `killall "System Events"`, then the determination | `-600 not-running`, **1 ms**. Still `-600` after 5 s idle — nothing resurrects it behind the test's back |
| **c** positive control | the same probe against a second app that is also down (`com.apple.Chess`) | `-600 not-running` — **-600 tracks LIVENESS, not the target**, so it is not a constant the wake could be credited with clearing |
| **d** THE WAKE | `open -g -b com.apple.systemevents`, then poll the determination at the shipped 50 ms interval inside the shipped 5 s bound | launch `exit 0`; liveness `LIVE`; determination **`0 granted` on the FIRST ask, 10 ms** — the launch is synchronous enough that the loop never has to sleep. Whole sequence, host wall clock with two ssh round trips included: **513 ms** |
| **e** zero dialogs | window counts for both consent-dialog agents, before and after; the beep sentinel | `CoreServicesUIAgent=0 windows` / `UserNotificationCenter=not running`, **unchanged across the sequence**; **0 beeps** |

**VERDICT: GREEN.** A dormant target with a held grant resolves to a real determination — `not-running` → `granted` — in one launch and one ask, with no dialog on screen and no alert beep.

## What this pins

1. **`not-running` is liveness and nothing else.** Cell (c) shows the same probe returns it for any down target, and cell (b) shows it is answered in ~1 ms — the API does not consult TCC for a process that is not there. Reading it as an authorization state is a category error, and it is the one the preflight was making.
2. **A background launch is silent.** `open -g -b` is a LaunchServices dispatch: it never sends an Apple event, so there is nothing for TCC to gate. Cell (e) holds that against a window-count oracle rather than the agents' mere presence — `CoreServicesUIAgent` is resident in every session, so its existence proves nothing; a prompt is a **window**.
3. **The wake is cheap enough to sit in a preflight.** One ask, 10 ms of determination, half a second end to end across ssh. On a host with no ssh in the path it is the launch plus a single socket round trip.
4. **The dormant state is the DEFAULT, not a rarity.** System Events was already down on a freshly booted clone that had done nothing at all. Any design that treats `not-running` as exceptional is wrong about how often it happens.

## Rig notes

- **The dialog oracle must count windows, not processes.** The first pass asserted on `pgrep` and went RED on a clean run: `CoreServicesUIAgent` runs in every session. Presence is not a prompt; a window is.
- **`date +%s%3N` is not portable to macOS.** The first pass produced `value too great for base` from the millisecond stamp; the driver uses `python3` for wall-clock milliseconds.
- The probe prints the raw `OSStatus` beside the deputy's own label, so a future run can be compared against `tcc.swift`'s mapping without trusting the label.
