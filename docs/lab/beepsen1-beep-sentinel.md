# BEEPSEN1 — the beep sentinel: a macOS alert beep is now a FAILURE STATE for every lab suite

**Probed under: `things-lab-golden-v4` · Things 3.23 (build 32300036) · DB v27 · macOS 15.7.7 · guest clock pinned 2026-07-05 (never rolled — the trial wall is 2026-07-18).** One disposable clone (`beepsen-lab`) for cells V1–V4, destroyed at the end; cell V5 is a real `npm run lab:run` against its own clone. All fixtures synthetic (`BEEPSEN1-*`). Driver: [`lab/scripts/research-beepsen1.sh`](../../lab/scripts/research-beepsen1.sh):

```sh
TART_HOME=/Volumes/Workspace/tart CELLS="V1 V2 V4" VM=beepsen-lab KEEP=1 bash lab/scripts/research-beepsen1.sh
                                  CELLS="V3"       …  REUSE=1 SKIP_BUILD=1     # the real shipped drive
npm run lab:run -- --suite lab/suites/x-suite.json                             # V5, the wired runner
```

[BEEP1](beep1-numeric-field-beep.md) proved the ORACLE and fixed the two beeps it found. This campaign certifies the HARNESS PIECE built on that oracle — the sentinel that makes a beep red rather than merely regrettable — and it is a certification, not a discovery: the thing under test is `lab/guest/beep-sentinel.sh`.

**Verdict: the sentinel counts exactly, attributes to the step, fails by default, and reports-without-failing under the opt-out. One real trap was found and closed on the way (§2).**

---

## 0. What shipped

| Piece | Where |
|---|---|
| `beep-sentinel.sh reset \| mark <label> \| assert [--allow N] [--json PATH] [--name NAME]` | `lab/guest/beep-sentinel.sh` |
| Marks per probe PHASE (`<id> setup` / `<id> commands` / `<id> cleanup`), one `assert` per run → `beeps.json` | `lab/guest/probe-runner.py` (all eight `lab:` suites) |
| Host-side gate: a nonzero unallowed count turns the run RED, prints each offending line, records `beeps` in `run-meta.json` | `lab/runner/run.ts` (`judgeBeeps`) |
| Marks per STEP (`[<n>] <description>`), assert before the result line | `lab/guest/e2e-write-smoke.sh` (+ the sentinel shipped beside it by `lab/scripts/e2e-write-smoke.sh`) |
| Opt-out, accounting-preserving | `THINGS_LAB_BEEPS_OK=1` |

**Post-hoc, never a live listener.** BEEP1's rig ran `log stream` in the background for the duration of a gesture; a standing harness may not, because a detached listener survives an abort. `mark` writes a timestamp; `assert` reads the window back out of the already-written unified log with ONE `log show`. Nothing runs between them, so there is nothing to orphan — and the cost of a mark is a `date` call, which is why marks can be per-step.

---

## 1. The four cells

| cell | what ran | beeps | sentinel exit | verdict |
|---|---|---|---|---|
| **V1 liveness** | `mark` · 3 deliberate `osascript -e beep` · `assert` | **3** | **1** | FAIL, as required — and each line printed with its timestamp, its attributed mark, and the raw `systemsoundserverd` message (`actionID 4096, inClientPID …(osascript)`) |
| **V2 clean window** | `mark` · nothing · `mark` · `assert` | **0** | 0 | clean |
| **V3 a REAL shipped drive** | fixture (URL add + AX Repeat-dialog promote, REPX2/REPX3-style) then the production CLI twice: `todo reschedule-repeat --frequency weekly --interval 2 --weekdays tuesday` and `--frequency daily --interval 5 --ends-after 9`, both `THINGS_API_UI_DIRECT=1 --dangerously-drive-gui` | **0** | 0 | clean — both drives `CLI-EXIT=0`, "drove 10 step(s)" each, so the numeric fields really were driven |
| **V4 opt-out** | `THINGS_LAB_BEEPS_OK=1` · `mark` · 2 deliberate beeps · `assert` | **2** | **0** | REPORT-ONLY: the count and both log lines still print, the exit is 0 |

