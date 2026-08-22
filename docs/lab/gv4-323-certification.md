# GV4-CERT — certifying golden-v4 (Things 3.23): suite reconciliation, register walk, simulator re-model

**Probed under: `things-lab-golden-v4` · Things 3.23 (CFBundleVersion 32300036, direct-download channel) · macOS 15.7.7 (24G720) · `Meta.databaseVersion` 27 · schema fingerprint `sha256:d2b7e98c…` · guest clock pinned 2026-07-05 12:00 (a Sunday).** Campaign run 2026-08-22, unattended. Immutable snapshot per the [harness](harness.md) version-stamping policy; version *confirmations* accrue in the [assumption register](../reference/assumption-register.md), never here.

Predecessors this campaign completes: [gv4-323-campaign.md](gv4-323-campaign.md) (mint + first sweep, deliberately unreconciled), [rdlg1-323-repeat-dialog-census.md](rdlg1-323-repeat-dialog-census.md) (the AX census), [rdlg2-323-recipe-cert.md](rdlg2-323-recipe-cert.md) (the ui-vector half + the first two register stamps). Drift-runbook steps 2–5.

---

## 0. Headline

Things 3.23 is **not** a behavioral no-op update the way 3.22.12 and 3.22.14 were, and this campaign deliberately does **not** give it their blanket register amendment. What it gives instead:

- **`lab:regress` is GREEN end to end on golden-v4** — all eight suites plus the 132-step write-layer e2e — with every 3.23 difference encoded as a *measured, version-scoped expectation* rather than a loosened one.
- **One app capability is GONE, not merely re-routed**: `_private_experimental_ reorder to dos in` is accepted, exits 0, and changes nothing. The o-suite now LOCKS that inertness, which makes it the behavioral canary the sdef declaration check can never be.
- **Two shipped reaches lose their only surface on 3.23** and now refuse honestly instead of failing a write: heading order, and any day-group holding a repeating template. A third — a Today set containing a project row — was found by this campaign and is reported below.
- The register is walked and stamped **row by row, with the un-stampable rows named** rather than swept into a blanket. That named residue is what keeps `certified-app-version 3.23` honest-but-imperfect, exactly as 3.22.14's was.

---

## 1. Leg 1 — suite reconciliation

### 1.1 What the o-suite reds actually were

The GV4 sweep's 14 o-suite failures reproduce exactly on a fresh clone (run **`o-20260822-145020`**, the pre-reconciliation measurement): O03 O04 O06 O10 O11 O15 O16 O17 O20 O34 O35 O36 O38 O39. Every one has the same root cause and none is a new law — the private reorder command runs and does nothing.

Two facts from that run drove the whole encoding:

1. **Fifteen probes whose entire command list is the private wire produce a BYTE-EMPTY row delta** (0 inserted, 0 deleted, 0 changed) — O01 O03 O04 O05 O06 O09 O10 O11 O12 O14 O15 O16 O17 O20 O36. `deltaEmpty` is therefore an exact, positive statement of what 3.23 does.
2. **Five of those fifteen were PASSING — vacuously.** O01, O05, O09, O12 and O14 assert an order their fixture already had, so a no-op satisfies the wait. They were reporting "the native path works" on an app where it does nothing. That is the more dangerous half of the red table, and it was invisible in the failure list.

The four mixed cells (O34/O35/O38/O39) interleave live URL legs with the dead native leg. Measured: exactly **one** unsatisfied wait each (the template-relative one) and **zero changed fields on the template row**. So the URL scheduled/forecast legs still land their exact order and only the template's single-id `list "Upcoming"` front-insert is inert.

### 1.2 The mechanism: `expectFrom`

The suite DSL had no version-conditional vocabulary — every expectation was a flat statement of fact. A flat expectation can only be the OLD law (permanently red) or the NEW law (silently un-runnable on golden-v3, the retained 3.22.14 fallback). Neither is acceptable when the same suites must certify both generations.

