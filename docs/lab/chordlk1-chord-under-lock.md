# CHORDLK1 — the ⌘-arrow reorder chord, under a screen saver and under a lock

**Version stamp:** one clone, `chordlk1-lab`, run **2026-09-07**.

| | |
|---|---|
| golden | **`things-lab-golden-v4h`** (the routed arm — helpers installed + granted in-guest, HELPGST1) |
| Things | **3.23** (build 32300036) |
| macOS | **15.7.7** · DB **27** |
| helpers | **1.4.0**, `helpers-enabled true`, deputy + reader running, every grant on record |
| clock | pinned **2026-07-05 12:00**, never rolled (trial wall 2026-07-18) |
| network | airgapped (default route deleted, verified) |
| fixtures | fully synthetic `CLK1-*`; clone destroyed on teardown; the goldens never booted |

Driver: [`lab/scripts/research-chordlk1.sh`](../../lab/scripts/research-chordlk1.sh):

```sh
TART_HOME=/Volumes/Workspace/tart bash lab/scripts/research-chordlk1.sh setup     # clone + boot + airgap + clock + dist + helpers + fixtures
                                                            … unlocked            # the baseline
                                                            … saver               # bare screen saver, then the shipped wake
                                                            … locked              # sysadminctl -screenLock immediate + SACLockScreenImmediate
                                                            … a4                  # the URL-scheme addressing arm (run while a state is up)
                                                            … teardown
```

**PROBE ONLY — no operation was shipped or changed from this campaign.** The deliverable is this evidence; the refuse-vs-allow ruling for a locked screen belongs to the chord-reorder build track ([up-next.md](../up-next.md)).

---

## The question, and why it was open

[CHORD2 §1](chord2-reorder-laws.md) measured the whole chord gesture as **backgrounded**: the shipped AX selector sets the selection, `CGEventPostToPid` delivers the chord, Finder stays frontmost, the disruption monitor records nothing. [LOCKSCR1](lockscr1-locked-session.md) then put a session-lock gate in front of every GUI drive, and `chord-reorder` is one of the two primitives that makes a recipe gated (`recipeNeedsUnlockedSession`, `src/write/vectors/ui.ts`) — so the shipped CLI refuses when the screen is locked, before anything is posted.

Nobody had measured whether the **primitive** would have worked. [AXVM1-d](axvm1-accessibility.md) showed menu-only operations do land under a lock, and a chord is neither a menu item nor a pointer gesture — it is a key event addressed to a process id. If the gesture lands, refusing it is a policy choice worth arguing; if it does not, the refusal is simply the truth.

---

## The answers, one line per state

| state | selection set? | chord landed? | one-line answer |
|---|---|---|---|
| **unlocked** (baseline) | YES — shipped selector `OK` | **YES** | The control: the CHORD2 gesture reproduces on a v4h clone, Finder frontmost throughout. |
| **screen saver** (bare, `-screenLock off`) | **NO** by the shipped AX selector (`-1719`); the selection made BEFORE the saver survives | **YES** | **The chord lands under a screen saver** — delivery is unaffected; only ADDRESSING is lost. |
| **locked** (`-screenLock immediate` + `SACLockScreenImmediate`) | **NO** by the shipped AX selector (`-1719`); **YES** by `things:///show?id=<to-do>` | **YES** | **The chord lands under a hard lock**, and a to-do row can still be addressed — by URL, not by AX. |

And the field, in all three states: **the routed CLI refuses exactly as the gate promises** — exit 0 unlocked (the drive lands), exit **4** `blocked:H-UI-SESSION-UNREACHABLE` under both the saver and the lock, in **518–713 ms**, with zero chord or select hops in the trace and the heading order unchanged.

---

## §1 — The rig, and what "bypassing the gate" means here

`src/write/vectors/session-lock.ts` exposes **no env override** — there is no switch that makes the gate let a locked drive through, and none was added. The bypass is therefore to invoke the primitives themselves:

