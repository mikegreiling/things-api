# SRCFATE — consolidated single-VM probe sweep (source-fate reconciliation + Convert/promote creationDate + umd micro-cells + RESTAGE + future-project representation)

**Probed under: `things-lab-golden-v2` · Things 3.22.12 (build 32212016) · macOS 15.7.7 · DB schema v26 · pinned clock 2026-07-05 12:00 (P5 advanced +3 days to 2026-07-08).** Ran across **three** disposable clones of golden-v2 (golden untouched; every write inside a clone; each torn down at teardown — the 2-VM ceiling respected, one clone alive at a time), airgapped (default route deleted, ping fails), clock pinned before Things launched. golden-v2 carries the baked **L3-accessibility** grant, so the ui-vector ops drove via System Events over SSH with no VNC. Ground truth = read-only guest SQLite row deltas through the **production CLI** (guest e2e bundle: node + dist + commander). Branch `mg/probe-sweep`. Scripts: [`lab/scripts/research-srcfate.sh`](../../lab/scripts/research-srcfate.sh) (clone-1: P1 to-do cells + P2/P3/P4/P5/P6), [`lab/scripts/research-srcfate2.sh`](../../lab/scripts/research-srcfate2.sh) (clone-2: P1 project cells + the corrected heading/reminder umd cells), [`lab/scripts/research-srcfate3.sh`](../../lab/scripts/research-srcfate3.sh) (clone-3: the ellipsis-menu heading umd cells via batch). Artifacts (gitignored): `lab/artifacts/srcfate-lab/`, `srcfate2-lab/`, `srcfate3-lab/` (`report.txt`, `snaps/*.json`, `drive-*.log`, `diff_snaps.py`).

**Scope (maintainer directive 2026-08-13, "do every runnable single-VM probe").** This closes the standing worklist: P1 the source-fate reconciliation (the TRSHREP R8/R9 "terminal-element preserve trigger" flag), P2 plain Convert-to-Project, P3 the `timestamps.md` §2c umd micro-cells, P4 the `project.promote-heading` creationDate value, P5 RESTAGE-lite, and P6 the future-scheduled-project representation cell.

> **Method note — driving the NATIVE make-repeating.** The standalone `todo/project make-repeating` CLI now routes through **promote-via-clone** (landed 2026-08-13: clone the source → trash the original → promote the clone), which hides the native source-fate behind a disposable clone the caller never sees. To observe the real app law on a source we own, P1 drives the **native destructive** make-repeating through **`things batch`** (a batch `*.make-repeating` line dispatches the native GUI promote, not promote-via-clone — batch.ts). The `repeating.replacedUuid` field is the authoritative source-fate signal: **`null` = source PRESERVED** (relinked in place as the current-occurrence instance, only the template minted fresh), **a uuid = source DELETED** (identity replacement, template + instance both fresh).

---

## HEADLINE VERDICTS

