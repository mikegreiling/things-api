# Probe harness — how a lab run works

The harness executes **probe suites** (JSON, `lab/suites/`) against a fresh clone of the frozen golden image and judges every probe against locked expectations. It is the machine that produced/re-validates the capability matrix, and later the CI regression gate (any verdict/tier delta = a Things update moved the write surface).

## Golden images (index)

The runner clones the **active** golden by name (`lab/runner/run.ts` `GOLDEN`) and asserts its schema fingerprint against the matching `docs/lab/golden-v<N>-metadata.json`.

The fingerprint is a function of the golden's schema AND of the depended-column manifest (`src/db/schema.ts`), so **every manifest edit re-records it in all four metadata files and in the table below** or `lab:run` aborts at bootstrap (exit 5). Last re-recorded 2026-08-23 (`784bd2f6…` → `d2b7e98c…`) for the template spawn cursor + tally; the columns are pre-existing in every golden, so the value is fixture-derived and the next bootstrap is its verification.

| Golden | Things | DB | AX layer | Status | Notes |
|---|---|---|---|---|---|
| `things-lab-golden-v4` | **3.23** (build 32300036) | **v27** · `sha256:d2b7e98c…` (unchanged — the migration is index-only) | L3-accessibility granted | **ACTIVE + CERTIFIED** | Built 2026-08-22 in-place from a v3 clone (DRIFT-1): Things 3.22.14→3.23 swap; the warm-up launch RAN the 26→27 migration in-lab. sdef byte-identical to 3.22.11; all v3 human-seeded layers inherited via APFS COW and re-verified. **Certified 2026-08-22**: `lab:regress` GREEN across all eight suites + the 132-step write-layer e2e, the assumption register walked row by row, SIMFID re-certified host-side and against a fresh v4 clone. 3.23 is NOT a behavioral no-op update — the private reorder command became accepted-and-inert, so the ordering laws that rest on it are recorded SUSPENDED rather than re-confirmed, and the o-suite now locks the inertness as a behavioral canary ([gv4-323-certification.md](gv4-323-certification.md), [golden-v4-metadata.json](golden-v4-metadata.json), [gv4-323-campaign.md](gv4-323-campaign.md), [rdlg2-323-recipe-cert.md](rdlg2-323-recipe-cert.md)). |
| `things-lab-golden-v3` | **3.22.14** (build 32214000) | v26 · `sha256:d2b7e98c…` | **L3-accessibility granted** (sshd-keygen-wrapper, `auth_value=2`) | **CERTIFIED fallback** (the last pre-3.23 golden — the arm every version-conditional expectation is checked against) | Built 2026-08-16 in-place from a v2 clone (drift-runbook DRIFT-1 path): Things 3.22.12→3.22.14 swap (schema + sdef byte-identical — behavioral-only update), all v2 human-seeded layers + the AXVM1 grant inherited via APFS COW. `lab:regress` GREEN, zero flips; the two reported 3.22.14 field regressions (#479/#480) do NOT reproduce in-lab ([golden-v3-metadata.json](golden-v3-metadata.json), [gv3-certification.md](gv3-certification.md)). |
| `things-lab-golden-v2` | 3.22.12 (build 32212016) | v26 · `sha256:d2b7e98c…` | L3-accessibility granted | **retained fallback** | The prior certified golden, kept as the fallback until v3 is confirmed in production use. Built 2026-08-03 in-place from a v1 clone (3.22.11→3.22.12 swap; AXVM1 grant baked) ([golden-v2-metadata.json](golden-v2-metadata.json)). |
| `things-lab-golden-v1` | 3.22.11 (build 32211007) | v26 · `sha256:d2b7e98c…` | none | **superseded-pending-deletion** | Retained on disk (~25 GB reclaimable). Deletion is the maintainer's call ([golden-v1-metadata.json](golden-v1-metadata.json)). |

The **AXVM1 L3-accessibility layer** (new in v2) grants Accessibility to the sshd-osascript responsible process so future sittings can synthesize real UI input (clicks/drags/keystrokes via System Events / CGEventPost) — see [axvm1-accessibility.md](axvm1-accessibility.md) for the recipe and [golden-v2-metadata.json](golden-v2-metadata.json) `axvm1Layer` for the 3.22.12 verification record (menu-bar read exit 0, `count windows`/keystroke succeed, the AXVM1-d Pause-by-name payoff smoke flips `rt1_instanceCreationPaused` 0→1, grant persists across reboot). It unblocks the parked AX-dependent residuals (template-drag byte-capture, forecast-row GUI-drag capture, the reschedule-bounce mechanism, the §6 `.ips` crash capture) — a separate follow-up sitting on this golden.

> **Troubleshooting — an intermittent tier 0 → 3 on the FIRST probe of a `running-background` suite (RESOLVED 2026-08-22).** A bare `window-new` titled `Today` with `launch = false`, `activated = false` lands inside the first probe's evidence window and, with no launch to budget it, reads tier 3. It appeared on the GV4 sweep (A10 + R01), did NOT appear on RDLG2's a-suite run, and reappeared on the 3.23 certification regress — the signature of a RACE, not a behavior change. Cause, measured: a background launch always ends with Things opening its main window, but HOW LONG that takes is a per-version property — Things 3.23 takes **~3.5s** from launch to `window-new`, while the guest's app-state enforcement returned after a fixed **~3.0s** (a 2.0s post-launch settle plus a 1.0s Finder-activate settle). The window was always coming; the enforcement simply stopped waiting just before it arrived. **Fixed with a closed loop, not a longer sleep** (`wait_for_main_window` in `lab/guest/probe-runner.py`): the enforcement polls `count windows` until the window exists, so no probe's tier can depend on how fast the host booted. This also corrects [gv4-323-campaign](gv4-323-campaign.md) §3.3, which read the same signature as a 3.23 behavior change ("the app materialises a list window on first touch") and left it for the maintainer to rule on — there is no new app behavior and no tier law to record.

> **THE TRIAL WALL — no guest clock on or after 2026-07-18 on golden-v4 (REPX3, 2026-08-23).** Every golden carries a **trial** build of Things, and clones pin the clock to the golden's `pinnedDate` precisely so the trial never expires. A campaign that *rolls the clock forward* spends that margin: golden-v4's `firstAppLaunchDate` is **2026-07-03 03:14 UTC** with a 15-day window ([gv4-323-campaign](gv4-323-campaign.md) §Trial clock), so **2026-07-18 is the wall**. Past it the app raises *Your Trial Period Has Ended* and runs read-only — **it stops spawning repeat occurrences and silently drops every write**, which is indistinguishable from an app-behavior finding until you dump the AX tree (REPX3 wrote up a fake "the weekly series stops spawning" result before catching it). The state is **STICKY**: rolling the clock back does NOT clear the dialog, so the clone is burned and the campaign restarts. Rule for every clock-rolling driver: refuse the roll rather than trusting the operator — `research-repx3.sh`'s `setclock` compares the target date against a `TRIAL_WALL` constant and returns non-zero with the reason. A campaign that genuinely needs dates past the wall needs a golden with a fresh trial clock (the [drift runbook](drift-runbook.md) DRIFT-1 path notes the same trial-clock inheritance caveat from the other direction).

> **Troubleshooting — the Settings-window (`⌘,`) AX flake (RESID1 R-AXRETRY, 2026-08-06, golden-v2 / 3.22.12).** BACKDT could not open the Settings panel via System Events (menu enumeration worked; neither `⌘,` nor a menu-item click surfaced the window), and it parked this as a possible golden-v2 residual. RESID1 confirmed it is **clone/state-local, NOT a golden-v2 capability loss**: the HEADSORT recipe `keystroke "," using command down` opens `window "General"` fine on a fresh clone, and the log-interval `AXPopUpButton` is reachable. The failure reproduces only as **stale-window state** (after repeated open/close via `⌘W`, a later `⌘,` returns `-1728 Can't get window "General"`). **Fix: quit + relaunch Things before driving Settings** (`osascript -e 'tell application "Things3" to quit'; sleep 3; open -a Things3; sleep 6`) — with a clean window state `⌘,` opens the panel on attempt 1, reproducibly. Two more gotchas: `things:///preferences` does NOT surface a settings window (no such URL route); and the General tab has **four** `AXPopUpButton`s (`Today · Automatic · Immediately · Daily`), so the log-interval popup is **not identifiable by value** once flipped to Daily (a second, unrelated `"Daily"` popup exists) — target it by **enumeration index #3** (value `"Immediately"` at the default). Reusable recipe: [`lab/scripts/research-resid1.sh`](../../lab/scripts/research-resid1.sh) `axid`/`axflip`.

> **Attaching the durable Things Cloud account needs no VNC on 3.23 (SYNCX1, 2026-08-23, golden-v4).** SYNC2B and SYNC3 drove the login by VNC pixel coordinates captured on golden-v2's 2048×1536 framebuffer; those coordinates are dead on golden-v4 (a `--vnc-experimental` clone reports a 1024-wide screen) and the pane was redesigned. Under the AXVM1 grant the whole ceremony is reachable with System Events + `CGEventPost`, which is both more portable and self-describing: `⌘,` after a quit+relaunch (RESID1) opens Settings → `AXPress` the toolbar button titled `Things Cloud` → the enable control is an **untitled `AXButton id=_NS:35`** beside the cloud logo → the account sheet is a **WEB AREA**, so `Log In` / `Create Account` / `Forgot Password?` are web buttons and the credential fields are an `AXTextField` titled `Email Address` and one with `sub=AXSecureTextField` titled `Password` — **address them by AXTitle, never by role index** (a role-index drive hit the email field twice and concatenated the two secrets) — and the merge choice is three `AXRadioButton`s (`Keep all to-dos` / `Keep only the to-dos from Things Cloud` / `Keep only the to-dos from this Mac`) plus a `Continue` button. **Every step must be POLLED, not slept on:** on a cold clone the sheet shows an `AXBusyIndicator` for several seconds before any control exists, and a fixed sleep raced it (device B's first attempt drove an empty sheet and silently produced no account). The secret never needs to reach an argv — pipe it over ssh stdin into the guest's `pbcopy` and paste with ⌘V. Reusable driver: [`lab/scripts/research-syncx1.sh`](../../lab/scripts/research-syncx1.sh) (`login_account`, `wait_ax`, the `axtool.jxa` `clicktf`/`press`/`clicklabel` verbs).

