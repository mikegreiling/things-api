# VOPAT2 — the settle observer, built: the app tells us when it has changed (#676)

**Probed under:** `things-lab-golden-v4` · Things **3.23** (build 32300036) · macOS **15.7.7** (24G720) · DB v27 · `python3` **3.9.6** with the Command Line Tools at `/Library/Developer/CommandLineTools` · clock pinned 2026-07-05 (trial wall 2026-07-18, never approached) · airgapped clone, destroyed at teardown · fixtures 100 % synthetic (`VOPAT2*`).

Driver: [`lab/scripts/research-vopat2.sh`](../../lab/scripts/research-vopat2.sh) (`setup` · `ship` · `spawn` · `appreg` · `sidecar` · `states` · `cells` · `census` · `trace` · `teardown`). Field data: the maintainer's M1, `things todo make-repeating --frequency weekly` under `THINGS_API_TRACE=1`, **elapsed 10,504 ms** on v0.20.6 (2026-09-02).

This is the BUILD campaign [VOPAT1](vopat1-screen-reader-pattern.md) was the probe for. VOPAT1 measured what Things announces and changed nothing in `src/`; this one ships the mechanism and certifies it, and it corrects VOPAT1's cost model where the build proved it wrong.

---

## What shipped

**[`src/write/vectors/ui-observer.ts`](../../src/write/vectors/ui-observer.ts)** — an `AXObserver` SIDECAR: `python3` + `ctypes` (JXA cannot marshal a C function pointer, VOPAT1 §4), one process per drive, registered on the Things **application element**, answering blocking `await` requests over a Unix domain socket. The driver MARKS the ledger's sequence before an actuation and AWAITS the observable after it, so nothing can be missed in between.

Three settle sites became notifications, two reads became skips, and one read became plural:

| | before | after |
|---|---|---|
| the Repeat dialog's arrival | `exists sheet 1` / `exists <detached window>` every 50 ms | the press hop waits for `AXSheetCreated` / `AXCreated:AXSheet` |
| a pop-up's menu opening | `exists menu 1` + `delay 0.05`, up to 6 rounds | `AXMenuOpened` (measured 3.8–25.7 ms) |
| a pop-up applying its value | nothing — the drive went straight on | `AXValueChanged` on that `AXPopUpButton` (341–507 ms), or `AXMenuClosed` when the value did not change (337 ms) |
| a field taking focus | `delay 0.15` | `AXFocusedUIElementChanged:AXTextField` |
| a keystroke landing | `delay 0.1` | `AXValueChanged:AXTextField` |
| the `Next:` pop-up absorbing a rule change | a 1.2 s budget, re-reading the control up to 13 times, in its own osascript hop | a cross-hop `await` in node — **no hop, no read** — skipped outright when the previous step announced nothing |
| the `Next:` first occurrence | open the menu, walk the cascade, click the item the pop-up already showed | ONE content read; skip the actuation when it already matches |
| `probe-dialog-shape` | 15 singular Apple events | 3 plural ones |

**The fallback is the old code, byte for byte.** With no sidecar — no Command Line Tools, `THINGS_API_AX_OBSERVER=0`, a socket that will not answer — every generated script is generated identically to the version that shipped before this campaign, and a unit test asserts the identity rather than an equivalence. Availability failure is a FALLBACK; only an armed settle that times out is a settle failure, and every settle here is SOFT (below).

---

## §1 — The production shape, decided by measurement (`spawn`)

The brief's own instruction: decide the shape by measuring spawn cost against the settle it replaces.

| | median | max |
|---|---:|---:|
| one bare `osascript` spawn | **30.4 ms** | 33.0 |
| one bare `python3` spawn (importing `ctypes`) | **18.7 ms** | 25.0 |
| arming the shipped sidecar, spawn → socket answers `hello` | **≈230 ms** (`armMs`, six drives: 218/219/229/230/243/260) | 260 |
| one settle request, node → socket | **0.10 ms** | 0.18 |
| one settle request, in-hop (`osascript` + `printf \| nc -U`) | 45.9 ms whole hop ⇒ **≈15 ms** marginal | 56.2 |

