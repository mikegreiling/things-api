# BANNER2 — the Repeat-dialog shape probe, driven across a fired reminder banner

**Version stamp:** one clone, `banner2-lab`, run **2026-09-07**.

| | |
|---|---|
| golden | **`things-lab-golden-v4h`** (the routed arm — helpers installed + granted in-guest, HELPGST1) |
| Things | **3.23** (build 32300036) |
| macOS | **15.7.7** · DB **27** |
| helpers | **1.4.0**, `helpers-enabled true` — every drive here is the field-shaped routed path |
| clock | pinned **2026-07-05 12:00**, never rolled (trial wall 2026-07-18); reminder times computed from the GUEST's clock |
| network | airgapped (default route deleted, verified) |
| fixtures | fully synthetic `BAN2-*`; clone destroyed on teardown; the goldens never booted |

Driver: [`lab/scripts/research-banner2.sh`](../../lab/scripts/research-banner2.sh):

```sh
TART_HOME=/Volumes/Workspace/tart bash lab/scripts/research-banner2.sh setup      # clone + boot + airgap + clock + dist + helpers + 12 targets
                                                           … L                    # the banner's LIFETIME, 2 Hz census
                                                           … p0                   # the control: no banner anywhere near the drive
                                                           … arrive N             # the reminder comes due MID-DRIVE
                                                           … standing N           # the drive starts with the banner already up
                                                           … after N              # the banner has gone (auto-dismiss, or Escape)
                                                           … census | reminders | seed N | teardown
```

**PROBE ONLY — nothing was shipped or changed from this campaign.**

---

## 0. The sighting, and the question

During the **v0.20.9 release gate** (2026-09-03, routed guest, golden-v4h) a 12:00 reminder fired while `make-repeating` was driving, and the drive's shape probe failed with AppleScript **`-1700`** on that attempt — roughly one attempt in two. [PTRGD1 §8](ptrgd1-pointer-guards.md) settled the other half of the banner question (what a banner does to a POINTER gesture) and filed this one as open: **can a banner break a dialog-shape READ**, which is an AppleScript address rather than a screen coordinate?

## The answer

**NO — not reproduced, in 8 attempts with the banner verifiably standing over the shape probe** (plus 3 with the reminder coming due mid-drive, 2 with it dismissed first, and 2 controls). Every drive exited **0**; the shape probe returned `verdict: ok` on every one; **no `-1700`, and no AppleScript error number of any kind, appears in any of the 15 traces.**

Two things were measured on the way, and both are more useful than the negative:

1. **A fired reminder banner is a DISPLAY-SIZED Notification Center window** on this build — `Notification Center L23 [0,0 1024x768]`, present only while the banner stands. It is not the small opaque window PTRGD1 §8's exemption table describes.
2. **A reminder that comes due WHILE a GUI drive is running produces no banner at all** — 3 for 3, with a 45-second census either side. The banner and the drive can only overlap if the banner was already up when the drive started.

---

## 1. Cell L — the banner's lifetime, so the phases can aim at it

One reminder armed ~150 s out, then the on-screen window census sampled at **2 Hz from fire−10 s to fire+70 s** in a single guest-side loop. Changes only:

```
t-10s: 8 windows   … Dock L20[1024x768], Things L3[40x40], Things L0[935x684]/Today
t +0s: 9 windows   … Notification Center L23[1024x768]/Notification Center …     <- the banner
t +6s: 8 windows   … (gone)
```

**The banner is on the minute and stands ~6 s**, and while it stands Notification Center owns a window; at rest it owns none (the process is not even running). That last fact is what makes a one-line detector honest here, and it is the opposite of what PTRGD1 §8's guest census showed — there, Notification Center held a display-sized window at L23 continuously. Both are the same surface; it exists while there is something to draw.

> **Cross-reference for the pointer guard, not a change to it.** PTRGD1 §8's exemption table justifies the two-part test (system-owned **AND** display-sized) partly on the ground that "system-owned only" would wave through *"a Notification Center BANNER, which is small and really does swallow the click"*. On macOS 15.7.7 the banner's WINDOW is not small — it is the whole display — so the shipped rule exempts it, and a pointer gesture aimed under a standing banner would pass the guard rather than be refused by it. Whether that is wrong depends on whether the window is click-through outside the banner rectangle, which this campaign did not measure and the guard's own authoritative leg (the AX hit test) answers first in any case. It is recorded here as the measurement; PTRGD1's evidence is left as it was written (version-stamping policy).

## 2. The rig