> **A networked clone must have its clock pinned BEFORE Things is ever launched, on EVERY boot** (SYNCX1). Multi-phase sync campaigns stop and restart the same clone repeatedly, and a guest reboot returns the clock to real time — which on golden-v4 is months past the trial wall above. The boot helper pins first and only then launches; a single launch in between burns the clone stickily and there is no recovery.

## The UI-vector lab escape (`THINGS_API_UI_DIRECT=1`)

Since the permissions doctrine's [Article IV](../design/permissions-doctrine.md), a shipped host may drive the Things window **only through the helper pair** — the signed identities that hold Accessibility + Automation → System Events. A golden clone has neither: no helper bundle is installed in it, and there is nobody at the screen to answer a consent dialog. What a clone *does* have is the **AXVM1 layer** — an in-guest Accessibility grant on the runner's own sshd-descended processes ([axvm1-accessibility.md](axvm1-accessibility.md)) — which is exactly the direct driving Article IV forbids on a user's Mac.

`THINGS_API_UI_DIRECT=1` is the documented escape for that one situation, and **not consumer surface**: nothing in the CLI/MCP copy mentions it and no consumer path sets it. It restores direct UI-vector availability and nothing else — in particular it does **not** bypass `ui-enabled`, so a clone still runs `things config set ui-enabled true` as it always did.