**LAW (VOPAT2-1).** *A per-settle helper cannot pay for itself.* The waits it would replace are 4–80 ms (menu open, focus, keystroke); a process to observe them costs 19–30 ms to start before it does anything, and it would have to start BEFORE the actuation to see the notification at all. **One sidecar per drive** turns a settle into a socket round-trip — 0.10 ms from node, ~15 ms from inside a hop — against a one-time ~230 ms arm.

**LAW (VOPAT2-2).** *A sidecar spawned from inside the hop inherits the hop's Accessibility identity.* `AXIsProcessTrusted()` returned true and 16 of 16 registrations succeeded, with no consent dialog and no new window, for a `python3` backgrounded by `do shell script` from the osascript the driver was already running. That is what lets this work under the deputy without a new deputy verb: Accessibility trust belongs to the RESPONSIBLE application and is assigned at spawn time (APDP1), so the sidecar is the deputy's descendant on a helper-routed Mac and the terminal's otherwise. Nothing new is granted anything.

---

## §2 — The design's load-bearing assumption, measured (`appreg`)

The sidecar registers ONCE, on the application element, for sixteen notification classes. That is sound only if the app element receives what its DESCENDANTS post. VOPAT1 §4.1 saw `AXValueChanged` arrive tagged `AXScrollBar` and `AXImage` from a registration naming neither; this cell makes it the campaign's own measurement, against the shipped sidecar and the surfaces the drive touches.

| actuation | awaited | result |
|---|---|---|
| **nothing**, 3 s | any | **0 arrivals** — sequence unchanged |
| `Items ▸ Repeat…` | `AXSheetCreated,AXCreated:AXSheet,AXWindowCreated` | **ok**, fired `AXCreated:AXSheet` |
| frequency pop-up press | `AXMenuOpened` | **ok**, fired `AXMenuOpened:AXMenu` |
| a menu item pressed | `AXValueChanged:AXPopUpButton` | **ok**, 1–3 hits among 10 arrivals |
| the same, requiring the destroyed burst | `+ AXUIElementDestroyed` | **TIMEOUT**, `missing=AXUIElementDestroyed` (twice) |
| any, since sequence 0 | `AXLayoutChanged` | **TIMEOUT** with 27 unrelated arrivals |

**LAW (VOPAT2-3).** *Application-element registration is sufficient for every surface this drive touches.* One registration, once, for the whole drive — sheets, menus and pop-ups all arrive tagged with their own role.

**LAW (VOPAT2-4) — the correction to VOPAT1-12's second half.** *`AXUIElementDestroyed` is NOT usable as a settle requirement.* VOPAT1 §4.2(g) recorded a burst of three for an after-completion → daily frequency switch, and §8 proposed *"the pop-up reports the value I set, and the children it had are gone"* as the rebuild's gate. Measured twice through an application-element registration, **the burst does not arrive**. Whether the app posts it only to an observer registered on the group itself, or does not post it for this transition, the campaign cannot say and does not need to: a settle that REQUIRES it hangs for its whole budget on a drive that is behaving perfectly. The rebuild's usable observable is the pop-up's own `AXValueChanged`, alone.

**LAW (VOPAT1-12 confirmed).** *`AXLayoutChanged` never fires.* Registered, and silent through 27 arrivals of other classes.

**NOT MEASURED, and said plainly.** The sidebar scroll bar's `AXValueChanged` (VOPAT1-7) could not be re-confirmed here: the UNSEEDED golden's sidebar has **0 scroll bars**, so the write this cell dispatched failed with AXError -1719 and the silence that followed is the silence of an actuation that never happened. The cell now prints the write's own result first, so the artefact is visible rather than mistaken for a law. It belongs to the `area reorder` build campaign, which seeds the 174-row fixture.

---

## §3 — The lifetime (`sidecar`)

An observing process that outlives what it observed is a bug, so every bounded exit is asserted rather than reasoned about.

