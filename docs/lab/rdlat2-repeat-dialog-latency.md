# RDLAT2 — the Repeat dialog's latency, counted in AX round-trips

**Probed under: `things-lab-golden-v4` · Things 3.23 (build 32300036) · macOS 15.7.7 · DB schema v27 · pinned clock 2026-07-05 12:00 (trial wall 2026-07-18, never rolled).** ONE disposable clone of golden-v4 (the golden is never booted), airgapped, guest muted, beep sentinel default-on, destroyed at teardown. Fixtures fully synthetic (`RDLAT2*` titles). Both lab escapes exported (`THINGS_API_UI_DIRECT=1 THINGS_API_WRITE_DIRECT=1`). Driver: [`lab/scripts/research-rdlat2.sh`](../../lab/scripts/research-rdlat2.sh) (`setup` · `ship` · `shipnew` · `micro` · `micro2` · `aeprobe` · `profile` · `census` · `s1diag` · `s1rep` · `states` · `cells` · `chord` · `teardown`); calibration [`lab/scripts/rdlat2-micro.sh`](../../lab/scripts/rdlat2-micro.sh) + [`rdlat2-micro2.sh`](../../lab/scripts/rdlat2-micro2.sh); per-hop table renderer [`lab/scripts/rdlat2-table.mjs`](../../lab/scripts/rdlat2-table.mjs). Artifacts (gitignored): `lab/artifacts/rdlat2/`.