`ProbeSpec.expectFrom` (designed here, documented in [suite-audit](../reference/suite-audit.md) §Version-conditional expectations) adds a list of `{ fromVersion, because, expect }`; the highest matching bound wins, an unparseable version falls back to the base expectation, and the comparison uses **`compareAppVersions` from `src/write/experimental.ts` — the same comparator the shipped version gate uses**, so the suite and the engine cannot disagree about which side of 3.23 a golden is on. Console + `verdicts.json` mark a version-judged probe `[>=3.23]`, and the override's `because` is carried verbatim into the evidence record.

`ProbeExpectation.allowUnsatisfiedWaits` is the companion: a dead wire's only observable is a wait that times out. **It carries a hard discipline** — an expectation that sets it must replace the wait oracle with a POSITIVE assertion of the inertness (`deltaEmpty` for a pure cell, `fieldUnchanged` over the rows the dead leg would have moved for a mixed one). That assertion is the canary: the day Cultured Code re-implements the command, the row goes RED and points at lifting `PRIVATE_REORDER_NO_OP_FROM`. A wait that merely stops timing out would not — as O01/O05/O09/O12/O14 proved.

A first draft used "every wait came true ⇒ drift" as the canary instead. It was **wrong**, and those five vacuous passes are why: a satisfiable wait says nothing about whether the command did anything. It was replaced by the assertion discipline before any run.

### 1.3 What was NOT overridden, on purpose

O07 O08 O18 O19 O21 O22–O33 O37 carry **no** override and are expected to pass unchanged on every golden. These are the bounce / move / deadline-cycle / json-collapse protocols — precisely what the shipped engine now routes to on 3.23 (SIT7, ORD-15/16/17). An override there would hide a real regression in the code path 3.23 users actually take. All of them ran green.

### 1.4 The e2e smoke, and a genuine capability loss it exposed

`lab/guest/e2e-write-smoke.sh` reads `CFBundleShortVersionString` off the installed bundle and branches only where a scope has **no** fallback protocol. Everything else is untouched, because its scope degrades to a SIT7 protocol that behaves identically on both generations — which the run confirms: `project-child reorder`, `native inbox reorder`, `native someday reorder`, `--in anytime`, `--in evening`, `project move --first` (area / someday / sidebar) all pass on 3.23 with no expectation change at all.

Three steps do branch:

| step | ≤3.22 | 3.23 | why there is no fallback |
|---|---|---|---|
| `project move-heading` | exit 0 | **exit 4** `blocked:environment` | heading order has no non-experimental twin; the pre-dispatch canary refuses rather than spend a doomed write |
| any day-group holding a repeating template (3 steps: to-do interleave, mixed-kind interleave, project-template suffix) | exit 0 | **exit 4** `blocked:H-REORDER-SCOPE` naming the template | ORD-19's leg IS the native wire, and a dated `when=`/`deadline=` leg CRASHES a template (§1/§9e) — so there is no safe substitute |
| `reorder --in today` on a Today list containing a PROJECT row | exit 0 | **exit 4** `blocked:H-REORDER-SCOPE` | **found by this campaign — see §1.5** |

The refusal-copy assertions branch too rather than being skipped, so 3.23 asserts the refusal it *should* get. In particular the mixed-kind step still proves the #393 gate fix: on 3.23 the set gets **past** the upstream "one kind at a time" refusal and reaches the day-axis resolver, which is where it now refuses — on the template, not on kind-mixing.

**Result: 132 steps, 0 failures** (run `things-run-e2e-20260822-100336`), against 126/132 before the reconciliation.

### 1.5 NEW FINDING — `reorder --in today` has no working path when Today holds a project row

Not a version-gate consequence and not previously reported. The golden's Today list contains a seed PROJECT row. Under ≤3.22 the native wire carried it (ORD-2 / O12 — projects inherit `to do` in the sdef, so one `todayIndex` axis takes both kinds). On 3.23 the native wire is gone and the today BOUNCE fallback **refuses** it:

```
blocked:H-REORDER-SCOPE
<uuid> is a project — bounce re-schedules via todo.update, which is only validated for to-dos;
use the native strategy for Today lists containing projects
```