| property | measured |
|---|---|
| handshake | `ok seq=0 trusted=1 reg=16/16` |
| wrong token | `err reason=unauthorized` |
| unknown op / no matcher | `err reason=unknownop` / `err reason=nomatcher` |
| socket permissions | `srw------- admin` (0600, owner only) |
| explicit `stop` | process gone, socket **GONE** |
| TTL (set to 4 s) | alive at t+1 s, **gone at t+7 s**, socket GONE |
| idle timeout (set to 3 s) | **gone after 7 s of silence** |
| stray sidecars after every drive cell | **none**, at every checkpoint |
| consent dialogs / extra windows | none; the window census is unchanged |

**LAW (VOPAT2-5).** *Three independent bounds, because a `finally` is not a guarantee.* The drive stops the sidecar in a `finally` no return path can skip; the sidecar itself exits on an absolute TTL and on a no-request idle timeout. A SIGKILLed drive still leaves nothing behind.

---

## §4 — What the drive costs now (`trace`)

Three shapes, each traced both ways on the same clone. **Lab wall times do not transfer to the field** (VOPAT1's own warning, and a clone is ~200× cheaper per element realized); what transfers is ROUND-TRIPS, ELEMENTS and which notifications fire, plus how long THE APP took to announce — the last of which is the floor.

### 4.1 The field's own command shape (`SHAPE=next` — `--frequency weekly` on a **scheduled** to-do)

This is the maintainer's 10.5 s command. It matters that it is the default one: `make-repeating` derives its first occurrence from the item's own scheduled date (`--when`, `repeat-flags.ts`), so the `Next:` pop-up, the shape probe and the occurrence settle are part of EVERY real drive rather than an exotic branch.

| hop | **A** poll, before | **B** poll, after | **C** observed, after |
|---|---:|---:|---:|
| arm the settle observer | — | — | 84 ms / 2 ops |
| `Items ▸ Repeat…` (the press) | 77 | 69 | 495 (settle: `AXCreated:AXSheet` at **436 ms**) |
| the Repeat dialog (census) | 455 | 452 | 81 |
| frequency = weekly | 163 / 11 ops | 129 / 11 | 726 / 18 (menu **25.7 ms**, value **507 ms**) |
| interval = 1 | 1028 / 34 | 1030 / 39 | 611 / 29 |
| **measure the dialog's shape** | **234 / 15** | **87 / 7** | **97 / 7** |
| weekdays = sunday | 155 / 9 | 113 / 9 | 115 / 9 |
| **let the pop-up absorb the rule** | **1656 / 16 / 1 hop** | **1600 / 16 / 1 hop** | **0 — no hop, no read** |
| **Next (first occurrence)** | **893 / 16** | **80 / 8** (skip) | **79 / 8** (skip) |
| pre-commit audit + commit | 403 / 21 | 293 / 21 | 285 / 21 |
| **TOTAL (hop wall)** | **5,877 ms** | **4,330 ms** | **3,186 ms** |
| **TOTAL round-trips** | **145** | **134** | **120** |

- **A → B is the READ side, and it lands on every host** (sidecar or not): −1,547 ms, −11 round-trips.
- **B → C is the OBSERVER**: −1,144 ms, −14 round-trips.
- **A → C: −2,691 ms (−46 %) and −25 round-trips**, on the shape the field runs.

(The `A` column's first census read 262 ms against 83 ms in `B` — clone noise on a busy guest. The three lines the campaign changed are 10–20× that, so the conclusion does not rest on it.)

### 4.2 The shape that TYPES (`SHAPE=types` — `--frequency monthly --interval 3`)

| hop | poll | observed |
|---|---:|---:|
| frequency = monthly | 138 / 11 ops | 736 / 18 (value **488 ms**) |
| **interval = 3** | **1,208 / 44 ops / 33 el** | **559 / 40 / 39** |
| TOTAL (hop wall) | 2,527 ms | 2,495 ms |

**The typing hop halves: −649 ms.** Both of its fixed sleeps became the app's own report (`AXFocusedUIElementChanged`, then `AXValueChanged` on the field), and the wait for the cadence group's rebuild moved OFF the typing hop and ONTO the frequency hop that causes it — which is where it belongs, and is why the frequency hop grew by about what the typing hop shed.

### 4.3 The narrow shape (`SHAPE=field` — `--after-completion`, nothing typed)

| | poll | observed |
|---|---:|---:|
| TOTAL (hop wall) | 2,598 ms | 2,972 ms |
| round-trips | 100 | 111 |
| elements | 34 | 36 |

**Slower in the lab, and the reason is worth stating.** This shape types nothing (the interval field already holds `1`, so the read-back-first skip applies) and changes no pop-up value (the dialog opens on `after completion` and the recipe selects `after completion`), so there is no fixed delay left for a notification to replace — while the observer still pays ~230 ms to arm and waits 337 ms to be TOLD the menu closed where the polling form simply carried on. In a clone, where a System Events round-trip is ~1.7 ms, that trade is a loss. On the field, where the same round-trip is ~47 ms (RDLAT2's fitted rate) and a `do shell script` stays host-local, it is not. **A campaign that only ran this shape would have concluded the opposite, which is exactly why three were traced.**

---

## §5 — Two defects the trace found, and the law they share

### 5.1 A settle waiting for a change that never comes (found, fixed, measured)

The first cut armed the pop-up settle unconditionally. The `--after-completion` drive's frequency hop then cost **2,244 ms**: `err reason=timeout ... waited=2005.1 seen=3`. `AXValueChanged` means the value CHANGED, and clicking the item a pop-up already shows changes nothing — so the settle spent its whole budget on a drive that was behaving perfectly. The dialog opens on `after completion` and the recipe selects `after completion`, so this is the commonest shape there is.

The fix is one content read: the pop-up's value, read before the click; the settle is armed only when the click will move it. **2,244 → 140 ms.**

### 5.2 …and the swallowed click that fix exposed (found, fixed, measured)

With the settle skipped outright, the cost MOVED. The next hop's first click on the after-completion unit pop-up was now dispatched while the app was still closing the previous menu, and was **SWALLOWED**: that hop's menu-open settle timed out at **1,515 ms** and the retry's click opened the menu in **4.1 ms**. The hop cost 2,181 ms — the two seconds had simply relocated.

An accidental settle had been holding a real dependency together, and making the driver faster exposed it. That is **RDLAT2 §7c arriving from a third direction**, and the remedy is never to put the accident back:

**LAW (VOPAT2-6).** *When the app has nothing to say about the VALUE, wait for what it does say about the CLICK.* A selection that changes no value still closes its menu, and `AXMenuClosed` is the app confirming it consumed the click (337.5 ms measured, 348 ms in VOPAT1 §4.2 g). With that as the unchanged-value settle: frequency hop **483 ms**, unit hop **578 ms** with its first click landing — 1,061 ms against the 705 ms the polling path spent barrelling through the same window, and against 2,181 ms for the version that skipped the wait. The polling path's equivalent is its `repeat 6 times / delay 0.05` inner poll, i.e. up to 300 ms of clock; this is 337 ms of the app's own report. **Same cost, and one of them is a closed loop.**

### 5.3 The law both share

**LAW (VOPAT2-7).** *Removing a wait is a change to a dependency, not to a duration.* Both defects took the same form: a wait that was paying for something nobody had written down. The only safe way to remove one is to replace it with a POSITIVE observable for the thing it was actually holding — never with nothing, and never with a shorter clock.

---

## §6 — The three field-reported items

The maintainer watched the drive on his M1 and reported three things. All three are addressed, and all three are read-side (they land whether or not a sidecar is available).

### 6.1 "A ~1.5 s visible pause between selecting the frequency and touching the `Next:` pop-up"

**Reproduced exactly:** the `settle-occurrences` hop, **1,656 ms**. Its cause is structural rather than a badly chosen constant. The `Next:` pop-up's recompute is announced ~0.4 s after the ANCHOR moves (NEXTPOP1 DIAG4); by the time this hop's own osascript has been spawned the announcement has been and gone, so a wait that starts HERE has nothing left to see and re-reads the control up to thirteen times to find that out.

An observer does not have that problem, because it was already listening. The settle now awaits `AXValueChanged:AXPopUpButton` **since the mark taken before the step that changed the rule** — which is why a mark is taken before every actuation — and node performs it itself: **no osascript hop and no content read at all.**

Two subtleties the build had to get right:

- **The recompute is INDISTINGUISHABLE from the anchor's own value change.** Both are `AXValueChanged` on an `AXPopUpButton`, and a notification carries a name and a role and nothing else. Returning on the first arrival would return on the anchor's own change and let the next input land inside the recompute window — the exact defect NEXTPOP1 exists to prevent, and a cancelled recompute never retries. So the settle waits for **250 ms of quiet** after the last pop-up value change, which spans both whatever their order.
- **A rule that did not change has no recompute to absorb.** Things is silent when nothing happens (VOPAT1-6), so ZERO arrivals since the previous step's mark proves that step actuated nothing — a weekday set that already matched, an anchor already on the requested day. A non-blocking `count` op answers that for free, and the settle is then skipped with `skipped: "nothing-announced"` in the trace. **The field's own shape reaches here with `seen=0`** (the scheduled date's weekday is already the weekly default), which is precisely the 1.66 s the polling form spent discovering the same thing by re-reading a control twelve times.

**Measured: 1,656 ms → 0 ms, one hop and up to 13 content reads → none.**

### 6.2 "The drive opens the `Next:` pop-up only to select the option that was ALREADY selected"

**Confirmed:** 893 ms and ~16 round-trips to open a menu, walk its cascade, click the item the control was already showing, and read it back. And it is the DEFAULT case, because `make-repeating` derives the first occurrence from the item's own scheduled date.

`select-next-occurrence` now reads the pop-up ONCE and returns the already-set token without opening anything, recording `skip reason=next-already-satisfied`. **893 → 79 ms.**

Two notes on correctness:

- **No verification is weakened.** What is skipped is an ACTUATION whose outcome is already the current state. The pre-commit audit still re-reads this pop-up through its own discriminated address, and the write pipeline still verifies the honored first occurrence against the database (#508). The step trail says `(already set)`, exactly as the typing primitives' read-back-first skip does (#620 item 7).
- **The `Today` item is handled by the same law the menu walk already uses.** The pop-up's options are the localized word for today, then the rule's occurrences as dates, then a `More…` item — so a value that will not PARSE as a date is the today item, and the app is saying the first occurrence is today. The menu walk below already takes an unparseable FIRST ITEM to be today and clicks it; the skip applies that to the same control's value, and only when today is what was asked for. Without this the skip would never fire on the commonest first occurrence of all.

### 6.3 "The `Next:` pop-up is now the norm — is the manifest treating it as primary?"

**Yes, and it always did**: `axProbeDialogShapeScript` tests the pop-up branch first and `legacy` second, both as POSITIVE matches, with `"unknown"` as the fail-closed third answer. The trace now names the verdict per drive (`phase: "dialog-shape", event: "probe", shape: "next-popup"`) rather than only the step trail, per RDLAT2's census law.

The probe is NOT removed, and that is a deliberate ruling: it is what refuses a redesigned dialog instead of pressing structural indices into a tree the driver cannot identify, and it is one hop. What it was worth attacking was its COST — 15 singular Apple events for one structural question, ~700 ms on the M1 at RDLAT2's fitted rate. Taken as three PLURAL reads (the `cgSnap` law, applied to the one script in this drive that never got it): **234 ms / 15 round-trips → 87 ms / 7**, with a length-mismatch guard so a tree that changed between the two class reads returns `"unknown"` rather than a half-picture.

---

## §7 — VOPAT1's model, corrected

VOPAT1 §8 predicted `make-repeating` at **≈2.2 s** on the M1, against RDLAT2's ≈7.6 s floor. **This campaign does not reach that, and the model is where the error is, not the build.**

That prediction was for *"R2 + a path manifest"* priced at **~77 RAW AX CALLS ≈ 9 ms** — a drive whose reads had all moved off System Events onto direct `AXUIElement` calls at ~0.05–0.12 ms apiece. The settles are a small part of that arithmetic; the TRANSPORT is nearly all of it. This PR replaces settles and two reads. The drive still speaks to the app through System Events, so it still pays ~47 ms per round-trip on the field, and 120 round-trips is ~5.6 s of round-trips alone.

**Predicted M1 delta, stated as arithmetic rather than a number:**

| term | basis | predicted |
|---|---|---:|
| the `Next:` menu walk | 8 round-trips at ~47 ms + its 0.3 s and 0.4 s fixed delays | **−1.1 to −1.5 s** |
| `settle-occurrences` | a 1.2 s fixed budget + up to 13 content reads + one process spawn | **−1.4 s** |
| the shape probe | 8 fewer round-trips at ~47 ms | **−0.4 s** |
| arming the sidecar | measured, and it is real | **+0.25 s** |
| a shape that types | 2 fixed delays (250 ms/attempt) + 4 round-trips | −0.4 s where it applies |
| **from the measured 10,504 ms** | | **≈ 7.5–8.0 s** |

**~3 s of the field's 10.5 s is still unexplained by any model this project has.** RDLAT2 fitted a ≈7.6 s floor and the machine ran 10.5 s. Nothing in this campaign closes that gap, and nothing in it should be read as claiming to.

**LAW (VOPAT2-8).** *On the Repeat sheet the transport is the cost, and the settles are the correctness.* Replacing polls with notifications is worth doing because it removes timing dependencies the doctrine forbids — and it happens to pay on the shapes with fixed delays to remove. Getting this drive to ≈2 s needs the READ LAYER moved off System Events onto raw AX, which is a rewrite of every certified address in the dialog, with its own refusal wording and its own certification. **That is a separate campaign and a maintainer decision, not a follow-up.**

---

## §8 — Certification

Everything below on the shipped bundle, through the production CLI, against the guest SQLite oracle. **0 alert beeps in every window.** Every cell run twice: once with the sidecar live (`TAG=obs`) and once with `THINGS_API_AX_OBSERVER=0` (`TAG=poll`), because the polling settle is the fallback and a fallback that is not certified is not a fallback.

### The state matrix (`states`) — every dialog state the manifest describes

| cell | drive | landed rule | obs | poll |
|---|---|---|---|---|
| S1 fixed | `make-repeating --frequency monthly --interval 2` | `fa=2 fu=8 tp=0` | **PASS** | **PASS** |
| S2 after-completion | `make-repeating --frequency weekly --interval 3 --after-completion` | `fa=3 fu=256 tp=1` | **PASS** | **PASS** |
| S3 deadlines (the #646 shape) | `make-repeating --frequency weekly --interval 1 --deadline --start-days-earlier 2` | `fa=1 fu=256 ts=-2`, deadline set | **PASS** | **PASS** |
| S4 ends-count (HXPC1) | `reschedule-repeat --frequency daily --interval 3 --ends-after 4` | `fa=3 fu=16 rc=4` | **PASS** | **PASS** |
| S5 paused | `pause-repeat` then `resume-repeat` | rule intact across both | **PASS** | **PASS** |

The rule blobs are **byte-identical between the two paths** and identical to the values RDLAT2 §9 certified.

### The guard cells (`cells`, `census`)

| cell | what it proves | obs | poll |
|---|---|---|---|
| U 2×2 | the census reads in every quadrant | **PASS** | **PASS** |
| census 2×2 (full) | `sheetKind: "repeat"`, `sheetForm: "attached"`, `sheetControls: "cb:2 pu:1 bt:2 gp:1 tf:0"` — identical in both paths | **PASS** | **PASS** |
| C2 | a drive started with a stranded dialog refuses, commits nothing | **PASS** — exit 4 `blocked:environment`, bravo non-repeating (0) | **PASS** |
| S | an already-set rule discloses the skip and types nothing | **PASS** — exit 0, template minted (1) | **PASS** |
| T | focus theft mid-drive refuses with nothing typed | **PASS** — exit 3, **byte-identical wording**, charlie non-repeating (0) | **PASS** |
| X | the MODALX1 open-dialog preflight refuses before anything is pressed | **PASS** — exit 4, delta non-repeating (0) | **PASS** |
| chord | one #606-family chord op still reorders — the shared dispatch seam is unmoved | **PASS** — `Alpha \| Bravo \| Charlie` → `Charlie \| Alpha \| Bravo` | **PASS** |
| sidecars | no observing process outlives its drive | **PASS** — none stray, at every checkpoint | **PASS** |

The **T cell** is the one that certifies the settle injection, because it is what could have broken: it refused at exactly the right step with exactly the wording it had before, including the focus role, which is present precisely because Finder was frontmost.

```
ui drive stopped at "interval = 3" (refused to run "interval = 3": Finder is frontmost and
keyboard focus is on a AXGroup, so the input would go there instead of to Things — nothing
was sent…)
```

The **census cell** is what certifies that the settle records riding stderr (`#AXSETTLE`, beside `#FGCENSUS` and `#AXELEMS`) do not disturb the census the focus guard parses off the same stream — the property RDLAT2's census law exists to protect.

### Not reachable in a clone

- **The deputy path.** A clone has no helper bundle, so the sidecar's inheritance of the DEPUTY's identity is certified only by construction (it is `do shell script` from the routed osascript, and responsibility is spawn-assigned — APDP1) plus the same mechanism working under the lab's own sshd-descended identity. The maintainer's Mac is the first host to exercise it.
- **The field's per-round-trip rate.** §7 is arithmetic against RDLAT2's fitted ~47 ms, not a measurement.
- **The scroll-bar notification** (§2) — it needs the 174-row fixture, which belongs to the sidebar campaign.

### On any host, in the unit matrix

`test/unit/ui-observer.test.ts` runs the real sidecar in `--self-test` mode (no Accessibility at all) and certifies the socket, the token, the ANY-OF/ALL-OF matcher, the role discrimination, the burst debounce, the non-blocking `count`, the explicit stop and the TTL reap — on Linux CI included. `test/unit/ui-script-syntax.test.ts` now compiles every generated script in BOTH settle shapes, because a settle snippet that does not parse would fail mid-dialog.

---

## §9 — Operator notes

**(a) A backtick in the embedded sidecar source silently breaks the module.** The `python3` source is carried in a TypeScript template literal (a bare `tsc` build would not copy an asset beside the sources to `dist`, the published package or the guest bundle — and all three have to work). A backtick in a python COMMENT therefore terminates the literal, and it bit twice during this build. `npm run typecheck` catches it, and a unit test asserts the source carries neither a backtick nor `${`.

**(b) The guest's python is 3.9.6, and a development Mac's is years newer.** A host-side `py_compile` cannot see a 3.10-only spelling, so `ship` compiles the extracted sidecar on the GUEST interpreter and aborts the run if it fails. That is the check that matters, because 3.9 is what every shipped Mac has.

**(c) A fixed fixture prefix made the oracle read the wrong row.** The `states` cell's `tmpl s1` resolved a PREVIOUS run's template (which S4 had already rescheduled), so the rule the report printed was not the rule the drive had just landed. The drives were fine; the ORACLE was wrong, which is the kind of thing that quietly certifies nothing. The prefix is now unique per run, as the `cells` cell's always was.

**(d) Latency has to be measured from the MARK, not from the await.** The first traces reported **negative** settle latencies (−0.2 ms, −0.6 ms) for the typing loop, because the notification had already arrived by the time the script got round to asking — which is the design working, and a trace that says "−0.6 ms" telling the reader nothing about what the app took. The sidecar now remembers when each mark was taken and reports `lat` from there, with `wait` beside it for the time the request itself blocked.
