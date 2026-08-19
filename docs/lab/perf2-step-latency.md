# PERF2 — set-datetime collect scoping + per-step delay audit + animation doctrine

**Probed under: `things-lab-golden-v3` · Things 3.22.14 (build 32214000) · macOS 15.7.7 · DB schema v26 · pinned clock 2026-07-05 12:00.** TWO disposable clones of golden-v3 (golden untouched; every write inside the clones), airgapped: `perf2m` (measurement — raw walk, settle audit, animation) and `perf2c` (re-baseline trace pre/post + byte-identical drive-cert). golden-v3 carries the baked L3-accessibility grant, so the ui vector drives and the AX enumeration run over SSH. Fixtures fully synthetic (`PERF2 *` titles). The live-host trace this optimizes against (maintainer's desktop, 2026-08-18) is referenced in shape only; the real host's data is deliberately kept out of the repo. Sibling to [trace1-drive-timings.md](trace1-drive-timings.md) (the immutable whole-drive baseline) and [perf1-drive-overhead.md](perf1-drive-overhead.md) (the reachability-probe scoping that shipped first). This is the follow-up that lands PERF1 brief deliverables 2 (collect scoping) and 3 (delay audit) plus the animation-settings doctrine.

Scripts: [`lab/scripts/research-perf2-measure.sh`](../../lab/scripts/research-perf2-measure.sh) (S4/S5/S6), [`lab/scripts/research-perf2-cert.sh`](../../lab/scripts/research-perf2-cert.sh) (S7/S8). Artifacts (gitignored): `lab/artifacts/perf2-measure/`, `lab/artifacts/perf2-cert/`.

## The measured problem (host trace, 2026-08-18)

A full-vocabulary `todo make-repeating … --when … --reminder …` on the maintainer's large, actively-syncing production desktop spent **~4.4s in the single "Next (first occurrence)" set-datetime step** — the app-root AXDateTimeArea walk. `axSetDateTimeScript` (`src/write/vectors/ui.ts`) located the Next/Ends/reminder date areas by walking the **app-wide** AX tree from the app ROOT at depth 16 (up to 20×100ms poll rounds). On a busy desktop that descent traverses the main window's large list content on every poll; the three date areas it seeks always live inside the small Repeat-dialog shell, so the whole descent below the shell is waste.

## The fix (behavior-preserving) — deliverable 1

`axSetDateTimeScript` now resolves the dialog SHELL first and collects `AXDateTimeArea` only within that subtree. The shell is the same sheet-vs-detached disjunction the recipe's System-Events `pathCandidates` already encode (ui-recipes `DIALOG_SHELLS`, UIC4-a), resolved in the JXA AX tree in the SAME priority order: an attached `AXSheet` on the standard window (Things frontmost), then a detached top-level `AXUnknown` window that is not the 40×40 utility window (Things backgrounded). `findShell` returns null when neither is present, and the poll loop then falls through to the SAME named `set-datetime <target>: this Repeat-dialog state presents 0 date area(s) [(none)] but none is the <target> control` error the app-root walk threw when the dialog was absent — the census counts are still derivable and the message shape is byte-identical.

Everything else is unchanged and byte-identical: the deterministic `pick` targeting (reminder = time-bearing area; next = top midnight picker; ends = bottom midnight picker), the AX write, the 0.2s read-back settle, and the read-back rejection detection (YANCH1 #493). Unit-locked in `test/unit/ui-scripts.test.ts` (shell-scoped walk, sheet-then-detached priority order, shell-not-found → same named error, plus the retained read-back/named-error asserts).

## S4 — RAW WALK: app-root vs shell-scoped collect (golden-v3, N=10)

The collect walk timed in ONE JXA probe on the SAME live open Repeat dialog: `Date.now()` around `collect(app,'AXDateTimeArea',16,·)` (OLD) vs `collect(findShell(app),'AXDateTimeArea',16,·)` (NEW). This is the pure per-hop traversal cost the set-datetime step pays (osascript startup excluded). **Foreground app processes on this golden desktop: 1** (Things only); the default Repeat dialog opened here carries **0 AXDateTimeArea controls** (no `--when`/`--ends` set), so the probe isolates the pure TREE-TRAVERSAL delta — `findShell` resolved the sheet on every rep (`shell`, never `noshell`), confirming shell resolution works live; the date-area-FOUND path is validated end-to-end by S7/S8.

| walk | ms (min / median / max) |
| --- | ---: |
| APP-ROOT (OLD, `collect(app,…)`) | 115 / **125** / 154 |
| SHELL-SCOPED (NEW, `collect(shell,…)`) | 22 / **26** / 31 |

**~79% cut even on the near-empty golden** (125 → 26 ms): the app-root descent traverses the menu bar + sidebar + toolbar + content list to depth 16 to find nothing below the shell, while the scoped walk visits only the small sheet. The golden CANNOT reproduce the busy-host 4.4s magnitude (tiny DB, empty list, 1 foreground app) — same limitation PERF1/TRACE1 hit — but the traversal-cost delta is the same mechanism; on the busy host the removed descent is what cost ~4.4s.

## S7 — Re-baseline: make-repeating drive traced pre/post (golden-v3) — deliverable 4

Full-vocabulary `todo make-repeating <uuid> --frequency weekly --interval 2 --weekdays wednesday --when 2026-08-26 --reminder 18:00 --dangerously-drive-gui --json` (the TRACE1 shape) driven with `THINGS_API_TRACE=true` on the OLD (app-root collect) and NEW (shell-scoped collect) bundles in the same clone. Both drives **succeeded** (`ok`, exit 0). Per-step `ui-dispatch` osascript wall times:

| step (label) | primitive | OLD ms | NEW ms |
| --- | --- | ---: | ---: |
| session-reachability probe | resolve | 79 | 78 |
| reveal the target (`things:///show?id=`) | reveal | 19 | 19 |
| bring Things to the foreground | activate | 55 | 55 |
| Items ▸ Repeat… (resolve) | resolve | 108 | 103 |
| confirm target selected + enabled | assert-eligible | 82 | 76 |
| Items ▸ Repeat… | press | 65 | 65 |
| the Repeat dialog | wait | 436 | 409 |
| frequency = weekly (resolve) | resolve | 64 | 63 |
| frequency = weekly | select-popup | 425 | 405 |
| interval = 2 (resolve) | resolve | 59 | 56 |
| interval = 2 | set-value | 1560 | 1544 |
| weekday = wednesday (resolve) | resolve | 64 | 64 |
| weekday = wednesday | select-popup | 405 | 418 |
| **Next (first occurrence) = 2026-08-26** | **set-datetime** | **619** | **312** |
| Add reminders (resolve) | resolve | 61 | 64 |
| Add reminders | ensure-checkbox | 397 | 405 |
| **reminder = 18:00** | **set-datetime** | **426** | **322** |
| press "OK" (resolve) | resolve | 64 | 58 |
| press "OK" | press | 66 | 57 |
| **TOTAL ui-dispatch** | | **5054** | **4573** |

Whole invocation elapsedMs (incl. the settle + verify poll): **7314 → 6815** (both exit 0). The traced NEW bundle carries the PRE-trim 1500ms `SETTLE_AFTER_REVEAL_MS` (it was staged before the S5a trim landed; the settle is a JS sleep, not a `ui-dispatch` hop, so it never appears in the per-step rows — only in elapsedMs); the shipped 1000ms settle drops elapsedMs a further ~500ms. Every non-set-datetime step is within run-to-run noise (±20ms); the two set-datetime steps are the whole delta.

**set-datetime step (the deliverable-1 headline), golden-v3:**

| set-datetime step | OLD (app-root) ms | NEW (shell-scoped) ms | cut |
| --- | ---: | ---: | ---: |
| Next (first occurrence) | 619 | 312 | **−50%** |
| reminder = 18:00 | 426 | 322 | −24% |

On the golden the "Next" step HALVES (619 → 312ms) even though the list is near-empty — the app-root descent still walks the menu bar/sidebar/toolbar that the scoped walk skips. On the busy host the removed descent additionally traverses the large main-window list, which is the ~4.4s the scoping eliminates (S4 mechanism). Rule bytes of the OLD and NEW templates are **byte-identical** (`S7 rule bytes OLD==NEW? YES`) — no regression.

## S8 — No-regression drive-cert (byte-identical DB) — deliverable 4

Cheapest adequate live drive-cert set (both cells run on OLD then NEW; `rt1_recurrenceRule` compared as `quote()` hex):

| cell | drive | OLD vs NEW result | verdict |
| --- | --- | --- | --- |
| **A. ADR1 full combo** (recert) | `todo add-repeating` area+tag+when+reminder, weekly/2/wednesday | `rt1_recurrenceRule` + `reminderTime` (1207959552 = 18:00) + `rt1_instanceCreationStartDate` (132812032 = 2026-08-26) all **byte-identical** | **PASS** |
| **B. Next+ends-on coexistence** (RRD1/DACON1 lineage) | `todo make-repeating` weekly/1/wednesday `--when 2026-08-26 --ends-on 2027-01-01` (two date areas present) | `rt1_recurrenceRule` **byte-identical** (`ed`=1798761600 ends-on 2027-01-01 + `of`=[{wd:3}] + first occurrence both landed) | **PASS** |

Both cells drive to byte-identical DB results on the OLD (app-root) and NEW (shell-scoped) bundles: the scoping change is behavior-neutral, and the two-date-area path (cell B, the scoping-sensitive one) targets Next and ends-on correctly under the scoped walk. (Cell B's first pass errored on a missing required `--interval`; re-driven with `--interval 1` — a harness typo, not a code fault; both bundles failed identically on the typo, confirming no regression.)

## S5 — Settle-delay audit (deliverable 2): trim only what traces prove

Per the cert-parity rule, every convergence measurement below ran under **DEFAULT macOS animation settings** (`reduceMotion` unset, `NSAutomaticWindowAnimationsEnabled` unset — the maintainer's desktop state). Trims are certified only under those settings.

### SETTLE_AFTER_REVEAL_MS = 1500 → TRIMMED to 1000

The fixed sleep after the reveal/activate preamble that lets the menu bar repopulate for the newly-selected target before the canary reads the `Items ▸ Repeat…` path (UIC1). **S5a** measured, on a warm running app (the host's normal state), the ms from post-`activate` to the `Items ▸ Repeat…` menu item being enabled — exactly the gap this settle guards — across N=10 reps navigating away and back:

| reveal+activate → menu-ready | ms (min / median / max) |
| --- | ---: |
| golden-v3, default animations, N=10 | 77 / **92** / 116 |

The menu repopulates in ~92ms median (116ms max) — a **~13× margin** at 1500ms. Menu-bar repopulation is a LOCAL UI operation, not a DB-commit / sync-bound one, so it does not scale with DB size the way TRACE1's "several times slower" OK-commit does. Trimmed to **1000ms**: banks ~500ms/drive while keeping ~8.6× the golden max as host headroom (a fail-closed spurious refusal is the only downside if a host ever exceeds it, never a bad write). The justifying comment is retained and annotated with this PERF2 measurement.

### WAIT_POLL_MS = 300 → KEPT (measurement justifies it)

The inter-poll interval for element waits + the candidate-resolution poll. **S5b** measured the ms from a frequency-pop-up mode switch to the revealed control (weekday pop-up) appearing — the race these polls guard (UIC6) — across N=6 reps:

| mode-switch → control-ready | ms (min / median / max) |
| --- | ---: |
| golden-v3, default animations, N=6 | 454 / **462** / 467 |

Convergence (~462ms) EXCEEDS the 300ms poll interval, so a 300ms poll catches the control on its second poll; a finer interval would add osascript hops for a marginal detection gain. **Kept** with this evidence (the earlier UIC6 ~250ms estimate was low; 300ms is well-sized).

### set-datetime 0.2s read-back settle → KEPT (safety semantic)

The `sleepForTimeInterval(0.2)` between the AX write and the read-back is not a cosmetic margin — it is the settle window for the YANCH1 rejection-beep case (a control accepts the AX write with `err 0` yet reverts to its prior/default value). The read-back rejection detection is an untouchable safety semantic (brief rails), so this delay is **kept** unconditionally; no trim is defensible.

### Other internal delays (interval retry, popup self-heal, checkbox converge) → KEPT

`axSetValueScript` (0.15/0.1/0.1/0.2/0.3 across its closed-loop retry), `axSelectPopupCandidatesScript` (0.3 per open-click retry), and `axEnsureCheckboxScript` (0.2 per converge attempt) are all inside **deterministic closed loops** that read back and retry — the delays pace those loops against documented races (UIC6/UIC7/RRD1) and are bounded by the loop's own convergence check, not padding. Trimming them risks the exact re-click/re-layout races they guard; **kept** with their justifying comments.

## S6 — Animation-settings doctrine (deliverable 3): config, not code

Reduce Motion + `NSAutomaticWindowAnimationsEnabled false` speed sheet presentation. Per the cert-parity rule these are **NOT** baked into cert clones and the goldens are untouched; they are documented as STANDING CONFIGURATION for the future dedicated automation host and the next golden mint (see [harness.md](harness.md) and [design/ui-vector.md](../design/ui-vector.md)). **S6** quantifies the effect — ms from the `Items ▸ Repeat…` menu press to the sheet being present with its frequency pop-up resolvable (present + settle), N reps each on the same clone:

| animation setting | menu-press → sheet present+settle ms (min / median / max) |
| --- | ---: |
| DEFAULT (`reduceMotion` unset, `NSAutomaticWindowAnimationsEnabled` unset), N=8 | 516 / **532** / 590 |
| Reduce Motion + `NSAutomaticWindowAnimationsEnabled false`, N=8 | 242 / **260** / 329 |

**Reduced motion roughly HALVES sheet present+settle (~532 → ~260ms, a ~51% cut)** on the golden — a per-drive saving that compounds across the ~10–12 step drive. This is the evidence for the standing-config doctrine: adopt it on the dedicated automation host and at the next golden mint, but keep the cert environment matched to the production host's animation state (the parity caveat below).

**CERT-PARITY caveat (spelled out for the doctrine):** the S5 trims above are certified under DEFAULT animations because the maintainer's desktop runs animations ON. If the production host adopts reduced motion, the cert environment (golden / clones) should match it — otherwise a trim certified under reduced motion would mask a race the slower default-animation host still hits. Do NOT bake reduced motion into cert clones while the host runs default animations; the two must track each other.

## Projected host improvement

- **set-datetime "Next" step:** the ~4.4s app-root descent on the busy host collapses to a scoped-shell walk (tens of ms; S4 shows ~26ms on the golden, bounded above by a few × on a busy host — the shell subtree is tiny regardless of the main list's size). This is the campaign's headline: the single most expensive drive step on the host is removed.
- **Post-reveal settle:** 1500 → 1000ms saves a further ~500ms per drive.
- Everything else in the drive (pop-ups, interval field, OK commit) is unchanged; the safety semantics (read-back, named errors, checkbox convergence, watchdog, per-step checkpoints, three-state gate) are untouched.