Where it is exported:

| Site | What it covers |
|---|---|
| `lab/guest/e2e-write-smoke.sh` | the guest e2e bundle — every `things` call the write-layer smoke makes |
| `lab/scripts/env.sh` (`$LAB_UI_DIRECT`) | the prefix every **bash campaign driver** must put in front of a guest CLI invocation that exercises a ui-vector op: `lab_ssh "$IP" "$LAB_UI_DIRECT $CLI …"` |

A driver that forgets it gets a clean `blocked` (exit 4) naming `things helpers setup --gui`, never a hung dialog — the refusal is the fail-closed outcome, so a forgotten prefix shows up as a red probe rather than a wedged VM.

Unit and simulator suites are unaffected and must NOT use this: they exercise ui-vector logic with fake vectors, which are ungated because the gate keys on the vector's declared `drivesGui` flag rather than on its id (a fake declares nothing and drives nothing).

> **VERIFIED end to end, and bounded, 2026-08-24 (CNC1, golden-v4).** The escape does what it claims: with `THINGS_API_UI_DIRECT=1` a shipped pure-ui op (`todo pause-repeat`) drives in a clone and the pause lands in the database; without it the same call is a clean **exit 4** naming `things helpers setup --gui`, with nothing driven and no dialog — the fail-closed outcome, not a wedged VM. **But the escape covers the UI vector ONLY, and the lab now has a second gate.** Wave A's write gate (`writeCapability`, `src/capability.ts`) returns `direct-unknown` whenever `host.bundleId === null`, which is every sshd-descended guest shell, so **the AppleScript vector is blocked unconditionally in a clone** — `doctor` in-guest reads `applescript direct-unknown`, and every AppleScript-vector verb (and every composite with an AppleScript leg, `make-repeating` and `add-repeating` included) refuses with `blocked:environment`. Reads (`direct-fda`), the URL scheme and Shortcuts are unaffected. Campaign drivers that need a repeating fixture must therefore build it the REPX2/REPX3 way — a URL-scheme add plus a direct AX Repeat-dialog drive — until a write-vector escape exists. `lab/guest/e2e-write-smoke.sh` exports the ui escape and nothing else, and its last green run predates the gate, so its AppleScript steps are expected to block on the next `lab:regress`. See [cnc1-template-mutations.md](cnc1-template-mutations.md) §9.