The refusal is **correct**: a project's daytime `when=today` landing is mid-pack, not the front-insert the bounce protocol needs (ORD-12 / SIT3 EVEPROJ), so carrying a project row on the today bounce would land a *wrong* order. It fails closed, which is the right failure. Two things follow:

- **The remediation copy was a lie on 3.23** — it advised the very strategy the version gate has taken away. Fixed here: when the native path is version-gated the message names that instead, and says the set has no working order surface (reorder it without the project row, or arrange it in the app). Runtime diagnostic output, so out of scope for the banned-vocabulary contract ([surface-copy](../design/surface-copy.md)).
- **Closing the gap needs probe evidence we do not have** — what a project row's `update-project?when=<today>` re-entry actually does to the shared Today axis. That is a new cell, not a reconciliation, and it is queued in [up-next](../up-next.md). It is deliberately NOT guessed at here.

### 1.6 SECOND FINDING — the A10/R01 tier flip is a harness RACE, not a 3.23 behavior change

GV4 §3.3 read an intermittent `tier 0 → 3` on the first probe of a `running-background` suite — a bare `window-new` titled `Today`, `launch = false`, `activated = false` — as "the app materialises a list window on first touch", and left it as a disruption-budget question for the maintainer. RDLG2's a-suite run then came back tier 0 and dismissed it as "a first-touch artifact of that run". **It is neither. It is a race, and it reproduced on this campaign's regress (a-suite A10, tier 3).**

The monitor log settles it. On the run's FIRST launch, `window-new "Today"` arrives **3.5 s** after `launch`, unprompted. On the guest's app-state launch, the same 3.5 s clock runs — but `launch_things_background` returned after a fixed 2.0 s settle and `enforce_app_state` added 1.0 s, i.e. **~3.0 s**, so the MARK opened ~500 ms before the window the app was always going to open. A10's own AppleScript reads had nothing to do with it; they merely happened to be running when it landed. That is exactly why it flickers between runs.

Fixed with a **closed loop, not a longer sleep** (`wait_for_main_window`, `lab/guest/probe-runner.py`): app-state enforcement now polls `count windows` until the window exists before returning, so no probe's tier can depend on how fast the host booted. This is the determinism doctrine applied to the harness itself — a fixed settle that happened to be long enough on 3.22.14 is not a measurement, it is a coin flip that had been landing the same way. Consequences worth stating: **there is no new 3.23 tier law to record, no expectation was widened**, and `A10`/`R01` keep their tier-0 expectations. The corrected reading supersedes GV4 §3.3.

### 1.7 The reconciled regress table

`npm run lab:regress` against fresh golden-v4 clones, one clone per suite, bootstrap fingerprint assertion passing on every one. **Exit 0 — `ALL GREEN`.**

| suite | probes | result | run id | notes |
|---|---|---|---|---|
| u (URL scheme) | 23 | **GREEN** | `u-20260822-152454` | U12's `when=`-on-a-template crash STILL reproduces (expected, `crash`/tier 0) — the `H-REPEAT-SCHEDULE` guard stays |
| a (AppleScript) | 39 | **GREEN** | `a-20260822-152726` | A01B carries RDLG2's reconciliation to the 3.23 at-locus regression (verdict `partial`, oddities §10). A10 tier 0 — see §1.6 |
| x (cross-vector) | 3 | **GREEN** | `x-20260822-153050` | — |
| **o (ordering)** | 38 | **GREEN** | `o-20260822-153137` | **19 probes judged by a ≥3.23 `expectFrom` override** (15 `silent-noop`+`deltaEmpty`, 4 `partial`+template-byte-unchanged); the other 19 — every bounce / move / deadline-cycle / json-collapse protocol — pass on their BASE expectation, unchanged |
| r (reminders) | 21 | **GREEN** | `r-20260822-153806` | R09's schedule-class crash still reproduces; R20/R21 still `unsupported` |
| e (editing) | 19 | **GREEN** | `e-20260822-154002` | — |
| p (gap-closure) | 30 | **GREEN** | `p-20260822-154159` | — |
| s (Shortcuts) | 4 (+2 `interactive` skipped) | **GREEN** | `s-20260822-154506` | the six golden-resident proxies still execute under 3.23 on the inherited Always-Allow |
| **write-layer e2e smoke** | **132 steps** | **GREEN, 0 failures** | `things-run-e2e-20260822-104555` | was 126/132 before the reconciliation; the transcript opens with `Things 3.23 — native private reorder available: no` |