Sequel to [DRVLAT1](drvlat1-drive-latency.md) ([#633](https://github.com/mikegreiling/things-api/issues/633)), which cut the drive from 20 osascript hops to 15 and removed the fixed post-preamble settle — a 33% win on a clone that the field never saw. The maintainer's `todo make-repeating … --after-completion` was still around eleven seconds on his M1. This campaign asks why, in the only unit that transfers between machines.

> **The number this campaign is built on.** Measured on the maintainer's M1 (2026-09-02): **~20 ms per Accessibility call, against ~1.7 ms on a clone** — 860 calls took 16–18 s there. A hop's WALL TIME on a clone is mostly its process spawn and says almost nothing about what the same hop costs in the field. A hop's ROUND-TRIP COUNT says the same thing on every host. So this campaign counts round-trips, and the driver now reports them.

---

## 1. Instrumenting the thing first (`aeprobe`)

`durationMs` per hop already ships (TRACE1 #487). What was missing was a count, and AppleScript will not tell you one. Apple's `AEDebugSends` will: with it set, `osascript` logs one line per Apple event it SENDS, which is one line per round-trip to System Events.

Two facts had to be measured before it could be used, and the second one bit:

| question | answer |
| --- | --- |
| is the count exact? | **yes** — a script that sends N events logs exactly N lines (probed at N = 1, 5, 20) |
| which stream? | **stdout**, interleaved AHEAD of the script's own result — *not* stderr |

That second one is not a detail. stdout is the stream every step's verdict is parsed from (`"true"`, `"OK"`, a frame), so a naive count breaks every drive it measures: the first instrumented run failed at the canary with `exit 3`, because `{core,cnte target='psn '…}\ntrue` is not `true`. The shipped seam therefore counts **and strips** the diagnostic from BOTH streams (`splitAeDebug`), so an armed count cannot change a single verdict or a single refusal sentence.

It ships as `THINGS_API_AX_COUNT=1`, off by default and never armed implicitly, recording `axOps` on each hop's trace record beside `durationMs`. One honest limitation: the variable rides the environment of the process that SPAWNS osascript, which on a helper-routed host is the deputy rather than the CLI. Where it is not set there, `axOps` is simply absent and `durationMs` still lands. (`things config set helpers-enabled false` puts the spawn back in the CLI, which is how the maintainer can capture counts on his own machine.)

**Counting perturbs timing** — writing those lines is not free, and the same drive measures ~6.0 s counted against ~4.3 s uncounted. So every number below comes from two passes: `AXCOUNT=1` for round-trips, `AXCOUNT=0` for wall time. They are never mixed.

## 2. Calibration — what one of anything costs (`micro`, `micro2`)

Measured against a LIVE Repeat dialog on the clone, each as a slope over repetitions rather than a single sample:

| # | what | measured |
| --- | --- | ---: |
| M1 | one `osascript` process, doing no AX work at all | **64 ms** |
| M6 | one addressed read of the open dialog (`count of checkboxes of <shell>`) | **~8.0 ms** |
| M6 | the same read through an INDEXED window instead of a `whose` clause | **~8.1 ms** |
| M6 | `count of (windows whose subrole is "AXUnknown" …)` — the detached-shell probe | ~1.7 ms |
| M7 | one cadence-group scan, one control at a time (monthly: 5 statics + 1 field) | **72 ms** |
| M7 | the same scan through PLURAL property reads | **23 ms** |
| M8 | the shell's control census as five `count of <class>` reads | **43.5 ms** |
| M8 | the same census as one `role of UI elements` list | **6.5 ms** |
| M9 | a deep inline address vs the same read with the group bound to a variable | identical (~6.2 ms) |
| M11 | `frontmost of process "Things3"` — the guard's decisive probe | 0.6 ms |

Two of those rule things OUT, and saying so is half the value of a calibration:

- **The `whose` clause is not the cost.** A first pass appeared to show a 45× penalty for the `whose`-addressed shell against an indexed one, which would have made "resolve the window index once and address it directly" the campaign's headline. It was an artifact: the indexed variant named `window 1`, and `window 1` is the *companion* window (subroles measured in order: `AXUnknown`, `AXStandardWindow`), so that script errored out immediately and "finished" in the time of a bare process. Re-run against the correct index, the two spellings are within 1%. **No window-index caching was shipped**, and the positional-address ban keeps its scalp.
- **Nesting depth is not the cost either** (M9). Binding intermediate elements to variables buys nothing; AppleScript's binding is a lazy specifier that re-resolves on use, and re-resolving is cheap.

What IS the cost is the NUMBER of reads, and the two places the driver was making many of them where one would do: **per-control property reads** (M7) and **per-class counts** (M8).

## 3. BEFORE — where the round-trips went

The field's exact command shape, traced:

```
todo make-repeating <uuid> --frequency monthly --interval 1 --after-completion --dangerously-drive-gui
```

| # | dur ms | **ax** | primitive | what it is |
| ---: | ---: | ---: | --- | --- |
| 1 | 120 | **9** | resolve | census — the pipeline's pre-drive window/focus read |
| 2 | 76 | 2 | resolve | session-reachability probe |
| 3 | 18 | — | reveal | `things:///show?id=` (no Apple event at all) |
| 4 | 70 | 1 | activate | bring Things to the foreground |
| 5 | 90 | **9** | resolve | census — the drive's open-dialog precondition |
| 6 | 83 | 2 | resolve | canary: does `Items ▸ Repeat…` resolve? |
| 7 | 86 | 3 | assert-eligible | the reveal landed an eligible selection |
| 8 | 70 | 1 | press | `Items ▸ Repeat…` |
| 9 | 431 | 2 | wait | the Repeat dialog appears |
| 10 | 128 | **9** | select-popup | frequency = after completion |
| 11 | 561 | **17** | select-popup | after-completion unit = monthly |
| 12 | 944 | **38** | set-group-number | interval = 1 |
| 13 | 60 | 1 | resolve | which shell does the audit read? |
| 14 | 308 | **19** | audit-dialog | the pre-commit audit (CGRD1) |
| 15 | 85 | 4 | press | press "OK" |

**Totals: 15 hops · 117 AX round-trips · 4,254 ms end to end (uncounted median of three).**

Ranked, that is a very different story from DRVLAT1's:

| bucket | round-trips | share | what it is |
| --- | ---: | ---: | --- |
| the interval step | 38 | 32% | its folded census (9) + the cadence group scanned FOUR times, one control per read |
| the pre-commit audit | 19 | 16% | another settle scan, plus a scan per numeric control |
| the two pop-up selections | 26 | 22% | mostly the menu-open poll, one `exists` per 50 ms round |
| the two censuses | 18 | 15% | five `count of <class>` reads each, plus the focus probe |
| everything else | 16 | 14% | reachability, canary, eligibility, both presses, the wait, the audit's shell resolve |

The interval step is a third of the budget on its own, and almost none of it is the keystroke: `--interval 1` is the default the dialog already shows, so that hop READ the dialog thirty-eight times and typed nothing.

## 4. What changed

### (a) One inventory, four Apple events

`AX_CADENCE_HANDLERS` asked the tree one control at a time — `count of static texts`, then `value of static text 1`, `value of static text 2`, … — which is a round-trip PER CONTROL, per scan, and `cgField` ran three such scans on top of the settle's two. AppleScript answers a PLURAL property in one event, so the whole inventory is now four events regardless of how many controls the group holds: values and positions of the static texts, values and positions of the text fields.

Every law is unchanged and now computed from that one snapshot: the `Every`-row positive match, the `Ends:`-row rule, the after-completion uniqueness fallback, the fail-closed inventory in every refusal. It is also strictly MORE coherent — the row discrimination now reasons about one instant rather than about a series of reads taken over ~70 ms.

The two reads of a class are still two events, so a tree that changes between them can answer different lengths. That is reported as an INVALID snapshot and treated as *not yet settled*, never as a shape.

`cgSettle` now RETURNS the snapshot it proved stable, instead of returning `true` and leaving every caller to read the group again. The addressing decision is made on the very instant the settle vouched for.

### (b) The census reads one role list, and skips decoration it will not print

The dialog shell's control census was five `count of <class>` round-trips (43.5 ms); it is now one `role of UI elements` list (6.5 ms), counted in-script. System Events derives each of those classes from exactly that `AXRole`, so the numbers are identical by construction — and measured identical in every dialog state (§5).

And the focus probe — the most expensive read in the census, ~3.5× an addressed one ([FGRD2 §2](fgrd2-census-hardening.md)) — now runs only when Things is NOT frontmost, for the operational census (the guard prelude, the drive's open-dialog preflight, the promote orchestrator's pre-seed probe). It is not a check traded for speed: with `frontIsThings` true the focused element's role appears in NO sentence any consumer produces, because the guard renders it only while refusing and it refuses on `frontIsThings` being false. The secure-system-modal signal is untouched — a macOS consent dialog owns the screen, so that probe still runs whenever one is up. The DIAGNOSTIC census (`things doctor --ui-state`, rescue, the cleanup ladder's disclosure) keeps every probe.

That last one also removes a stall: measured, reading `AXFocusedUIElement` of Things while its OWN modal sheet is up does not answer, and burns the full 2 s probe budget (visible in §5 as `stalledProbes: ["focus"]` on U3/U5 — in BOTH bundles, since the diagnostic still asks). The guard no longer asks a question it cannot use.

### (c) The dialog wait became a dialog CENSUS — the shape manifest's gate

The `wait` step proved that one control resolved and said nothing else. It is now `dialog-open`, and for one extra Apple event it answers two questions at the moment the dialog opens:

- **which shell** — the 1-based index of the candidate that answered (attached sheet, or the detached editor). Every later step then addresses THAT shell instead of probing both, and the pre-commit audit needs no resolution hop at all — closing the open item [DRVLAT1 §8](drvlat1-drive-latency.md) left.
- **what shape** — the shell's direct-child AX roles, matched against the manifest (`src/write/vectors/ui-shape.ts`). A shell whose census has moved is a REDESIGNED dialog, and the drive refuses rather than pressing structural indices into it.

See §6 for what the manifest is and what it is deliberately not.

### (d) The audit COMMITS

The pre-commit audit and the OK press were two hops with a driver round trip between them — a window in which the thing just audited can change. The press now happens inside the audit's own script, past the mismatch check, so what is committed is the state the audit read with nothing dispatched in between. A commit failure carries its own tag, so "the audit refused" and "the OK button would not press" are never reported as each other. The step is still named in the trail, because it still happened.

The date-area leg (JXA, and so unable to carry the commit) moved AHEAD of the AppleScript leg for the same reason: nothing may commit while a control is still unaudited.

### (e) The typing loop waits for focus instead of refusing on the first miss

This one is a bug the campaign CAUSED and then found, and it is the most interesting thing here. See §7.

## 5. AFTER — the same fixture, the same trace

| # | dur ms | **ax** | primitive | what it is |
| ---: | ---: | ---: | --- | --- |
| 1 | 78 | **4** | resolve | census — the pipeline's pre-drive read |
| 2 | 73 | 2 | resolve | session-reachability probe |
| 3 | 20 | — | reveal | `things:///show?id=` |
| 4 | 93 | 1 | activate | bring Things to the foreground |
| 5 | 69 | **4** | resolve | census — the drive's open-dialog precondition |
| 6 | 88 | 2 | resolve | canary |
| 7 | 89 | 3 | assert-eligible | eligibility |
| 8 | 68 | 1 | press | `Items ▸ Repeat…` |
| 9 | 455 | 4 | dialog-open | the dialog appears — waited for AND censused |
| 10 | 120 | 9 | select-popup | frequency = after completion |
| 11 | 516 | 17 | select-popup | unit = monthly |
| 12 | 603 | **24** | set-group-number | interval = 1 |
| 13 | 270 | **15** | audit-dialog | the pre-commit audit **and the OK press** |

**Totals: 13 hops · 88 AX round-trips · 3,335 ms end to end (uncounted median of three: 3,350 / 3,320 / 3,335).**

| | OLD | NEW | delta |
| --- | ---: | ---: | ---: |
| osascript hops | 15 | **13** | −2 (−13%) |
| **AX round-trips** | **117** | **88** | **−29 (−25%)** |
| osascript wall | 3,247–3,442 ms | 2,539–2,543 ms | ≈ −800 ms |
| **end to end** (`elapsedMs`) | 3,972 / 4,254 / 4,279 | **3,350 / 3,320 / 3,335** | **≈ −920 ms, −22%** |

The two censuses went 9 → 4 each, the interval step 38 → 24, the audit 19 + 1 resolve hop + 4 press round-trips → 15 in one hop.

**The census reads identically** — this is the cell that had to answer for §4(b), and it caught a real regression on the way (§7b). Verdicts on the new bundle, byte-for-byte the baseline's:

| cell | verdict | control census |
| --- | --- | --- |
| U1 no dialog, Things frontmost | `Things is frontmost; no dialog is open in Things` | — |
| U2 no dialog, Finder frontmost | `Finder is frontmost; no dialog is open in Things` | — |
| U3 Repeat dialog, Things frontmost | `Things is frontmost; the Repeat dialog is open (attached)` | `cb:2 pu:1 bt:2 gp:1 tf:0` |
| U4 Repeat dialog, Finder frontmost | `Finder is frontmost; the Repeat dialog is open (attached)` | `cb:2 pu:1 bt:2 gp:1 tf:0` |
| U5 deadlines TICKED (the #646 shape) | `Things is frontmost; the Repeat dialog is open (attached)` | `cb:2 pu:1 bt:2 gp:1 **tf:1**` |
| U6 after dismissal | `Things is frontmost; no dialog is open in Things` | — |

## 6. The shape manifest — what it is, and what it deliberately is not

The maintainer's proposal was to cache the dialog's tree. The dialog does not have a tree: it has a tree PER STATE. Ticking "Add deadlines" mints a text field on the shell ([#646](https://github.com/mikegreiling/things-api/issues/646)/[CNCAC2](cncac2-deadline-lift.md)); selecting an ends bound INSERTS a numeric field ahead of the interval ([HXPC1](hxpc1-picker-assert.md)/#589); switching the frequency rebuilds the cadence group outright ([BEEP1](beep1-numeric-field-beep.md)). So the manifest (`src/write/vectors/ui-shape.ts`) is not a cache of a tree — it is the EXPECTATION the measured laws produce for a given state, in two forms with two very different safety postures.

**1. The SHELL census — an ASSERTION, checked once, at the open.** The Repeat dialog's control census is the one thing about it that does NOT depend on the rule state: exactly two checkboxes, one direct pop-up, two buttons, one group, and at most one direct text field — measured across every state in [CGRD1 §B](cgrd1-precommit-audit.md), and the same for the detached editor ([DRVLAT1 §5](drvlat1-drive-latency.md)). It is therefore assertable exactly at the open, and a shell that does not present it fails the drive closed, naming what it saw. This is new: the drive previously satisfied itself that `pop up button 1` resolved and pressed on.

**2. The CADENCE-GROUP shape — ADVISORY, and only where it discriminates.** This is where the manifest could have done harm, and where the campaign's second self-inflicted bug lives (§7c). The settle's whole job is to wait out a group that is being rebuilt; letting a shape MATCH end that wait is sound only when the shape is one the PREVIOUS state could not also have had. Two states qualify:

| state | expectation | why it discriminates |
| --- | --- | --- |
| after completion | 1 field, and NEITHER `Every` nor `Ends:` | no fixed frequency can look like it (CGRD1 §A law 2) |
| ends-after | **2** fields, `Every` + `Ends:` present | no other state shows two — the bound inserts the count (§A law 3) |
| any other fixed frequency | **none** | `Every` + `Ends:` + one field either side of the rebuild — indistinguishable, so the manifest says nothing and the two-agreeing-reads rule decides alone |

Where an expectation exists the settle now WAITS for it *and* for it to hold still, and refuses if it never arrives. That is strictly stronger than what shipped: agreement alone is the absence of movement, which is also what a group looks like before the step's own input has taken effect.

**Invalidation** is the app version, read once per process from the bundle's `Info.plist` (prompt-free — the bundle, never the data container) and matched as a prefix. `3.23` covers 3.23, 3.23.1 and 3.23.2: the dialog was redesigned at 3.23 ([RDLG2](rdlg2-323-recipe-cert.md)) and the point releases have not moved it, which the shell assertion re-proves on every single open. An unrecognized build asserts nothing, takes no fast path, and runs the full per-step discrimination exactly as it did before this module existed. The runtime match remains the authority; the version key exists so a KNOWN-foreign build is never measured against expectations that were never about it.

**Fail direction throughout:** a shell mismatch on a covered build REFUSES; a shell mismatch on an uncovered build is a trace record and nothing more; a cadence mismatch is never a refusal by itself — the step that follows it refuses on its own discriminated address, as it always did. Every mismatch is recorded in the trace (`phase: "dialog-shape"`) with the roles seen, the version, and whether the manifest covered it.

## 7. Three bugs this campaign found — two of them its own

### (a) The instrumentation broke the thing it measured

`AEDebugSends` writes to **stdout**. See §1. Found on the first instrumented run, before any conclusion rested on it.

### (b) `repeat with x in <expression>` — the census stopped recognizing its own dialog

The role-list census (§4b) shipped correct for the shell and WRONG for the cadence group, because the group's loop iterated an anonymous expression (`repeat with rl in (role of UI elements of g)`) while reassigning the loop variable, and the enclosing `try` swallowed the failure. `groupOk` stayed false and every open Repeat dialog censused as `sheetKind: "other"`.

Nothing failed. All five state-matrix drives passed with the bug in place, because the per-step guard compares the sheet kind against the kind it latched — and it had latched `"other"` too. What silently stopped working was everything that needs to know WHICH dialog is open: the MODALX1 open-dialog preflight, and the cleanup ladder's "is this dialog ours to dismiss?" test. Caught by the `census` cell (§5), which exists precisely because a census change must be shown to be invisible. The list is now bound before it is walked.

**Lesson for the AX-drive scrutiny law:** a census change needs a cell that reads the census, not just drives that pass. A drive passing is compatible with the census being wrong in a way that only matters later.

### (c) The two-agreeing-reads settle was measuring the driver's own read cost

Making the reads cheap (§4a) broke the fixed-frequency interval step **deterministically — 0 of 5** — with `refused to type "2": the field did not take keyboard focus`. The `s1diag` cell (the shipped script text, emitted from each staged bundle and run against a hand-driven dialog — the CGRD1 §C test seam) showed BOTH bundles' scripts working in isolation, which put the cause in the driver's timing rather than the script's logic.

The mechanism: after a frequency switch, the rebuilt interval field exists, is positioned, and reports a stable shape signature for a while before it will accept keyboard focus. The settle's two agreeing reads were 0.1 s of `delay` PLUS however long two reads took — ~144 ms of reads on a monthly group, so ~244 ms in total, which happened to be long enough. Four plural events instead of eighteen singular ones cut the same wait to ~150 ms, and the field was not ready. **The guard had been measuring the driver's own read cost.** That is exactly the timing dependence the [UI-automation determinism doctrine](../design/decisions.md) forbids, and it was invisible for as long as nothing made the reads faster.

The fix is not to slow the reads down. The readiness is now waited for POSITIVELY, on the observable itself: ask for focus, look, and if the field has not taken it, ask again on the next attempt of the retry loop that was already there. Nothing is typed without proven focus — that property is unchanged, and is what makes the retry safe — and a field that never accepts focus still refuses, in the same words, once the attempts are spent. **5 of 5** after the fix (`s1rep`; the baseline bundle is 3 of 3, so the cell discriminates).

The same class bit the ends-count step once more: the settle returned a *stable, stale* one-field group before the `Ends: after` selection had inserted the second field, and the step refused with `0 field(s) on the "Ends:" row`. That is what made the manifest's cadence expectation a WAIT rather than a shortcut (§6).

## 8. The cost model, and what it predicts for the field

```
wall  =  spawns x S  +  round-trips x C  +  in-script settles  +  the app's own time
```

`S` and `C` are the only host-dependent terms, and only `C` moves much:

| term | clone (measured) | field |
| --- | ---: | --- |
| `S` — one osascript process | 64 ms | + the deputy's socket round-trip and its own spawn |
| `C` — one Apple event to System Events | ~8 ms | the term this campaign moves |

The clone cannot measure `C` for the field, but there is one field datapoint to fit against: **11,337 ms** for this command shape under v0.19.3 ([M1](https://github.com/mikegreiling/things-api/issues/633)), whose 20-hop shape made ≈ the same number of round-trips as the 15-hop shape measured here — DRVLAT1 folded hops together without removing the reads inside them, which is precisely why the field did not see its 33%. Taking DRVLAT1's own removals off that (the 1,003 ms fixed settle, five hops' spawn + deputy) puts today's shipped bundle at **≈ 9.3 s** in the field, and solving

```
9,300  =  15 x S_field  +  117 x C_field  +  (settles + app time, ~1.9 s)
```

with `S_field ≈ 124 ms` (the clone's spawn plus a warm socket round-trip) gives **`C_field ≈ 47 ms` per Apple event — about 5.9× the clone's 8 ms.** That is consistent with the maintainer's per-raw-call measurement without being identical to it: an Apple event to System Events is several raw AX calls plus host-side IPC, and only the AX half scales.

Carried across at that fitted rate:

| | round-trips | hops | predicted field wall |
| --- | ---: | ---: | ---: |
| v0.19.3 (the measured 11.3 s) | ~117 | 20 | 11,337 ms *(measured)* |
| v0.20.3 (DRVLAT1 shipped) | 117 | 15 | ≈ 9,300 ms |
| **this change** | **88** | **13** | **≈ 7,600 ms** |

**Stated assumption:** the model treats in-script settles and the app's own animation as host-independent and carries them over unchanged, which makes the prediction a FLOOR, not an estimate — a field host is slower at those too. Two caveats in the honest direction:

- **Poll-bounded hops do not scale linearly.** The two pop-up hops spend most of their 26 round-trips polling for the menu to open, one `exists` per 50 ms. On a host where each poll costs ~47 ms the loop self-throttles to fewer, longer rounds for the same wall-clock wait — so their contribution is over-counted above, and the real field saving is a little larger than the round-trip arithmetic suggests.
- **The deputy adder is inferred from the code path, not from a stopwatch.** A clone has no deputy to time.

**The next field trace settles it**, and it can be read directly against this table: `THINGS_API_TRACE=1` gives per-hop `durationMs`, and `THINGS_API_TRACE=1 THINGS_API_AX_COUNT=1` (with `helpers-enabled false`, per §1) gives `axOps` beside it. If the per-hop counts match §5 and the durations divide out to ~47 ms per round-trip, the model holds.

## 9. Certification

Everything below on the NEW bundle, in the same clone, through the production CLI, against the guest SQLite oracle. **0 alert beeps** across every cell set.

### The state matrix (`states`) — every dialog state the manifest describes

| cell | drive | landed rule | verdict |
| --- | --- | --- | --- |
| S1 fixed | `make-repeating --frequency monthly --interval 2` | `fa=2 fu=8 tp=0` | **PASS** |
| S2 after-completion | `make-repeating --frequency weekly --interval 3 --after-completion` | `fa=3 fu=256 tp=1` | **PASS** |
| S3 deadlines (the #646 shape) | `make-repeating --frequency weekly --interval 1 --deadline --start-days-earlier 2` | `fa=1 fu=256 ts=-2`, deadline set | **PASS** |
| S4 ends-count (HXPC1) | `reschedule-repeat --frequency daily --interval 3 --ends-after 4` | `fa=3 fu=16 rc=4` | **PASS** |
| S5 paused | `pause-repeat` then `resume-repeat` | rule intact across both | **PASS** |

### The guard cells (`cells`) — the semantics the change must not have weakened

| cell | what it proves | verdict |
| --- | --- | --- |
| U1–U6 | the census reads identically in every quadrant, incl. the deadlines-ticked shape | **PASS** (§5) |
| C2 | a drive started with a stranded dialog refuses, commits nothing | **PASS** — exit 4 `blocked:environment`, bravo non-repeating (0) |
| S | an already-set rule discloses the skip and types nothing | **PASS** — exit 0, template minted |
| T | focus theft mid-drive refuses with nothing typed, dialog cleared by its own Cancel | **PASS** — byte-identical wording (below) |
| X | the MODALX1 open-dialog preflight refuses before anything is pressed | **PASS** — exit 4, delta non-repeating (0) |
| chord | one #606-family chord op still reorders — the shared dispatch seam is unmoved | **PASS** — `Alpha \| Bravo \| Charlie` → `Charlie \| Alpha \| Bravo` |
| s1rep | the fixed-frequency interval step, 5 consecutive drives | **PASS** — 5/5 (baseline 3/3) |

The **T cell** is the one that certifies §4(b), because the census change could have broken it. It refused at exactly the right step with exactly the wording it had before — including the focus role, which is present precisely because Finder was frontmost and the decoration therefore ran:

```
ui drive stopped at "interval = 3" (refused to run "interval = 3": Finder is frontmost and
keyboard focus is on a AXGroup, so the input would go there instead of to Things — nothing
was sent…)
```

### Not reachable in a clone

The **shell-mismatch refusal** would take a redesigned Things, so it is certified in the unit matrix instead (`test/engine/write-ui-vector.test.ts`): a moved census refuses with nothing pressed on a covered build, and is unremarkable on an uncovered one. The **detached-shell** addressing is likewise unit-certified — the shipped recipe activates first, so its dialog is always the attached sheet ([DRVLAT1 §5](drvlat1-drive-latency.md)).

## 10. What this campaign did NOT do

- **The two pop-up hops keep their 26 round-trips.** Most of that is the menu-open poll, which is a closed loop on the menu's existence and self-throttles on a slow host. Collapsing the `exists menu item` + `click menu item` pair into one `try click` would save one round-trip per pop-up and would blur "no such item" into "the click failed"; not worth it.
- **The frequency / unit / interval hops were NOT folded into one process.** Three spawns and two candidate preludes are recoverable that way (~2 more hops), but it costs the per-step trace granularity and the per-step failure attribution that make the field reports readable. Measured and left, deliberately.
- **The interval step's read-back-first skip keeps its two reads a settle apart** (the UIC7 re-layout revert gate) even though the settle's own snapshot already holds the field's value. A certified gate is not worth one round-trip.
- **It did not measure the deputy.** §8 names that adder from the code path.