> **An off-screen row's AX frame is a LOADED GUN for synthetic clicks (CNCAC1, 2026-08-24, golden-v4).** [REPX1 §1.2](repx1-instance-semantics.md) established the `CGEventPost`-at-the-AX-frame click as the live vector for Things' custom-drawn content rows, and it works — but the AX frame resolves whether or not the row is scrolled into view, so a blind click at a row below the fold lands on the **desktop** and the cell reports *"(no field changed on any surviving row)"*. That reads exactly like an app finding, and CNCAC1's first pass shipped one before catching it: an Upcoming window `@[44,25 935x684]` whose scroll area ends at y=673, and a projection checkbox resolving at y=818. Two rules, both now in `research-cncac1.sh`'s copy of `clickrow.jxa` and worth lifting into any driver that clicks: (1) **walk `AXParent` up to the row's own `AXScrollArea` and refuse** when the target centre falls outside that rect — return `OFF-SCREEN`, click nothing, and let the cell fail loudly; (2) **reveal before clicking** — `things:///show?id=<uuid>` both selects the row and scrolls it into view — then re-resolve the frame. And the standing doctrine that catches it even when both are forgotten: **a click cell needs a POSITIVE CONTROL**, a target whose actuation is already known, run in the same window in the same pass. A zero delta from an unproven vector is not evidence of anything.

> **Counting macOS ALERT BEEPS in a headless, muted clone (BEEP1, 2026-08-25).** There is no NSBeep hook under SIP, but two oracles track system alerts 1:1 and — the part that matters here — **neither is blinded by `lab_mute_guest`**, which every clone-boot path applies. (a) The unified log: `systemsoundserverd` emits exactly one `SSServerImp.cpp:733  -> Incoming Request : actionID 4096` per play request; a muted guest simply logs `SSServerImp.cpp:774  Device is currently muted` beside it. (b) `sudo fs_usage -w -f filesys`, filtered IN THE GUEST (unfiltered it is megabytes a second), counting `open` calls on a distinctively-named alert sound installed with `defaults write -g com.apple.sound.beep.sound /System/Library/Sounds/Submarine.aiff`. **Validate POSITIVELY before judging anything** — three deliberate `osascript -e beep` calls must read exactly 3 and a matched quiet control 0; an oracle that cannot see a deliberate beep proves nothing about a drive. Two gotchas: the predicate must be SUBSYSTEM-scoped, since the app never plays its own alert (`process == "Things3"` matches nothing), and `log stream --style ndjson` output must be windowed against the gesture's own start/end stamps. Reusable rig: [`lab/scripts/research-beep1.sh`](../../lab/scripts/research-beep1.sh) (`measure.sh` runs both oracles plus the gesture inside ONE ssh invocation, so nothing is ever orphaned; `count.py` does the windowing and the signature count).

## The beep sentinel — an alert beep is a FAILURE STATE (BEEPSEN1, default ON)

A macOS alert beep means the app was handed a gesture it declined to handle — a keystroke a disabled menu item swallowed, a click on a control being rebuilt ([BEEP1](beep1-numeric-field-beep.md)). The drive can still "succeed": the value lands, the probe goes green, and the user hears an error tone. So the harness **counts beeps and reds the run on any it did not expect**, exactly like a failed assertion. Certified in [beepsen1-beep-sentinel.md](beepsen1-beep-sentinel.md).