* **The census must run INSIDE the Aqua session.** Over plain ssh `CGWindowListCopyWindowInfo` answers an **empty list** rather than an error — a silent zero that reads exactly like "no banner is up". This rig lost its first pass to it. (And the CFArrayRef must be `ObjC.castRefToObject`'d before `ObjC.deepUnwrap`, or the same silent empty list comes back in-session too — the shipped pointer guard does the same two-step.)
* **The census runs ALONGSIDE the drive**, as a child of the same ssh command with a fixed deadline, `wait`ed on before the command returns. A banner stands for 6 s and a drive runs for 4; a census taken only before and after the drive can miss the banner entirely and report a phase that never happened.
* **The rule has to be one that emits the step.** `probe-dialog-shape` is emitted ONLY when the requested rule needs a control whose index moves with the dialog's version fork — weekdays, monthly, yearly, or an explicit next occurrence (`needsShape`, `src/write/vectors/ui-recipes.ts`). Measured on this clone: `--frequency daily --interval 1` produces a 45-record trace with **no shape op at all**. Every attempt below therefore drives `--frequency weekly --interval 1 --weekdays sunday,wednesday` (the guest clock is a Sunday, so the anchor weekday is included and the request is not fenced pre-dispatch).
* **Each attempt consumes a fresh target.** A promote is clone-and-replace, so a consumed fixture keeps its title under a new uuid with a rule attached; the driver picks the oldest `BAN2-T%` row with `rt1_recurrenceRule IS NULL`.

**Where the probe sits in a drive** (from the control, and stable to ±0.3 s across all 15):

```
+55ms   resolve            +893ms   press
+498ms  reveal             +953ms   dialog-open
+514ms  activate           +1354ms  dialog-shape {match:true, shell:1}
+581ms  session-state      +1630ms  rawax select-popup  [ok]
+818ms  assert-eligible    +3264ms  rawax probe-shape   [ok]   <- THE STEP UNDER TEST
                           +3265ms  rawax converge-weekdays [ok]
                           +3752ms  rawax audit [ok]
```

So the probe occupies roughly **+1.6 s to +3.3 s** of a ~4 s drive — comfortably inside a 6 s banner, if the two are made to overlap.

## 3. The phases, and what each one measured

| phase | n | banner vs the drive | shape probe | exit |
|---|---|---|---|---|
| **p0** — control | 2 | none within a minute | `ok` | 0, 0 |
| **arrive** — reminder due mid-drive | 3 | **the banner never appeared at all** (see §4) | `ok` | 0 ×3 |
| **standing** — banner up when the drive starts | 6 | banner present from +0 s, gone at +5/+6 s — **overlapping the probe every time** | `ok` ×6 | 0 ×6 |
| **standing, machinery off** | 2 | the same overlap, once with `THINGS_API_AX_OBSERVER=0` and once with `AX_OBSERVER=0 PREFILL=0` | `ok`, `ok` | 0, 0 |
| **after** — banner auto-dismissed first | 1 | banner fired, gone 25 s before the drive | `ok` | 0 |
| **after** — Escape posted at the banner | 1 | **Escape did not dismiss it**; it was still up at the drive → one more banner-standing attempt | `ok` | 0 |

A representative standing attempt, from the concurrent census (Notification Center present or not, per sample, seconds from the drive's start):

```
+0s NC   +1s NC   +2s NC   +3s NC   +4s NC   +5s --   +6s --  …
                         ^ probe-shape completed at +3.58s, verdict ok
```

and the same attempt's trace, which is the whole verdict:

```
"op":"probe-shape","durationMs":395,"axCalls":161,"axElems":18,"verdict":"ok"
AppleScript error numbers in the trace: (none)
```

**The DEFAULTS3 quadrants matter here and were covered.** The v0.20.9 failure belongs to the shape probe's **polling** form — the one it takes with no settle sidecar — and a routed guest normally gives it the deputy-hosted observer and the single-round form instead. Two of the eight standing attempts ran with the observer switched off (`"phase":"ui-observer","event":"unavailable","why":"switched off by THINGS_API_AX_OBSERVER"` in the trace, against `event:"armed","transport":"deputy"` in the others), one of those also with `THINGS_API_PREFILL=0`. Both took the polling form, both with the banner standing over the probe, and both returned `ok`.

## 4. The finding the negative came with: a drive suppresses the banner

Three `arrive` attempts armed a reminder and launched the drive **2 s before the fire moment**, so the banner would land inside the probe's window. In all three, the census — running at 2 Hz from 6 s before the launch to **45 s after** — never saw a Notification Center window at all:

```
armed BAN2-RA3 for 12:30 (guest epoch 1783254600, in 61s)
drive launched 12:29:58, census 12:29:52 → 12:30:43
  +1s  … Dock, Things L3, Things L0/Today
  +1s  … Things L101[159x131]   <- the Repeat dialog opens
  +3s  … Things L101[119x164]
  +4s  … (dialog gone)
  (no Notification Center window at any sample)
```

Whereas a reminder that comes due with **no drive running** produced a banner every single time (cell L twice, and the eight `standing`/`after` arms). So this is not the notification machinery going quiet part-way through the sitting — it is specific to a drive being in progress. The most likely mechanism is Things' own run loop being inside a modal sheet when its alarm comes due; the banner did not appear late either, within the 45 s the census covered.

This bounds the whole hazard: **a banner can only overlap a drive if it was already standing when the drive began** — which is a window of about six seconds, and the phase this campaign hammered.

## 5. Verdict and recommendation

* The open cell in [PTRGD1 §8](ptrgd1-pointer-guards.md) ("Second finding from the same gate") and the matching bullet in [up-next.md](../up-next.md) asked whether a fired reminder banner can break the Repeat-dialog shape probe. On Things 3.23 / macOS 15.7.7, routed, **it cannot be made to** — 8 attempts with the banner verifiably over the probe, across both observer states and both prefill states, 15 drives in total, zero failures and zero AppleScript error numbers.
* **Recommendation: retire the bullet.** The `-1700` seen once at the v0.20.9 gate is not attributable to the banner on this evidence. If it recurs, the thing to capture is the trace and the concurrent window census at that instant — this driver produces both — and the follow-up that PTRGD1 §8 suggested (a named partial verdict for the shape probe, the way FGRD2 gave the census one) is not justified by anything measured here.
* Nothing in this campaign argues against the FGRD2-style treatment on its own merits; it argues only that the banner is not the reason to do it.

## 6. What this campaign does NOT establish

- **What DID cause the v0.20.9 `-1700`.** It was seen once, on 0.20.9, and this clone runs 0.20.12 — DEFAULTS3's polling form and the routed observer path have both moved since. A negative here does not identify the original cause.
- **A real display.** Headless (`--no-graphics`) Tart guest. Banner presentation, and whether a banner ever draws differently over a modal sheet, is unmeasured on real hardware.
- **Notification style.** The guest presents Things reminders as transient banners (~6 s). The persistent "Alerts" style, and Do-Not-Disturb / Focus states, were not exercised.
- **Other dialog reads.** Only `probe-dialog-shape` was under test. `audit-dialog`, `verify-prefill` and the pointer-bearing rungs ran in every attempt and never failed, but they were not the target and no phase was aimed at them.
- **A banner from another app.** Every banner here was a Things reminder.
- **The pointer question.** Whether a display-sized Notification Center window is click-through outside the banner rectangle (see the cross-reference in §1) is untouched.

## Reproduce

```sh
TART_HOME=/Volumes/Workspace/tart bash lab/scripts/research-banner2.sh setup
TART_HOME=/Volumes/Workspace/tart bash lab/scripts/research-banner2.sh L
TART_HOME=/Volumes/Workspace/tart bash lab/scripts/research-banner2.sh p0
TART_HOME=/Volumes/Workspace/tart bash lab/scripts/research-banner2.sh arrive 1     # …2, 3
TART_HOME=/Volumes/Workspace/tart bash lab/scripts/research-banner2.sh standing 1   # …2 … 6
DRIVE_ENV="THINGS_API_AX_OBSERVER=0" \
  TART_HOME=/Volumes/Workspace/tart bash lab/scripts/research-banner2.sh standing 7
DRIVE_ENV="THINGS_API_AX_OBSERVER=0 THINGS_API_PREFILL=0" \
  TART_HOME=/Volumes/Workspace/tart bash lab/scripts/research-banner2.sh standing 8
TART_HOME=/Volumes/Workspace/tart bash lab/scripts/research-banner2.sh after 1
ESCAPE=1 TART_HOME=/Volumes/Workspace/tart bash lab/scripts/research-banner2.sh after 2
TART_HOME=/Volumes/Workspace/tart bash lab/scripts/research-banner2.sh teardown
```

Artifacts (gitignored): `lab/artifacts/banner2-lab/` — `report.txt` (the full transcript), `<phase>.json` (per-attempt CLI envelopes), `trace/<phase>.ndjson` (per-attempt `THINGS_API_TRACE=1` traces), `watch-<phase>.log` (the 2 Hz concurrent window census).