* the selector is the SHIPPED `axSelectRowScript(tablePath, title)`, generated from `dist/` and run over ssh under the guest's own AXVM1 Accessibility grant;
* the chord is the SHIPPED `jxaChordScript(id)` — the same `CGEventCreateKeyboardEvent` + `CGEventSetFlags` + `CGEventPostToPid` pair the ui vector posts;
* the oracle is the DATABASE (`"index"` of the project's loose to-dos), read over `sqlite3 … mode=ro`, exactly as CHORD2 read it. A chord that is delivered and DECLINED looks identical to a chord that never arrived, in the delta — so the **beep sentinel** (`THINGS_LAB_BEEPS_OK=1`) is the second witness, because a declined chord beeps 1:1 ([CHORD2 §6c](chord2-reorder-laws.md)).

Three arms per state:

* **A1 — pre-selected.** Select while UNLOCKED, enter the state, post only the chord. Isolates DELIVERY from ADDRESSING.
* **A2 / A2b — select in-state.** Run the shipped selector with the state up, then chord. A2 chords ⌘↑ and A2b chords ⌘↓ on the same selection, because A1 has just moved that row up and a second ⌘↑ can be declined for having nowhere to go — which on the delta alone is indistinguishable from a chord that never arrived.
* **A3 — the field attempt.** `project move-heading <project> <heading> --first --dangerously-drive-gui` through the routed CLI, for the refusal the gate produces.

Plus **A4**, added once A2 had answered: is there an addressing path that does not walk the window?

**One rig note.** golden-v4h does not carry golden-v4's `disruption-monitor` LaunchAgent, so the monitor slice reads "(no monitor on this golden)" throughout. The disruption question is carried here by the frontmost process read before and after every select and every chord — `Finder` in every one of them — and by the saver/lock never going away.

---

## §2 — The unlocked baseline

```
session: no CGSSessionScreenIsLocked key at all       (LOCKSCR1 §1 law 1: absence IS unlocked)
frontmost before anything: [Finder]
shipped selector -> [OK]      selection readback: [CLK1-T3]
chord ⌘↑ (shipped primitive, posted to pid): POSTED
  CLK1-T1 < CLK1-T2 < CLK1-T3 < CLK1-T4 < CLK1-T5
  ==> CLK1-T1 < CLK1-T3 < CLK1-T2 < CLK1-T4 < CLK1-T5     *** THE CHORD LANDED ***
frontmost after: [Finder]                              selection readback after: [CLK1-T3]
```

A2 repeated it on a different row (`CLK1-T5`, ⌘↑, landed). **A3 exit 0**, 3,143 ms, `vector: ui`, tier 3, the heading order moved `H1 < H2 < H3` → `H3 < H1 < H2`. **0 beeps** across the state.

That is CHORD2 §1 reproduced on a second golden and through the deputy-routed CLI, and it is what makes the two locked states mean something.

---

## §3 — The bare screen saver

Entered with `sudo sysadminctl -screenLock off -password admin` then `open -a ScreenSaverEngine` (the LOCKSCR1/LOCKSCR2 recipe). The session, in-session and over plain ssh, byte-identical (LOCKSCR1 §1 law 3 reconfirmed):

```
locked: true   lockedTime: 3930737218   secureInputPid: 154   saver: true
```

### 3.1 A1 — the pre-selected chord LANDS

```
shipped selector (unlocked) -> [OK]       selection readback: [CLK1-T3]
  … saver up, session reads locked …
chord ⌘↑: POSTED
  CLK1-T1 < CLK1-T3 < CLK1-T2 < CLK1-T5 < CLK1-T4
  ==> CLK1-T3 < CLK1-T1 < CLK1-T2 < CLK1-T5 < CLK1-T4     *** THE CHORD LANDED ***
state after the chord: ScreenSaverEngine: running; Things3: alive
session after the chord: locked:true, secureInputPid:154, saver:true
frontmost after: [Finder]
```

The saver did **not** dismiss, the session did **not** clear, Things did **not** come forward, and the rank write landed in the database.

### 3.2 A2 — the shipped selector cannot address a row

```
shipped selector (in-state) ->
  sel-row.applescript:78:85: execution error: System Events got an error:
  Can’t get window 1 of process "Things3" whose subrole = "AXStandardWindow". Invalid index. (-1719)
```

That is the SESSGATE discriminator seen from the inside: a locked session enumerates **zero windows for every process** ([#480](https://github.com/mikegreiling/things-api/issues/480), [sessgate-session-reachability.md](sessgate-session-reachability.md) §B), and the shipped selector's whole path begins `first window whose subrole is "AXStandardWindow"`. The selection from before the saver **survived** — the readback still answered `CLK1-T3` — because a selection is app state, not a window.

### 3.3 A2b — the stale selection still takes a chord

On the second pass the ⌘↑ of A2 was **declined** (its row was already at the top) with exactly **one beep** — which is itself proof of delivery, not of failure. A ⌘↓ on the same stale selection, immediately after:

```
selection readback: [CLK1-T3]
chord ⌘↓: POSTED
  CLK1-T3 < CLK1-T1 < CLK1-T2 < CLK1-T5 < CLK1-T4
  ==> CLK1-T1 < CLK1-T3 < CLK1-T2 < CLK1-T5 < CLK1-T4     *** THE CHORD LANDED ***
```

### 3.4 A3 — the routed CLI refuses, and does NOT try the saver nudge

```
exit=4  wall=586–713 ms
code:        blocked:H-UI-SESSION-UNREACHABLE
message:     Refused to drive the Things window: the screen saver is up, so no window
             can be read or clicked. Nothing was changed.
remediation: Wake the Mac (unlock it if it asks) and re-run.
trace:       "phase":"session-state","gated":true,"hop":"probe","state":"screensaver",
             "screenSaver":true,"onConsole":true,"axOps":0
chord/select hops in the trace: 0        heading order: UNCHANGED
```

Two things in that record are worth naming.

**The `screensaver` verdict fires on this build.** LOCKSCR1 recorded it as unreachable over-caution; LOCKSCR2 shipped the fused reading that distinguishes a saver from a hard lock, and here the chord op reads `screensaver` and gets the saver sentence rather than the lock sentence.

**The hop is `probe`, not `activate`, and that is why the LOCKSCR2 wake never runs.** The saver nudge lives inside the preamble loop, on the `activate` step's fused reading. A chord recipe has no `activate` step at all — CHORD2 §8.3 fence 6 and CHORDMH1 shipped it deliberately backgrounded — so it takes the `!fusedGate` branch, probes, and refuses. **A backgrounded recipe is structurally excluded from the rung that would have woken a dismissible saver for it.** That is an observation for the build track, not a defect claim: it is the price of not stealing focus, and it is invisible today because the op refuses anyway.

### 3.5 A rig control worth inheriting: do NOT zero the flags on the wake key

The shipped nudge (`jxaWakeScreenSaverScript`, run in-session) dismissed the saver and cleared the session on the first post:

```
{"lock":{"screenIsLocked":null,…,"screenSaver":false},"activated":true,"posted":true}
ScreenSaverEngine: absent      session: no lock keys
```

This rig's own hand-rolled version of the same key pair — identical except that it called `CGEventSetFlags(ev, 0)` on both events, out of habit from [CHORD2 §10.1](chord2-reorder-laws.md)'s clicking rule — did **nothing**: saver still running, session still locked, twice. CHORD2's rule ("set the flags explicitly on every event, zero included") is a rule about MOUSE events, where an inherited modifier silently changes the gesture. A **left-Shift key event carries its own modifier bit**, and zeroing the flags produces a shift press that is not a shift press. Post the shipped script, or leave the flags alone.

---

## §4 — The hard lock

Entered on the same sitting, after the saver had been dismissed and the session verified `unlocked` again, with `sudo sysadminctl -screenLock immediate -password admin` + `SACLockScreenImmediate` (`rc=0`) — the LOCKSCR1 cell-C-then-cell-B order.

```
locked: true   lockedTime: 1783257397   secureInputPid: (absent)   onConsole: true   saver: absent
```

`kCGSSessionSecureInputPID` is **absent** under the hard lock — LOCKSCR1's reading, on a session that had already hosted a saver, which is the case [LOCKSCR2 §1.4](lockscr2-session-normalization.md) had found present. So the saver-vs-lock discriminator held here.

### 4.1 A1 — the pre-selected chord LANDS under the lock

```
shipped selector (unlocked) -> [OK]     selection readback: [CLK1-T3]
  … SACLockScreenImmediate rc= 0 …      session: locked:true
chord ⌘↑: POSTED
  CLK1-T1 < CLK1-T3 < CLK1-T2 < CLK1-T5 < CLK1-T4
  ==> CLK1-T3 < CLK1-T1 < CLK1-T2 < CLK1-T5 < CLK1-T4     *** THE CHORD LANDED ***

  title     uuid8     idx
  CLK1-T3   2uDPm3eg  -2359      <- the only row rewritten
  CLK1-T1   AF44aido  -1716
  CLK1-T2   Xw8dgVaj  -176
  CLK1-T5   Gt3bUZ1a  -109
  CLK1-T4   PL6HFav8  -45

frontmost after: [Finder]      Things3: alive      ScreenSaverEngine: absent
selection readback after: [CLK1-T3]     session after: still locked
```

### 4.2 A2 / A2b — same as the saver

The shipped selector fails with the same `-1719`; the stale selection survives; ⌘↑ is declined with one beep (already at the top) and ⌘↓ on the same selection lands. **Delivery is intact under the lock; addressing through the AX tree is not.**

### 4.3 A3 — the routed CLI refuses in 518 ms

```
exit=4  wall=518 ms
code:        blocked:H-UI-SESSION-UNREACHABLE
message:     Refused to drive the Things window: the screen is locked, so no window
             can be read or clicked. Nothing was changed.
remediation: Unlock the Mac and re-run.
heading order: UNCHANGED       chord/select hops in the trace: 0
```

Verbatim LOCKSCR1's refusal, now confirmed for the chord op's own dispatch path.

---

## §5 — A4: the addressing path that DOES survive a lock

A2 reduces the whole question to one thing: with the AX tree unavailable, is there any way to set the selection? There is, for a to-do row — the URL scheme, which is not the window server's business at all.

```
session: locked:true, lockedTime:1783257397, onConsole:true

selection readback BEFORE the show: [CLK1-T3]
open -g things:///show?id=Gt3bUZ1a5T9QdHq938PX8R
selection readback AFTER the show:  [CLK1-T5]            <- the URL SET THE SELECTION
chord ⌘↑: POSTED
  CLK1-T1 < CLK1-T3 < CLK1-T2 < CLK1-T5 < CLK1-T4
  ==> CLK1-T1 < CLK1-T3 < CLK1-T5 < CLK1-T2 < CLK1-T4     *** LANDED ***
frontmost after: Finder        beeps: 0
```

Run twice, on the same locked sitting, landing both times (the second `CLK1-T1 < CLK1-T3 < CLK1-T5 …` → `CLK1-T1 < CLK1-T5 < CLK1-T3 …`). Zero beeps, Finder frontmost, the lock never cleared, Things never activated.

**So a complete single-row to-do reorder — address, deliver, verify — is possible with the screen locked**, entirely out of the window server: `things:///show?id=<uuid>` to select, `CGEventPostToPid` to chord, SQLite to verify, and `Things3 → id of selected to dos` as the selection oracle (which also answers under the lock).

### 5.1 A HEADING has no such path — A4h

The shipped op moves HEADINGS, and its selector is positional over the AX table — precisely the leg that is unavailable.

```
target heading: CLK1-H2 (A8mSxJcC8ckF7sgZG2iP4W)
open -g things:///show?id=A8mSxJcC8ckF7sgZG2iP4W
to-do selection readback: [CLK1-T5]        <- unchanged; the heading was NOT selected
chord ⌘↑: POSTED    heading order: CLK1-H3 < CLK1-H1 < CLK1-H2  ==>  unchanged
beeps: 1 (declined)
```

A heading `show` URL navigates but does not select a heading row, and the chord that followed was declined against a selection no longer in the displayed list. **`project.move-heading` has no locked-screen addressing path at all**; the to-do chord does.

---

## §6 — Beeps

| cell | marks | beeps | attribution |
|---|---|---|---|
| unlocked | 5 | **0** | — |
| saver, pass 1 | 5 | **1** | `saver A2 chord` — ⌘↑ on a row already at the top |
| saver, pass 2 (with A2b) | 6 | **2** | `saver A1 chord` (row already at the top) + `saver A2 chord` (same) |
| locked | 6 | **1** | `locked A2 chord` — the same decline |
| a4 | 2 | **0** | — |
| a4h | 4 | **1** | `a4h chord` — the declined heading chord |
| **total** | **28** | **5** | **every one a declined chord; zero unexplained.** |

Each decline beep is also a positive delivery witness: the app heard a chord it would not act on, under a saver and under a lock alike.

---

## §7 — What this campaign does NOT establish

- **A real display.** Headless (`--no-graphics`) Tart guest throughout. A Mac whose display is asleep behind the lock may behave differently; LOCKSCR2 §5 raises the same caveat for the saver wake.
- **A password-gated saver.** Only the bare (`-screenLock off`) saver was probed, plus the hard lock. LOCKSCR2 §1.4 covers the gated saver for the wake question.
- **Multi-row and heading addressing under lock.** A4 covers a single to-do by uuid. A multi-selection, a heading, and the ⌘⌥ endpoint chords under a URL-set selection are unmeasured.
- **Whether a URL-set selection is safe to build on.** `things:///show` NAVIGATES: it changes the visible list, and [CHORD2 §4bf](chord2-reorder-laws.md) makes the chord view-relative. What view `show?id=<to-do>` lands in, and whether the ±1 it produces is the one the caller's DB plan computed, is exactly the question a build cell has to answer before this path is used for anything.
- **Sync.** Airgapped clone; whether a lock-time rank write reconciles differently is untouched.
- **The field.** Lab certification is not field confirmation ([AGENTS.md](../../AGENTS.md), issue lifecycle).
- **Any ruling.** Whether the shipped ops should keep refusing under a lock, refuse with a different sentence, or offer the URL-addressed path is the build track's call, informed by §5's caveat above.

## Reproduce

```sh
TART_HOME=/Volumes/Workspace/tart bash lab/scripts/research-chordlk1.sh setup
TART_HOME=/Volumes/Workspace/tart bash lab/scripts/research-chordlk1.sh unlocked
TART_HOME=/Volumes/Workspace/tart bash lab/scripts/research-chordlk1.sh saver
TART_HOME=/Volumes/Workspace/tart bash lab/scripts/research-chordlk1.sh locked
TART_HOME=/Volumes/Workspace/tart bash lab/scripts/research-chordlk1.sh a4
TART_HOME=/Volumes/Workspace/tart bash lab/scripts/research-chordlk1.sh teardown
```

Artifacts (gitignored): `lab/artifacts/chordlk1-lab/` — `report.txt` (the full transcript), `a3-<state>.json` (the routed CLI envelopes), the generated shipped scripts (`sel-row.applescript`, `chord-*.js`, `wake.js`).