`lab/guest/beep-sentinel.sh` is the guest-side helper. Three verbs, no state beyond a marks file:

```sh
beep-sentinel.sh reset                  # drop marks from a prior run
beep-sentinel.sh mark "<label>"         # stamp the guest clock; the FIRST mark opens the window
beep-sentinel.sh assert [--allow N] [--json PATH] [--name NAME]
```

**Post-hoc, never a live listener** — no detached `log stream`, ever. `mark` costs one `date` call, so marks can be per-step; `assert` reads the whole window back with ONE `log show`, attributes each beep to the most recent mark at or before it, prints the matched log lines, and exits 1 on an unallowed count (2 if the oracle itself failed). Where it is wired:

| Site | Granularity | Gate |
|---|---|---|
| `lab/guest/probe-runner.py` → all eight `lab:` suites | a mark per probe PHASE (`<id> setup` / `commands` / `cleanup`) | guest writes `beeps.json`; `lab/runner/run.ts` (`judgeBeeps`) turns the run RED and prints the offending lines. `run-meta.json` records `beeps` |
| `lab/guest/e2e-write-smoke.sh` | a mark per step (`[<n>] <description>`) | counted into `FAILURES` before the result line |

**Fail closed.** A missing `beeps.json`, a sentinel that did not ship, or a `log show` error is RED — silence from an oracle that is not running is not evidence of a quiet run.

**Opt-out — `THINGS_LAB_BEEPS_OK=1` — is for research/probe drivers only, and it is NOT a mute.** It downgrades the gate to accounting: the count and every offending line still print (probes are exempt from FAILING, never from COUNTING). Both `lab:run` and the e2e orchestrator forward it from the host env; no suite sets it.

> **In a lab clone, log timestamps are not identity — pin to `bootUUID`** (BEEPSEN1 §2). The unified log store is part of the disk image, so every clone inherits the golden's own log history — and because every clone pins its clock to the SAME date, those old entries are stamped inside the current run's window. `log show --start/--end` does not exclude them and neither does `--last` (measured: three beeps from a months-old build session returned in an *empty* window). The sentinel therefore treats `--start` as a cheap prefilter only, requires `bootUUID == sysctl kern.bootsessionuuid`, and applies the real window against its own marks. It also requires BEEP1's full signature — `SSServerImp.cpp:733` **with `actionID 4096`** — because other system sounds share that line. Any future guest-side log oracle inherits this trap.

## Animation settings — standing config for the NEXT golden mint (PERF2)

Reduce Motion + disabling automatic window animations measurably speed sheet presentation — the Repeat dialog's present+settle roughly HALVES on a golden clone (~532 → ~260ms, PERF2 S6, [perf2-step-latency.md](perf2-step-latency.md)). When the next golden is minted, consider baking these into the image so ui-vector drives (and the certification suite) run faster:

```sh
defaults write com.apple.universalaccess reduceMotion -bool true
defaults write -g NSAutomaticWindowAnimationsEnabled -bool false
```

**CERT-PARITY caveat (non-negotiable):** the golden / cert clones must match the PRODUCTION host's animation state. The maintainer's desktop currently runs animations ON (default), so today's goldens and all drive-cert measurements run under DEFAULT animations — a timing trim certified under reduced motion would mask a re-click/re-layout race the slower default-animation host still hits. Only adopt reduced motion in the golden **if and when the production host (the dedicated automation Mac) also adopts it**, and then keep the two in lockstep. Until then this is a documented option, not an applied change; the goldens are immutable and are NOT re-minted for this alone.

## Version-stamping (mandatory policy)

Every campaign/evidence doc in `docs/lab/` MUST state, in its header, the Things version it was probed under **and** the golden id it ran against (e.g. `things-lab-golden-v1` · Things 3.22.11 · pinned clock 2026-07-05). This is not optional decoration — it is the provenance that makes a result re-checkable when a later app build moves the surface. **Evidence docs are IMMUTABLE snapshots:** they are never re-stamped or version-amended when a law is re-confirmed under a new golden — a re-confirmation accrues in the living ledger ([assumption-register](../reference/assumption-register.md), *Confirmed under* column), never by editing the historical evidence. The register is the one doc whose version list grows; every other campaign doc names exactly the golden it was born under.

## Durable artifacts (must outlive the run)