V1 is the positive control that makes V2 and V3 mean anything: an oracle that cannot see a deliberate beep proves nothing about a quiet run (BEEP1 §1's rule, kept). V1 and V3 ran on the SAME clone in the same session, so V3's zero is a measured silence, not an absence of measurement.

V3's exact console lines:

```
warning: drove 10 step(s): … the Repeat dialog → frequency = weekly → interval = 2 → … → weekdays = tuesday → press "OK"
CLI-EXIT=0
warning: drove 10 step(s): … the Repeat dialog → frequency = daily → interval = 5 → ends = after → ends after = 9 → press "OK"
CLI-EXIT=0
BEEP-SENTINEL [V3]: 0 alert beep(s) in the window (allowed 0; 2026-07-05 12:03:43 → 2026-07-05 12:03:58, 4 marks) — clean
```

This is the post-#590 confirmation from the other side: BEEP1 measured the fix with its own rig; the shipped sentinel now measures the same drive and agrees.

### 1.1 V5 — the wired runner, end to end

`npm run lab:run -- --suite lab/suites/x-suite.json` (its own fresh clone, teardown included):

```
== X01 … ok   == X03 … ok   == X04 … ok
BEEP-SENTINEL [x]: 0 alert beep(s) in the window (allowed 0; 2026-07-05 12:00:22 → 2026-07-05 12:00:39, 10 marks) — clean
[19:20:03] beep sentinel: 0 alert beep(s) — clean (…)
run x-…: GREEN
```

Ten marks for three probes: one `suite start` plus setup/commands/cleanup each. `guest-run/beeps.json` and `guest-run/beep-marks.tsv` are collected into the run artifacts, and `run-meta.json` carries `"beeps": 0`.

---

## 2. THE TRAP: `log show`'s own time bounds do NOT window a clock-pinned clone

The first implementation windowed with `log show --start <first mark> --end <now>` and nothing else. It read **6** beeps in V1's three-beep window and **6** in V2's *empty* one — the same three strangers in both:

```
· 2026-07-05 12:13:43 · systemsoundserverd: SSServerImp.cpp:733 -> Incoming Request : actionID 1393, inClientPID 831()
· 2026-07-05 12:17:13 · systemsoundserverd: … actionID 4096, inClientPID 695(Shortcuts)
· 2026-07-05 12:38:44 · systemsoundserverd: … actionID 4096, inClientPID 695(Shortcuts)
```

Those are **the golden's own log history** — beeps from a session months earlier, during the image's construction. They survive into every clone because the unified log store is part of the disk image, and they are *stamped inside the window* because **every clone pins its clock to the same date**: 12:13 on 2026-07-05 in a build session and 12:00 on 2026-07-05 in this run are the same displayed timeline. `log show`'s time bounds did not exclude them; neither did `--last 30m` (measured directly: 19 matching lines either way).

Two filters close it, and the sentinel applies both:

1. **`bootUUID` — the real discriminator.** Every ndjson record carries one; `sysctl -n kern.bootsessionuuid` names the current boot. The strangers carried `EA5FEA49-…` against this boot's `5E6FFEBE-…`. `log show --start` stays, but only as a cheap prefilter — never as the window.
2. **The window is applied against the MARKS**, in the analysis step, using the record's displayed timestamp: `first mark − 1s ≤ t ≤ assert time + 2s`. Within one boot the displayed clock is consistent, so this is exact.

A third, smaller correction came out of the same cell: BEEP1's signature is the `SSServerImp.cpp:733` line **with `actionID 4096`**, and that qualifier matters. The stranger at 12:13:43 is an `actionID 1393` — a different system sound on the identical line. The sentinel requires both, so it counts alert beeps rather than "audio happened".

**A rule for any future guest-side log oracle, not just this one: in a lab clone, timestamps are not identity. Pin to `bootUUID`.**

### 2.1 The corollary that bit the driver

`research-beepsen1.sh` originally re-pinned the clock (`sudo date 070512002026`) on every invocation, including `REUSE=1` attaches. Because the sentinel windows by guest timestamp, the rewind dragged the PREVIOUS cell's beeps back inside the next cell's window — V1 read 6 (three real, three its own, from the run before). The driver now pins only when the clock is not already inside the pinned month. Real runs pin once at bootstrap and never meet this, but any campaign that re-attaches to a live clone must not rewind the clock underneath its own evidence.

---

## 3. The standing rules (now harness law)

- **Default ON.** Every `lab:` suite and the write-layer e2e assert zero beeps. No suite sets the opt-out.
- **Fail closed.** A missing `beeps.json`, an absent sentinel, or a `log show` that errors is RED, not "probably fine". Silence from an oracle that is not running is not evidence of a quiet run.
- **Opt-out is for probe/research drivers only, and it is not a mute.** `THINGS_LAB_BEEPS_OK=1` downgrades the gate to accounting: the count and every offending line still print. Probes are exempt from failing, never from counting.
- **Attribution is the point.** Marks are per probe-phase (suites) and per step (e2e), so the failure names what beeped rather than that something did.

## 4. What this campaign did NOT do

It did not run `lab:regress`. The eight-suite sweep currently has an unrelated known red — the write-layer e2e's AppleScript-vector steps refuse in a clone under the Wave A write gate ([harness.md](harness.md) §The UI-vector lab escape, CNC1 §9) — so a full sweep could not have distinguished a sentinel defect from that gap. V5 exercises the identical runner path on a suite that is green today; the e2e wiring is the same two calls (`beep mark` in `run_step`, one `assert` before the result line) and is covered by V1/V2's certification of the primitive rather than by a full smoke run.