For comparison, the pre-reconciliation measurement of the same tree: **o 24/38 red on 14** (run `o-20260822-145020`, reproducing GV4's failure list exactly) and **e2e 132 steps / 9 failures** (run `things-run-e2e-20260822-095435`). The e2e was *worse* than GV4's 6 failures because #525's version gate turned three previously-silent no-ops into loud pre-dispatch refusals — the gate working, and exactly what the expectations now encode. Of GV4's original six, one (`project-child reorder (bare)`) FIXED ITSELF under the gate: the PROJROOT fallback engages and it passes with no expectation change at all.

The o-suite is measurably **slower** on 3.23 (~6½ min vs ~4): every doomed `waitSql` burns its full 10 s timeout before the probe can conclude. That is the honest cost of keeping the inert cells running as a canary rather than skipping them, and it is worth paying.

**Two clean passes** were run against the reconciled suites (`o-20260822-150329` and `o-20260822-153137`; a-suite `a-20260822-152115` and `a-20260822-152726`), satisfying the Lab-3 two-run acceptance shape for the suites this campaign changed.

---

## 2. Leg 2 — the register walk

The full ledger lives in the [assumption register](../reference/assumption-register.md)'s 3.23 audit block (that is the living document; this is the campaign's account of how it was decided). The one methodological point worth recording here:

**The blanket amendment was refused, and the amendment rule was refined to say why.** 3.22.12 and 3.22.14 each got "regress ran green ⇒ append the version to every row", which was sound *because those were behavioral no-op updates*. It breaks on 3.23, because a suite row can be reconciled to the app's NEW behavior and go green while **the law it carries is no longer true**. Stamping ORD-1 with `3.23` would assert that the private reorder command still re-ranks rows — on an app where it provably does nothing. So the rule now names three states and the register distinguishes them per row:

| state | what it means | count |
|---|---|---|
| **Stamped `3.23 (golden-v4)`** | the LIVE lock ran green *asserting the same law* | 13 rows (+2 already stamped by RDLG2) |
| **SUSPENDED** | the lock is green only because it was reconciled to assert the app's new behavior; the version list is left untouched and the cell says so | 10 rows — every law resting on the private reorder command |
| **No live lock** | unit / engine / evidence-only, or a rig `lab:regress` cannot host; no golden can confirm it, so a missing stamp is NOT drift | the standing residue, enumerated in the audit block |

The stamped set is dominated by the protocols a 3.23 host now actually runs: **ORD-16 (SIT7 INBOXBACK / SOMEBACK / PROJROOT / AREABACK, o-suite O25–O30)** and **ORD-15 (SIT6 HEADMOVE / LOOSEPARK / PROJPARK, O22–O24)**, plus the pure-URL geometry laws ORD-4/5/6/11/17/18. That is the reassuring half of the certification: the fallbacks the version gate routes to were re-certified live under the app that needs them, not merely assumed to be version-independent.

The suspended set is ORD-1, ORD-2, ORD-3, ORD-7, ORD-8, ORD-9, ORD-12 (HEADSORT), ORD-19, ORD-20, ORD-22. Two of those cost a shipped reach outright (heading order; template day-block placement) because they have no fallback protocol; the rest are covered by ORD-16.

Two new things were added rather than stamped:

- **RD-27** — a new register row for the DBV27 substrate semantics themselves (the template-scoped next-instance cache, the `-1`→computed-`0` counter back-fill, and the cursor rewrite that did NOT reproduce). These are laws the read derivations and the simulator appliers now rest on, and they had no row. Its honest lock note: a migration runs ONCE per golden mint, so it can never be a recurring suite row — the recurring guard is the schema fingerprint plus the simulator's version fence.
- **A housekeeping defect, reported not fixed:** **ORD-12 and ORD-13 are each used TWICE** in the register (HEADSORT/EVEORD and LOGSORT/PRJMIX). Both ids are cited from other documents, so renumbering is a separate change.

