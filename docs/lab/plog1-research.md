# PLOG1 — completed project + restored (open) trashed child: the log-sweep verdict

Campaign script: [`lab/scripts/research-plog1.sh`](../../lab/scripts/research-plog1.sh). One `--vnc-experimental` clone of `things-lab-golden-v1` (Things 3.22.11, clock-pinned 2026-07-05), run `things-run-plog1-20260713-184245`. Discovery campaign (no assertions); ground truth is the DB row deltas, corroborated by the GUI screenshot sequence (gitignored under the run's artifacts dir, like the `.ips` crash captures). Sibling of the trashed-child black-hole family — read oddities [§6/§6½](../things-app-oddities.md) first; the report-ready bug write-up is oddities **§6¾**.

**Why a dedicated doc (not an e-suite addendum):** this is a four-stage GUI narrative with its own screenshot sequence and a model finding (derived-Logbook boundary), matching the standalone pattern of [upcoming-research.md](upcoming-research.md) / [headless-research.md](headless-research.md). E15 in [e-suite-results.md](e-suite-results.md) (the scriptable Put-Back-to-Inbox) gets a cross-link; the *in-place, project-preserving* Put Back probed here is a different affordance.

## Origin

Mike found this on his live GUI and explicitly would not test it on prod ("I don't want to risk corrupting my prod database"). The reproduction, verbatim: a project has a trashed to-do child; mark the project completed — the "mark remaining items completed/canceled?" modal does NOT appear; restore the to-do from Trash back into the project → a completed project containing an open to-do. Unknown until now: what happens when that project is swept to the Logbook.

## The model that explains everything: "logged" is a derived time-boundary

There is **no per-row "swept/logged" bit**. Logbook membership is computed: an item shows in the Logbook when `status IN (2,3) AND stopDate ≤ logBoundary`. With `logInterval=Manually` (4) the boundary is `manualLogDate`; the AppleScript `log completed now` verb only **advances `manualLogDate`** — it mutates zero task rows (A28/LOGNOW, reconfirmed here). Consequence: the sweep is a moving clock line, not an event that touches children. An open child of a completing project is never reconciled — it is simply carried across the boundary, still `status=0`, when its parent crosses.

The golden default is `logInterval=0` (Immediately), which collapses the before/after-sweep window (everything completed is instantly past the boundary). This campaign set **Manually** via Settings → General so the completed-but-unswept intermediate state is observable and the sweep is a discrete, triggerable event.

## Verdicts (a–d)

| Probe | Setup | Verdict |
|---|---|---|
| **PLOG1-a** | Project P: T1 (open, then trashed) + T2 (completed). Complete P via its GUI circle. | **NO modal.** P → `status=3` immediately, silently. T1 untouched (`status=0`, `trashed=1`). **Control** C (open *non-trashed* child) completed via the same gesture **DOES** raise the sheet: *"There is still 1 to-do in this project that you haven't completed… Mark as Completed / Mark as Canceled / Cancel."* The contrast proves the modal counts only **non-trashed** open children. The trashed T1 is also **filtered from P's own project view** (§6½) — it is invisible there while trashed. |
| **PLOG1-b** | logInterval=Manually. GUI **Put Back** T1 from Trash (right-click → Put Back). | T1 restored: `trashed=0`, `status=0`, **`project` = P (ref intact)**. **P stays `status=3`** (stopDate unchanged). **Put Back does NOT reopen the completed project** — a direct contradiction of §5b (moving/adding an open child reopens a resolved project). The GUI then renders a **checked (completed) project header above an UNCHECKED (open) child row**. Because P.stopDate > manualLogDate, P is still checked-in-place (Anytime/sidebar), not yet in the Logbook. |
| **PLOG1-c** | `log completed now` (advances manualLogDate past P.stopDate). | **T1 UNCHANGED**: `status=0`, `trashed=0`, `project=P`. Not force-completed, not orphaned, not trashed. P moves into the **Logbook** (derived). The open T1 **leaves Anytime with its parent** — it is now absent from Anytime, Today, and Inbox. It is reachable **only by opening the logged project from the Logbook**, where it renders as an unchecked open row inside the checked project. An actionable open to-do has effectively vanished from every actionable view. The Logbook lists P with a **"1" child-count badge**. |
| **PLOG1-d** | Fresh Q + trashed child U1; complete Q via URL; **sweep first** (Q logged); **then** Put Back U1. | Completing Q via `update-project?completed=true` left the trashed U1 alone (`status=0`, `trashed=1`) — **the URL project-complete cascade ignores trashed children too**, the same blind spot as the modal (parallels §3). After the sweep Q is in the Logbook. Put Back then restores U1 **straight into the logged Q** (`trashed=0`, `status=0`, `project=Q`); **Q stays `status=3`/logged** (not reopened, not pulled out of the Logbook). U1 is absent from Anytime/Today/Inbox — **identical invisible-open-child end-state as (c)**. Restore-before-sweep and restore-after-sweep converge. |

No crashes, no `DiagnosticReports`, app responsive throughout (this family has produced crash-catalog entries before — none here).

## Row-level evidence (final.sqlite)

```
-- PLOG1-b, after Put Back (before sweep):
PLOG1-P        type=1 status=3 trashed=0  stopDate=1783253325   -- completed, in place
PLOG1-T1-OPEN  type=0 status=0 trashed=0  project=R58M3Bcw…     -- OPEN, back in P
-- PLOG1-c, after `log completed now` (manualLogDate 1783252800 → 1783253488):
PLOG1-P        status=3  (unchanged)                            -- now stopDate < boundary ⇒ Logbook
PLOG1-T1-OPEN  status=0 trashed=0 project=R58M3Bcw…            -- STILL OPEN, unchanged by the sweep
-- PLOG1-d, Put Back after sweep:
PLOG1-Q        status=3 (logged, unchanged)
PLOG1-U1-OPEN  status=0 trashed=0 project=5qsSftuP…           -- OPEN, inside the logged project
```

## Screenshot sequence (artifacts, gitignored)

`lab/artifacts/things-run-plog1-20260713-184245/`:
- `09-P-completed-nomodal.png` — P's header circle turns to a filled blue check with **no sheet** (the modal-skip).
- `10-C-control-modal.png` — the control project raising the mark-remaining sheet (proof the modal fires for a non-trashed open child).
- `11-trash-view.png` / `12-t1-context.png` — T1 individually in Trash with "PLOG1-P" muted; the right-click menu with **Put Back** at the top.
- `13-P-completed-with-open-child.png` — **the money shot**: completed project header (blue check) above `PLOG1-T1-OPEN` unchecked.
- `14-logbook.png` — P in the Logbook under "Today" with a "1" child-count badge.
- `15-P-from-logbook-open.png` — drilling into the logged P: `PLOG1-T1-OPEN` renders unchecked (open) inside the checked project.
- `17-Q-logged-with-open-U1.png` — the (d) end-state: logged Q containing the open, freshly-restored U1.

## Implications for our own surfaces

We do not create this state, but our reads/writes are adjacent to it — see the follow-up in [docs/up-next.md](../up-next.md) §5 (hidden-open-child hint on logged-project views; `project complete`/`project restore` doctrine review; whether `today`/`anytime` should surface checked-unswept parents' open children).