1. **P1 — the TRSHREP terminal-element preserve hypothesis is CONFIRMED, deterministically (2/2 every cell), and it reconciles the v1 laws WITHOUT a v1→v2 drift.** A fixed `make-repeating` **PRESERVES its source iff the source subtree contains a TERMINAL element** — a completed/canceled child **OR a checked (completed) checklist item anywhere in the subtree** — generalizing RSIM-U's terminal-*child* trigger to a terminal-*element* trigger, on top of the two already-known triggers (a to-do **deadline**, RSIM-T; a project **nested repeater**, RSIM-R). The crux control cell — an **unchecked** checklist item — DELETES, exactly as RSIM-T's checklist cell did, so RSIM-T ("checklist doesn't preserve") was never wrong: it tested an *unchecked* item. The new cells (a *checked* item; an open child *carrying* a checked item) are corners v1 never exercised, not a behavioral change.
2. **P2 — plain Convert-to-Project is an IDENTITY REPLACEMENT** (new project uuid, the old to-do row hard-DELETED), whose `creationDate` = **conversion wall-clock** (not the source's), notes preserved, and whose **checklist items are promoted to child to-dos** (the `TMChecklistItem` rows are consumed; the new project gets that many child to-dos).
3. **P4 — `project.promote-heading`'s new project `creationDate` = conversion wall-clock** (fell inside the measured guest wall-clock window). Identity replacement confirmed; the promoted heading's surviving child is reparented with a **umd BUMP**.
4. **P3 — checklist writes are umd-SILENT; reminder set/clear, title, and notes all BUMP.** Adding/checking/unchecking/renaming/deleting a `TMChecklistItem` leaves the owning to-do's `umd` **byte-identical** (a `things watch` hazard). Reminder set and clear, and `title=`/`notes=` writes, each BUMP.
5. **P5 — reopening a logged PAST-dated to-do restores its ORIGINAL date, not "today".** The reopen is when/index-silent (only `status 3→0`, `stopDate→NULL`, `umd` bump); `startDate`/`todayIndex`/`tiRef` are byte-preserved, so the item lands back on its original (now-past) date and the reader surfaces it in **Today** (overdue) — no re-derivation, no re-stage.
6. **P6 — a future-scheduled PROJECT files as `start=2` + future `startDate`** (same law as a to-do, UPC1/BANNER1), closing the representation question.
7. **Two findings captured (capture-don't-patch):** (a) `project dissolve-heading` and `project move-heading-to-project` are **uninvokable through the CLI** (the commands omit the drive-gui flag yet require it — see below); (b) the ellipsis-`…`-menu heading ops don't resolve the More-button position in the headless golden-v2 rig, so their umd VALUE cells remain unmeasured (a visible-framebuffer sitting is needed).

---

## P1 (SF) — source-fate reconciliation matrix

Native `make-repeating` via `things batch` (`dangerouslyDriveGui`), fixed daily. Source-fate read uuid-by-uuid from raw snapshots **and** cross-checked against the CLI `replacedUuid`. To-do cells in clone-1 (to-dos are selectable in Anytime); project cells in clone-2 (an **area-less Anytime project has no selectable row** — `H-PROJECT-REPEAT`, UIC4-d — so the projects were placed in an area; RSIM-R proved area is irrelevant to fate).

| Cell | source | terminal element? | source fate | `replacedUuid` | reps |
|---|---|---|---|---|---|
| **SF-Tck** | to-do + **CHECKED** checklist item | yes (checked item = status 3) | **PRESERVE** (relinked as instance) | `null` | 2/2 |
| **SF-Tun** | to-do + **UNCHECKED** checklist item | no | **DELETE** | `<source>` | 2/2 |
| **SF-Tbr** | bare to-do | no | **DELETE** | `<source>` | 2/2 |
| **SF-Pcp** | project + **completed** child | yes | **PRESERVE** (`childrenReplaced=0`) | `null` | 2/2 |
| **SF-Pcx** | project + **canceled** child | yes | **PRESERVE** (`childrenReplaced=0`) | `null` | 2/2 |
| **SF-Pok** | project + **open** child carrying a **CHECKED** checklist item | yes (checked item) | **PRESERVE** (`childrenReplaced=0`) | `null` | 2/2 |
| **SF-Pbo** | project + bare **open** child | no | **DELETE** (`childrenReplaced=1`) | `<source>` | 2/2 |

Every cell landed its expected fate on both reps — **deterministic, no residual nondeterminism**. The preserve cases relink the source as the instance (`start=2`, `rt1_repeatingTemplate=<new template>`, `rule=0` — a *preserved source is the instance, not the template*, which is why a naive "source has a rule" check mislabels it; the `replacedUuid=null` / `childrenReplaced=0` signal and the byte-snapshot are authoritative).

### The reconciled law

> **A fixed `make-repeating` PRESERVES its source (relinks it in place as the current-occurrence instance, minting only the template) iff the source subtree contains a TERMINAL element, else DELETES it (identity replacement — template + instance both fresh).** A **terminal element** is any descendant row in a completed/canceled state — a completed/canceled child to-do **OR a checked (completed) checklist item** on the source or on any descendant. In addition, two structural triggers preserve independently: a **to-do deadline** (RSIM-T) and a **project nested repeater** (RSIM-R). Area and When are irrelevant.

This **supersedes and unifies** the prior piecewise statements:
- **RSIM-U** ("all children terminal → preserve; any open child → delete") is the special case where the only rows were terminal. SF-Pok shows a terminal element preserves **even alongside an open sibling** (an open child carrying a checked checklist item preserves) — so RSIM-U's "any open child → DELETE" is too strong; the correct predicate is "no terminal element anywhere → DELETE." This matches TRSHREP R8 (mixed open+completed → preserve) and R9b (open child + checked checklist → preserve).
- **RSIM-T** ("only a deadline preserves a to-do; checklist does not") is intact: its checklist cell was **unchecked** (SF-Tun reconfirms unchecked → DELETE). A **checked** checklist item (SF-Tck) is the newly-exercised terminal-element cell. **No v1→v2 behavioral drift** — the golden-v1 laws hold; the sweep only measured finer cells the v1 matrices skipped.

**Consumer note (not a code change — capture only):** the promote-via-clone determinism note ([design/promote-via-clone.md](../design/promote-via-clone.md)) states the source-fate lottery as "a to-do preserves iff it carries a deadline; a project iff its subtree holds a nested repeater or has no open child." Both clauses are now known to be **narrower than the app** — a checked checklist item preserves a to-do (no deadline needed), and a terminal element among open siblings preserves a project (an open child is not sufficient for DELETE). It remains inert for promote-via-clone (the lottery lands on a disposable clone either way), but the SIMFID `applyMakeRepeatingFixed` preserve predicate is the place the finer law would land if bench fidelity ever needs it: **preserve iff the pre-read subtree contains a terminal row (child status ∈ {2,3} OR any checked checklist item) OR (to-do) a deadline OR (project) a nested repeater.**

---

## P2 (CVT) — plain (non-instance) Convert-to-Project

`todo convert-to-project` (ui vector, direct native — NOT promote-via-clone-wrapped), on a plain to-do carrying notes + two checklist items (one checked). ×2, identical.

**Delta (both reps):** `INSERTED 1 / DELETED 1 / TMChecklistItem −2`.
- **Identity replacement:** a new **project** row is INSERTED (new uuid) and the old **to-do** row is hard-DELETED. `old-uuid fate: exists=0`. NOT an in-place type flip.
- **`creationDate` = conversion wall-clock:** new project `creationDate` = 2026-07-05T12:07:07 (`1783253227`) vs the source's `1783253205` — ~21 s later, the drive wall-clock, **not** preserved. (Closes [timestamps.md](../reference/timestamps.md) §1c "plain Convert-to-Project creationDate".)
- **Content fate:** `notes` **preserved** on the new project; the **checklist items are promoted to child to-dos** — both `TMChecklistItem` rows deleted (`checklistCarried=0`) and the new project gains **2 child to-dos**. (This is the app's genuine Convert behavior: checklist → sub-to-dos. Craft-worthy, not a bug.)

By analogy this is the identity-replacement class of [timestamps.md](../reference/timestamps.md) §1b — CONVINST (repeating-instance convert) is the sibling; a plain convert stamps the same conversion-wall-clock creationDate.

---

## P4 (PHC) — `project.promote-heading` new-project creationDate

`project promote-heading PHC-P PHC-H` (ui vector, direct native), one heading with one headed child.

**Delta:** `INSERTED 1 / DELETED 1 / CHANGED 1`.
- New **project** INSERTED (uuid `FxfTNoai…`), `creationDate` = 2026-07-05T12:08:07 (`1783253287.756`), **inside the measured guest wall-clock window** `[1783253266 … 1783253291]` → **conversion wall-clock**, as expected. (Closes [timestamps.md](../reference/timestamps.md) §1c "promote-heading new-project creationDate".)
- Old **heading** hard-DELETED (`exists=0`) — the settled identity replacement (HEADCERT1-c1).
- The surviving headed child `PHC-c` is reparented: `heading: PHC-H → NULL`, `project: NULL → <new project>`, and its **`umd` BUMPED** (12:07:42 → 12:08:07) — a reparent field-write bump (consistent with WG-2).

---

## P3 (UMD) — userModificationDate bump/silent micro-cells (owning row)

Each op run on a synthetic owning row; `umd` captured immediately before/after (guest wall-clock free-runs from the pinned instant, so a bump is a visible ≥1 s advance and silence is a byte-identical value). All checklist ops verified-landed (`vector=url-scheme … verified`).

| Micro-op | owning-row `umd` | notes | timestamps.md cell |
|---|---|---|---|
| checklist **add** | **SILENT** | item created, owning to-do `umd` byte-identical | §2c checklist |
| checklist **check** | **SILENT** | | §2c |
| checklist **uncheck** | **SILENT** | | §2c |
| checklist **rename** (edit) | **SILENT** | | §2c |
| checklist **remove** (delete) | **SILENT** | | §2c |
| **reminder SET** (`update --when <date> --reminder HH:mm`) | **BUMP** | also sets `reminderTime` (14:30 → `970981376` = `14<<26 | 30<<20`) + `startDate` + `start=1` | §2c reminder |
| **reminder CLEAR** (`update --when today --clear-reminder`) | **BUMP** | `reminderTime → NULL`, `startDate` kept (re-stated `--when` per H-REMINDER-SCOPE) | §2c reminder |
| **title** write (`update --title`) | **BUMP** | | §2c title/notes |
| **notes** write (`update --notes`) | **BUMP** | | §2c title/notes |
| **dissolve-heading** surviving children | **UNMEASURED** | ellipsis-menu drive did not resolve headlessly (below) | §2c dissolve |
| **move-heading-to-project** heading row | **UNMEASURED** | same | §2c move-heading |

**Headline:** **checklist mutations are umd-SILENT on the owning to-do** — the entire granular checklist family (add/check/uncheck/edit/delete) leaves `TMTask.userModificationDate` byte-identical. This directly answers the up-next `things watch` "`modified` granularity" question: a `umd`-keyed watcher **misses checklist edits entirely** — checklist state must be diffed directly (it joins the §2b silent class). The reminder/title/notes cells confirm the general "URL field-writes always bump `umd`" law per-field (title/notes were previously only generalized, not byte-probed).

### The two heading-op umd cells — why UNMEASURED (a residual + a CLI bug)

`project dissolve-heading` and `project move-heading-to-project` drive the heading row's **ellipsis `…` menu** (Delete / Move…). Two independent obstacles:

1. **CLI-uninvokable (a shipped bug — [up-next.md](../up-next.md) small-code).** The CLI commands are wrapped in `addWriteFlags(...)` only — **no `addDriveGuiFlag`** — so `--dangerously-drive-gui` is rejected as an *unknown option*; yet without it the op fail-closes `blocked:H-UI-DRIVE` ("pass dangerouslyDriveGui"). There is therefore **no CLI invocation that reaches these two ops** — the `--help` text instructs a flag the command does not register. (`things batch` with `options.dangerouslyDriveGui:true` DOES reach them — both are pipeline-registered CommandSpecs — which is how clone-3 drove them.)
2. **Ellipsis-button position doesn't resolve headlessly.** Even via batch, both ops fail-closed `verify-failed:silent-noop` at *"open the heading's ellipsis menu ('More. <title>') — its on-screen position did not resolve"* (no click sent, no change landed — a clean fail-close, no corruption). The heading `…` More-button frame does not resolve in the headless golden-v2 framebuffer state (an AXDRAG2-class content-row control-position gap). Contrast **promote-heading (P4)**, which drives the row-**select** + `Items ▸ Convert to Project…` menu path (no ellipsis button) and resolves fine.

So the dissolve/move-heading umd VALUE stays **UNPROBED**, now with a documented cause: it needs a visible-framebuffer / on-hardware sitting (and the CLI bug fixed first). Predicted (not asserted): both are FK-rewrites → likely a umd BUMP on the moved/re-homed rows, by the reparent-bump law (WG-2) and the P4 promote-heading child-bump observed here — but this is a prediction, not a measurement.

---

## P5 (RSTG) — RESTAGE-lite: reopening a logged PAST-dated to-do

A to-do scheduled `when=2026-07-05` (today at pin: `start=1`, `startDate=07-05`, `todayIndex=-1570`, `tiRef=07-05`), completed (logged: `status=3`, `stopDate` stamped, scheduling fields preserved), the clock advanced +3 days to **2026-07-08** (its date now in the PAST), then `todo reopen`.

**Reopen delta:** `CHANGED 1` on the row only — `status 3→0`, `stopDate → NULL`, `umd` bump (07-05T12:09 → 07-08T12:00). **Everything else byte-identical:** `start=1`, `startDate=132805248` (07-05, **UNCHANGED**), `startBucket=0`, `todayIndex=-1570` (**UNCHANGED**), `tiRef=132805248` (07-05, **UNCHANGED**).

**Verdict:** reopen is **when/index-silent** — it restores the item to its **ORIGINAL date**, NOT to "today" and NOT re-derived. Because 07-05 is now past relative to 07-08, the reader surfaces it in **Today** (overdue) and **Anytime** (not Upcoming, not Inbox). There is no re-stage: the row keeps its original `startDate`/`todayIndex`/`tiRef` and the *reader* (Today's overdue projection) does the surfacing. This extends the RESID1 reactivate law (L-RESTORE: index/heading/when-silent) to the specific past-date case: the past `startDate` is preserved and shows as overdue-in-Today.

---

## P6 (MISC) — future-scheduled PROJECT row representation

`things:///add-project?title=…&when=2026-07-08` (a future day). Result row: **`start=2`, `startDate=132805632` (07-08), `startBucket=0`, `type=1`.**

**Verdict:** a future-scheduled PROJECT files as **`start=2` + future `startDate`** — the SAME representation as a future-scheduled to-do (the confirmed UPC1/BANNER1 to-do law), NOT `start=1`+future. Closes the [probe-backlog.md](probe-backlog.md) "future-scheduled PROJECT-row representation" cell. (Behaviorally inert post the `scheduleBucket`/`deriveStage` date-first fix, which routes on `startDate != null` before reading `start`; but the representation question is now answered, and any future project fixture that needs a future-scheduled row should seed `start=2`.)

---

## Reproduction notes

- Three clones, ~35 min total (clone-1 ~18 min with 6 native to-do conversions + P2/P4/P3/P5; clone-2 ~12 min with 8 native project conversions + heading/reminder umd; clone-3 ~7 min two batch heading drives). Each clone torn down at teardown; golden immutable; ≤1 clone alive at a time; 24 GB free after.
- Native make-repeating driven through `things batch` (dispatches the destructive native promote, not promote-via-clone). Project cells area-placed to satisfy the `H-PROJECT-REPEAT` row-selectability requirement (area irrelevant to fate, RSIM-R). Fixtures fully synthetic (`SF-*`, `CVT*`, `PHC-*`, `UMD-*`, `RSTG-*`, `MISC-*`).
- The clock advance for P5 used the RSIM-S small-step technique (quit → `sudo date` +3 days → warm relaunch → re-airgap); no reboot, helpers intact.
- **Residuals:** the dissolve/move-heading umd VALUE (ellipsis-menu position unresolved headlessly + the CLI drive-gui-flag bug — both captured to up-next); a full byte-diff of the SF preserve cases' template/instance child-copy shape (out of scope here — RSIM-R/RSIM-S already characterized the subtree copy; SF only needed the source-fate axis).