### 2.1 Stale premises corrected in code comments

The GV4 §2.1 correction ("3.23 retired `rt1_nextInstanceStartDate`" is wrong — it scoped the column to templates) had been reconciled in the docs by #524 but **eight code comments still carried the superseded premise**, including the `db-v27.ts` baseline's own doc comment, which additionally repeated the "leaf-action counters now self-counting" and "spawn cursors re-anchored forward" readings that GV4 §2.2/§2.3 also corrected. All are now accurate: `src/db/baselines/db-v27.ts`, `src/model/mappers.ts`, `src/model/recurrence.ts`, `src/read/detail.ts`, `src/read/queries.ts`, `src/read/views.ts`, `src/write/move.ts` (×2), `src/write/pre-state.ts`, `src/write/reorder.ts`, and the `DBV27 READ EQUIVALENCE` prose in `test/unit/views.test.ts`. Comments only — no behavior depended on the wrong premise, because the shipped helper already preferred the cache when present, which is correct under either reading.

---

## 3. Leg 3 — the simulator / bench re-model

Drift-runbook step 5, in its prescribed order. Full account in [simfid-results.md](simfid-results.md); the decisions:

**`SIMULATED_DATABASE_VERSION` moves 26 → 27, with the fixture stamped 27 in lockstep.** The bump is *fingerprint-invisible* (the 26→27 DDL delta is index-only; `DB_V27.fingerprint === DB_V26.fingerprint` by construction), so it rests entirely on the DATA semantics — which is the right basis, because data semantics are what the appliers model. Leaving the constant at 26 would model a generation the app no longer has and would fold two unverified generations into the next bump. The fence stays loud in both directions and is proven live: with the constant at 27 and a 26-stamped fixture, `defaultVectors` throws.

`docs/atlas/schema-v26.md` and `test/fixtures/schema-v26.sql` were deliberately **NOT renamed** — one file per TABLE SHAPE, carrying a v27-delta section, because ~15 documents link those paths and a rename is churn rather than information. The fixture SQL did take the v27 index set; verified (not assumed) that `observeSchema` hashes `PRAGMA table_info` only, so indexes stay fingerprint-invisible and `test/unit/fingerprint.test.ts` still reproduces the baseline exactly.

**The applier verdict table did not move: 30 MATCH · 5 TOLERATED · 0 DIVERGENT, before and after, row for row.** That is a real result rather than a null one, and the reason was checked rather than assumed: **both v27 data semantics were already what the appliers produced.** No insert path ever wrote a `-1` counter sentinel (every one writes a literal `0` on the classes that can hold none — which IS the v27 computed value), and every `rt1_nextInstanceStartDate` write already targeted a TEMPLATE row while every minted instance left it NULL — already the v27 law, and already the reason the `instance-next-sentinel` tolerance exists. So step 5 was a verification pass that turned up three wrong doc comments and zero wrong code.

**Tolerances.** `instance-next-sentinel` was **kept**, deliberately, against the tempting reading that GV4 §2.1 retires it. That over-reaches twice: §2.1 measures what the MIGRATION does to rows that already exist, not what a running 3.23 app writes when it MINTS a fresh instance (unmeasured by any campaign); and decisively, every golden this tolerance fires against is the `rsim-evidence` recurrence/subtree family captured under ≤3.22.12, where the `69760` sentinel is real. Deleting it would flip five rows to DIVERGENT against their own banked evidence — a fabricated divergence. Its evidence string now names the ≤3.22 provenance and writes down the retirement condition (an AX-capable 3.23 clone drive showing a freshly minted instance with NULL there). `rt1-child-backlink`, `index-rank` and `wallclock-bucket` are untouched — nothing in 26→27 reaches child back-links, list ranks, or wall-clock columns.

