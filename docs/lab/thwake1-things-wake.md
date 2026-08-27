# THWAKE1 — waking a dormant THINGS, prompt-free and out of the way

**Probed under: `things-lab-golden-v4` · Things 3.23 (build 32300036) · DB v27 · macOS 15.7.7 · guest clock pinned 2026-07-05 (never rolled — the trial wall is 2026-07-18).** One disposable clone (`thwake1-lab`), destroyed at the end. Driver: [`lab/scripts/research-thwake1.sh`](../../lab/scripts/research-thwake1.sh), probe [`lab/scripts/aedet.py`](../../lab/scripts/aedet.py):

```sh
TART_HOME=/Volumes/Workspace/tart bash lab/scripts/research-thwake1.sh
```

A **one-cell mechanism certification** for the fix to [#617](https://github.com/mikegreiling/things-api/issues/617) — the Things-target twin of [SEWAKE1](sewake1-system-events-wake.md)/[#610](https://github.com/mikegreiling/things-api/issues/610). No fixture is touched and nothing is written to the library: the subject is the launch and the determination.

---

## The claim under test

`AEDeterminePermissionToAutomateTarget(askUserIfNeeded: false)` — the deputy's prompt-free Automation probe (`deputy/src/tcc.swift`) — answers **procNotFound (-600)** for a target that is not running, which the deputy relays as `automation.things: "not-running"`. Unlike System Events, Things is not reaped by macOS; it is simply **closed whenever the user is not using it**, which is most of the day. Reading that non-answer as a missing grant deactivated the deputy under `auto`, dropped the AppleScript vector onto the direct host path, and refused fully onboarded machines with `run \`things setup\``.

The fix resolves liveness before it judges authorization, and — this is the asymmetry with SEWAKE1 — only for a caller that is **about to drive the app**: the write gate and the two setup ceremonies start it, while `doctor`, the MCP startup bake and `--dry-run` report the dormancy and start nothing. Two things therefore have to be true of the wake, and this cell measures both:

1. **it resolves the determination**, prompt-free; and
2. **it stays out of the way** — a background launch must not take the foreground. That half matters here and did not for System Events, which has no UI. It is also the same pre-launch the AppleScript vector already wants: an Apple event to a CLOSED Things auto-launches it **with focus steal** (tier 2, A40/A41), while `open -g` keeps the operation at tier 0/1.

The probe is a ctypes replica of `tcc.swift`'s call — same function, `typeApplicationBundleID` address descriptor, `typeWildCard` for both event class and event id, `askUserIfNeeded: false` — because a clone has no helper bundle to ask. The TS loop and the verdict matrix around it are covered by `test/unit/deputy-wake.test.ts` and `test/unit/capability.test.ts`; what only a VM can answer is whether launch-then-determine resolves prompt-free and backgrounded.

## The guest's standing

The AXVM1 layer's Automation grants, read out of the guest's user TCC database before anything ran:

```
/usr/libexec/sshd-keygen-wrapper|com.apple.systemevents|2
/usr/libexec/sshd-keygen-wrapper|com.culturedcode.ThingsMac|2
```

`auth_value=2` for Things — the *granted* context the issue describes, and the context in which the bug bites: the grant is held and the gate still refuses.

## The cells

| cell | what it measures | result |
|---|---|---|
| **a** inventory | Things at boot; the determination for a LIVE app | **DOWN at boot.** After one background launch: `0 granted`, 16 ms; 2 windows |
| **b** the dormant state | quit Things, then the determination | `-600 not-running`, **0 ms**. Still `-600` after 5 s idle |
| **c** positive control | the same probe against a second app that is also down (`com.apple.Chess`) | `-600 not-running` — **-600 tracks LIVENESS, not the target**, so it is not a constant the wake could be credited with clearing |
| **d** THE WAKE | `open -g -b com.culturedcode.ThingsMac`, then poll the determination at the shipped 50 ms interval inside the shipped **10 s** bound for this target | launch `exit 0`; liveness `LIVE`; determination **`0 granted` on the FIRST ask, 19 ms**. Whole sequence, host wall clock with two ssh round trips included: **~550 ms** |
| **e** backgroundedness, Finder-held | frontmost + Things' window census across the launch window, with Finder activated first | frontmost read **`Things3` for every sample** — and so did the `open -a` control. **No oracle**: with only Finder and Things in the session there is nothing to lose the foreground to (the exact caveat [APPRUN1](apprun1-launch-readiness.md) records). Kept in the driver as the reason cell (e2) exists |
| **e2** backgroundedness, holder-held | the same, with **Calculator** launched and activated as a real foreground app | frontmost stayed **`Calculator` for all 8 samples** across the launch window and after it; Things came up with **1 window** |
| **e3** contrast | `open -a Things3` in the identical rig | frontmost flips to **`Things3`** for every sample, 2 windows — **the oracle can see a flip**, so (e2) is a measurement and not an absence of one |
| **f** zero dialogs | window counts for both consent-dialog agents, before and after; the beep sentinel | `CoreServicesUIAgent=0 windows` / `UserNotificationCenter=not running`, **unchanged across the whole sequence**; **0 beeps** |

**VERDICT: GREEN on both axes.** A closed Things with a held grant resolves to a real determination — `not-running` → `granted` — in one launch and one ask, with no dialog, no beep, and **without taking the foreground from the app that had it**.

## What this pins

1. **`not-running` is liveness and nothing else, for this target too.** Cell (c) shows the same probe returns it for any down app, and cell (b) shows it is answered in ~0 ms — the API does not consult TCC for a process that is not there.
2. **`open -g -b` really is background.** Cell (e2)/(e3) is a calibrated pair: the same rig, the same sampler, the same app — only the launch differs, and only the foreground launch takes the foreground. The Things window census under the background launch (1) sits inside the launch budget of 2, so nothing modal appeared either.
3. **A launch raises nothing.** `open -g -b` is a LaunchServices dispatch; it sends no Apple event, so there is nothing for TCC to gate. Held against a window-count oracle (SEWAKE1's rig note: `CoreServicesUIAgent` is resident in every session, so presence proves nothing — a prompt is a **window**).
4. **The wake is cheap enough to sit in a write gate.** One ask, 19 ms of determination, about half a second end to end across two ssh round trips. On a host with no ssh in the path it is the launch plus one socket round trip. The 10 s bound is headroom for a cold app, not a wait anyone pays.
5. **Frontmost is only an oracle when something else owns the foreground.** Cell (e) is the counterexample, and it reproduces APPRUN1's warning exactly. Any future backgroundedness claim in this lab needs a third app holding focus and a foreground control in the same run.

## What this cell does NOT cover

A golden clone has no signed helper bundle, so the deputy pair cannot be hosted in-guest and the full "onboarded helpers + closed app + routed write" path could not be run end to end here (SEWAKE1 hit the same wall). What a VM can answer — the determination's behavior, the launch's disruption, the silence — is answered above; the TS loop, the caller-purpose split, the routing deferral and the refusal copy are pinned by the unit matrix (`test/unit/deputy-wake.test.ts`, `test/unit/capability.test.ts`, `test/unit/deputy-routing.test.ts`, `test/engine/write-capability-gate.test.ts`, `test/unit/helpers-onboard.test.ts`).