Most run artifacts are ephemeral (`lab/artifacts/<runId>/`, gitignored, safe to delete). A few must **outlive the run** — above all the **durable Things Cloud account credentials** (`lab/artifacts/sync-durable-account/`). These are written to the **PRIMARY checkout's** gitignored `lab/artifacts/` **by absolute path** — never only to an agent worktree's copy. A worktree's gitignored files do NOT travel with a merge, and the orchestrator's worktree cleanup destroys them: that is exactly how durable Things Cloud account #1 was orphaned (2026-08-14; a fresh account #2 had to be minted as a one-time replacement — [sync3-dedupe-tiebreak.md](sync3-dedupe-tiebreak.md) account-provenance note). The rule applies to any credential, coordinate dump, or seed that a *future* run depends on: absolute-path it into the primary `lab/artifacts/`, never a worktree-relative path.

## Running

```sh
npm run lab:run                          # default suite: lab/suites/u-suite.json
npm run lab:run -- --suite lab/suites/u-suite.json --keep-vm
npm run lab:compare -- u-20260703-091530 u-20260703-104512   # acceptance gate
npm run lab:gc                           # delete stray things-run-* VMs
```

Requirements: host GUI session (tart needs an unlocked keychain), `tart` + `sshpass` on PATH, the golden image under `TART_HOME` (default `/Volumes/Workspace/tart`). Exit code 0 = every probe green **and** the run beeped zero times (§The beep sentinel).

## Anatomy of a run

1. **Preflight** — tools present, golden exists, ≥10GB free, stray run-VMs deleted (2-VM ceiling).
2. **Clone + boot** — `tart clone` (APFS COW, instant) → `tart run --no-graphics` on default NAT (headless but full Aqua session). `--net-host` is deliberately **not** used: on current Tart it is implemented via Softnet, which requires passwordless root on the *host*. Boot output is captured to `tart-run.log` in the artifacts dir.
3. **Bootstrap** — **airgap guest-side** by deleting the guest's default route (SSH survives on the directly connected vmnet subnet; internet/updaters/phone-home become unroutable — verified by a failed ping each run); pin the guest clock to the golden's `pinnedDate` **before Things ever launches** (neutralizes trial expiry, freezes Today semantics); assert the disruption-monitor LaunchAgent is running; one warm-up launch+quit of Things (recomputes Today buckets / repeat instances for the pinned date, so probes see steady state); pull a consistent DB copy and **assert the schema fingerprint** against the active golden's `docs/lab/golden-v4-metadata.json` — mismatch aborts the run.
4. **Execute** — push `lab/guest/probe-runner.py` + suite + context (auth token, pinned date, seed-manifest UUIDs); the guest runs probes **serially**, hazard-group probes (crash risk) quarantined last.
5. **Collect** — execution records, per-probe snapshots, `events.ndjson`, final DB copy, crash reports → `lab/artifacts/<runId>/` (gitignored).
6. **Evaluate (host-side)** — snapshot diffing, disruption tiers, assertions → `evidence/<probe>.json` + `verdicts.json` + console summary.
7. **Teardown** — stop + delete the clone (`--keep-vm` to skip).

## Division of labor

| Where | What | Why |
|---|---|---|
| Guest (`probe-runner.py`, Python 3.9) | app-state enforcement, MARK sentinels, raw table snapshots, command execution, SQL-poll waits, crash detection | timing-sensitive mechanics must run next to the app |
| Host (`lab/runner/*.ts`) | snapshot diffing, tier computation, assertion evaluation, verdicts, artifact assembly | judgment logic is unit-tested (vitest) and reusable across suites |

## Probe lifecycle (guest)

`setup` (creates targets; noise excluded from evidence) → enforce `appState` → before-snapshot → `MARK start` → `commands` (+ SQL-poll waits) → settle → `MARK end` → crash check → after-snapshot → `cleanup` (e.g. `pkill Things3` to clear modals — the canonical reset primitive).

App states: `not-running` · `running-background` (Finder frontmost) · `frontmost` · `modal-open` (modal spawned in setup).

## Evidence & verdicts

Every probe yields one evidence record (`docs/design/lab.md` §4.2): resolved commands + transport results, row-level DB delta (`inserted/deleted/changed` — the ground truth; `open` exit 0 proves nothing), disruption `{tier, signals, events}` from the monitor slice between MARKs, crash `{pidDied, ipsFiles}`, and the verdict.