**The fresh-clone drive now runs against the ACTIVE golden.** `lab/scripts/simfid.sh` was still hard-coded to clone `things-lab-golden-v1` (Things 3.22.11) — so the drift-runbook's "re-certify against the REBUILT golden" could not actually happen. It now clones `$GOLDEN`, defaulting to golden-v4, forwards comparator arguments after a `--` separator (so `-- --gate` works as the runbook documents), and **propagates the comparator's exit code** instead of always exiting 0, which is what makes `--gate` a gate.

Result of that drive — run **`simfid-clone-20260822-101032`**, comparator run `simfid-20260822-151139`, **exit 0**: all six headless CRUD cases drove cleanly on real Things 3.23 (`op exit=0`, real before/after rows, 6 normalized clone deltas ingested) and all six MATCH, so their app-side ground truth is now a **fresh 3.23 capture** rather than a 3.22.11 one. Standing: **30 MATCH · 5 TOLERATED · 0 DIVERGENT · 0 replay-error**. Neither of the two things that would have been genuinely new information appeared: no counter cell differed where it never has, and no CRUD row carried an `rt1_nextInstanceStartDate` value (so the sentinel's fate on freshly-written 3.23 data remains unmeasured — it needs the recurrence family, which is AX-only).

**Bench:** no generated data changed, so no bench file moved beyond documentation (`bench/world.ts` comments + a `bench/ROADMAP.md` decisions-log entry). `bench/CONSTITUTION.md` untouched. The simulator fence deliberately keeps the bench host-version-independent — a bench run must behave the same on a 3.22 and a 3.23 host, which is why `simFenceActive()` short-circuits the reorder version gate.

---

## 4. Leg 4 — certification

`things-lab-golden-v4` (Things 3.23, build 32300036, database version 27) is **CERTIFIED** as the active golden. Recorded in [golden-v4-metadata.json](golden-v4-metadata.json) (`certification.status`, with explicit `notCertified` and `standingResidue` fields — the gv3 record had neither, and 3.23 needs them), the [harness](harness.md) golden table, and the [things-update-runbook](things-update-runbook.md) "Version pinning" line. `things-lab-golden-v3` (3.22.14) is retained as the certified fallback and is now load-bearing in a new way: it is the arm every version-conditional expectation is checked against.

**`things config set certified-app-version 3.23` was deliberately NOT run.** It stamps the operator's own config on the live host and silences `doctor`'s passive behavioral-drift notice, so it waits on the maintainer reviewing this campaign. The runbook now states that as a rule rather than leaving it to convention.

### What "certified" does and does not claim

It claims: every suite and the e2e run green against a 3.23 image; every law with a live lock was re-run and either confirmed or explicitly recorded as suspended; the substrate migration is measured and modelled; the shipped engine's 3.23 behavior (fallbacks, refusals, refusal copy) is exercised end to end.

It does not claim that every law was re-verified — two classes never can be, and both are now enumerated per row rather than implied: laws the update SUSPENDED, and laws whose only lock is unit/engine/evidence-level or needs a rig `lab:regress` cannot host (a clock roll, a TZ shift, a framebuffer, a live Things Cloud account). 3.22.14 shipped with the same shape of residue; the difference is that this one is written down.

---

## 5. Standing state

- `things-lab-golden-v4` **CERTIFIED**, frozen, and the golden the runner clones. `-v3` retained as the certified fallback, `-v2` behind it, `-v1` superseded-pending-deletion.
- Every clone-boot path now **mutes the guest at boot** (`lab_mute_guest` in `lab/scripts/env.sh`, called from the shared `lab_wait_for_ssh` chokepoint; the TypeScript runner mutes in `bootstrap`). A Tart guest plays through the HOST's speakers, so a single alert beep from an unattended overnight clone wakes whoever is asleep next to the machine. Best-effort, never fatal.
- Known harness footgun, reported not fixed: `lab:run`'s preflight `gcRunVms()` deletes **every** `things-run-*` VM, including a sibling campaign's — while `simfid.sh` goes out of its way NOT to reap a slot a sibling legitimately holds. The two policies disagree, and the aggressive one forces campaigns to serialize even inside the 2-VM ceiling. This campaign worked around it by sequencing; a future change should make the gc as polite as `simfid.sh` is, or scope it to VMs older than the current run.