A probe is **green** iff: transport clean (unless `allowNonzeroExit`) ∧ all waits satisfied (unless `allowUnsatisfiedWaits`) ∧ observed tier == expected ∧ crash state == expected ∧ all assertions pass. Assertions are declarative (`rowExists`, `inserted`, `fieldEquals`, `fieldUnchanged`, `unchanged`, `rowCount`, `rowAbsent`, `notInserted`, `deltaEmpty`) with `@uuidOf:` / `@seed:` / `@ctx:` refs. Command strings support `{uuid:TITLE}` / `{seed:NAME}` / `{ctx:KEY}` placeholders resolved on the guest at execution time.

Disruption tiers: 0 = no observable effect · 1 = background launch · 2 = focus steal (Things became frontmost) · 3 = new window/modal beyond the window budget, or a title change. Window budget: a launch surfaces the main window plus (sometimes) an untitled companion (budget 2); a bare activation can surface that companion alone (budget 1); anything beyond is a modal/new window. Error modals show up as `window-new` events without a launch; the `json` command's error modal additionally steals focus. Note: AppleEvents to a *closed* Things auto-launch it **with focus steal** (tier 2, A40/A41) — pre-launch with `open -g` to keep AppleScript operations at tier 0.

## Command steps & vectors (suite DSL)

A probe's `setup`/`commands`/`cleanup` are lists of step objects the guest runs in order (`lab/guest/probe-runner.py`): `openUrl` (background `open -g` unless `foreground`), `exec` (raw argv), `osascript`, `shortcut`, `waitSql` (poll a SELECT until it returns a row), `waitCrash`, and `sleep`. String fields resolve `{ctx:…}`/`{seed:…}`/`{uuid:TITLE}` placeholders on the guest at execution time.

- **`shortcut`** — the Apple Shortcuts vector: `{ "shortcut": "<name>", "input": { … }, "timeoutSeconds": 40 }`. The guest writes `input` (a JSON dict; string values resolve placeholders) to a temp file and runs `shortcuts run <name> --input-path <in> --output-path <out>`. The output file (falling back to process stdout) becomes the command's `stdout`, so `stdoutMatches` assertions see the proxy's result; the stale output file is removed before each run (a proxy exits 0 even when it silently no-ops — the DB delta is the only truth, scf lesson). Requires the six golden-resident `things-proxy-*` shortcuts + inherited consent (see [s-campaign-results.md](s-campaign-results.md)).
- **`expectFrom`** — version-conditional expectations: `[{ fromVersion, because, expect }]` on a probe, resolved against the golden's `thingsVersion` with the SAME comparator the shipped version gate uses (`src/write/experimental.ts` `compareAppVersions`); highest matching bound wins, an unparseable version falls back to the base `expect`. For a MEASURED app-behavior change only — one binary of suites must certify both the active golden and the retained fallback. Its companion `allowUnsatisfiedWaits` (a wire command the app now ignores leaves nothing for a `waitSql` to observe) carries a hard rider: the override MUST replace the wait oracle with a positive assertion of the inertness (`deltaEmpty`, or `fieldUnchanged` over the rows the dead leg would have moved). Full rationale + the current 3.23 entries: [suite-audit](../reference/suite-audit.md) §Version-conditional expectations.
- **`group: "interactive"`** — a probe the automated runner SKIPS (both the guest execution list and the host's `activeProbes` gate). It stays in the suite JSON as documentation for human sittings. Use it for the delete-class Shortcuts proxies, which have no Always-Allow and re-prompt every run (oddities 5j): S04/S-delperm ride a human sitting via `lab/scripts/l5-consent-absorb.sh`, never `lab:regress`.

## Suite conventions (u-suite)

- Canonical URL transport is **`open -g`** (background-open). U01 alone uses plain `open` to re-validate T01's launch/foreground finding. Matrix-v1 tiers assumed plain `open`; the recorded tiers here are the `-g` variant, which is what the write API will use.
- Probes create their own targets in `setup` wherever possible; golden seed records are only mutated by the hazard group (fresh clone every run makes this safe).
- U10/U11/U15 are **discovery cells**: T10 never executed and T11/T15 were evidence-based conclusions; their expectations were locked from the first observed run and any later delta is a real finding.

## Acceptance (Lab-3 exit gate)

Two full unattended runs with every probe green and `lab:compare` reporting identical verdicts (`ok`/`verdict`/`tier`/`crash` per probe).
