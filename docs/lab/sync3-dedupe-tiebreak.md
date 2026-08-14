# SYNC3 — SY-3b cross-device spawn-dedupe tiebreak

**Environment.** `things-lab-golden-v2` · Things **3.22.12** (build 32212016) · macOS 15.7 guest · DB schema v26. Two NETWORKED clones (A, B) booted **concurrently** (the 2-VM ceiling), both signed into **durable throwaway Things Cloud account #2** via the LOGIN path. Clock **PINNED 2026-07-05** for login (trial valid, TLS to `cloud.culturedcode.com` == 200 — the SYNCLAT recipe); occurrence days advanced +1/+2/+3 (07-06/07/08, all < ~07-17 trial expiry). Script: [lab/scripts/research-sync3.sh](../../lab/scripts/research-sync3.sh) (`core`/`swap` phases). Runs **2026-08-14**. Builds directly on [sync2b-durable-account.md](sync2b-durable-account.md) SY-3 (the single-run observation this campaign disambiguates) and the SYNC2 per-attribute 3-way merge ([headless-research.md](headless-research.md)).

**Documented airgap deviation (sanctioned).** As with SYNC2B/SYNCLAT, these probes REQUIRE the sync server, so the harness airgap default is deliberately overridden — network stays UP for the clones. Everything else (READS-only prod, writes via official surfaces, disposable VMs) is unchanged. The host Things app/container and Mike's real Things Cloud account are **never** touched.

**Account provenance (no-churn doctrine stands).** Durable account **#1** (minted for SYNC2B on 2026-08-13) was **orphaned on 2026-08-14** by an orchestration accident: its gitignored credentials were written only under the provisioning agent's ISOLATED worktree `lab/artifacts/`, and the orchestrator's worktree cleanup destroyed them (gitignored files do not travel with a merge). #1 was **never burned server-side** — it sits idle and will lapse with its trial. Durable account **#2** was minted **2026-08-14** as its one-time accidental-loss replacement (not churn), and its credentials now live in the **PRIMARY checkout's** gitignored `lab/artifacts/sync-durable-account/` by absolute path (the root-cause fix — see [harness.md](harness.md) "Durable artifacts"). The no-churn doctrine is unchanged: one durable account, LOGIN-only, reused for all future sync probes; no credentials in any committed file, ever.

## The question (SY-3 residual)

SY-3 observed that when two disconnected devices each materialize the SAME occurrence of a synced daily repeater and then reconverge, exactly ONE instance is present afterward on each device (A=1, B=1) — and in that single run the surviving row was B's (the non-UTC / America/Chicago device, whose local-midnight `creationDate` is numerically LATER than the UTC device's). But **sync-arrival order was confounded** (B reconnected second). The tiebreak law was unresolved: does the later-`creationDate` row win, the earlier, or the last/first to arrive?

## Method

Two clones per the SYNC2B recipe (A = guest-default UTC, B = `America/Chicago` CDT −5). Both LOGIN to durable account #2 (merge = "Keep only cloud"; the identical golden seed converges to 34 `LAB-%` rows, template lineage `LAB-REPEAT-DAILY` uuid `W3PZB9e7W6BEtKmEKP4deG` on both). The dedupe scenario was run THREE times with **forced reconnect orders** and, on the third, **swapped zones**, so the three candidate laws separate cleanly:

- Take both TRULY offline (quit Things, delete both default routes, `curl cloud == 000`), advance both clocks +1 day, relaunch Things on each **while disconnected** → each independently materializes that day's occurrence. Apply a per-device **marker note** to the minted instance (`SY3B-R<n>-A` / `SY3B-R<n>-B`) — the byte-exact provenance identifier of whatever survives. Capture the full candidate row set (uuid, `creationDate`, `userModificationDate`, `notes`) on both.
- Reconnect in a **forced order** (reboot → re-pin clock with NTP off, before Things relaunches → relaunch): the first device pushes alone; the second then pulls + pushes, triggering reconvergence. Capture the surviving row on both.

| Run | day | zones | reconnect order |
|---|---|---|---|
| **R1** | 07-06 | A=UTC, B=Chicago | **A first**, then B |
| **R2** | 07-07 | A=UTC, B=Chicago | **B first**, then A (opposite of R1) |
| **R3** | 07-08 | **A=Chicago, B=UTC** (swapped) | A first, then B |

R1 vs R2 (opposite orders, same zones) separate arrival-order from device/value-stable. R3 (zones swapped, so the numerically-later `creationDate` now belongs to A) separates a device-identity law from a value-based (`creationDate`) law.

## Results (per-run evidence)

**The spawned instance uuid is DETERMINISTIC.** In every run BOTH devices minted the *identical* uuid for the occurrence (`U8NHn3sSbJx5rGUmVrgRGB` for 07-06 — which is exactly the uuid SYNC2B recorded as its "winner" — `4C2ZHqnWMgfV1H1FbGv2uj` for 07-07, `Rq7iSVWibYBfidDrHX5UVi` for 07-08). The instance uuid is derived from the template lineage + the occurrence, not minted randomly per device. So this is **not a two-row dedupe with a winner** — it is an **add/add reconciliation of ONE shared-uuid row** via Things Cloud's per-attribute 3-way merge (SYNC2 semantics). This refines SYNC2B SY-3, which reported "different instance UUIDs"; the winner uuid it recorded is precisely the deterministic uuid both devices share.

Candidates (pre-reconvergence) and survivor (post), byte-exact from the snapshots (`creationDate`|`umd`):

| Run | reconnect-first | A candidate (uuid shared) | B candidate | SURVIVOR (both views, count=1 each) |
|---|---|---|---|---|
| **R1** 07-06 | A | `cd=1783296000` (UTC midnight) · `umd=…339242.805` · `SY3B-R1-A` | `cd=1783314000` (CDT midnight, +5 h) · `umd=…357244.857` · `SY3B-R1-B` | `cd=`**`1783314000`** · `umd=`**`…357244.857`** · notes `SY3B-R1-B⏎⏎--⏎⏎SY3B-R1-A` |
| **R2** 07-07 | B | `cd=1783382400` (UTC midnight) · `umd=…425643.159` · `SY3B-R2-A` | `cd=1783400400` (CDT midnight) · `umd=…443645.149` · `SY3B-R2-B` | `cd=`**`1783400400`** · `umd=`**`…443645.149`** · notes `SY3B-R2-A⏎⏎--⏎⏎SY3B-R2-B` |
| **R3** 07-08 (swap) | A (=Chicago) | `cd=1783486800` (CDT midnight) · `umd=…530042.772` · `SY3B-R3-A` | `cd=1783468800` (UTC midnight) · `umd=…512044.807` · `SY3B-R3-B` | `cd=`**`1783486800`** · `umd=`**`…530042.772`** · notes `SY3B-R3-B⏎⏎--⏎⏎SY3B-R3-A` |

Reading the three runs:

- **Not arrival/reconnect order.** R1 reconnects A first yet A's values do NOT survive (B's do); R2 reconnects B first and B's survive; R3 reconnects A first and A's survive. The one row where the first-reconnected device's values lost (R1) falsifies "first-arriver wins," and the split across R2/R3 falsifies "last-arriver wins." Reconnect order does not decide the outcome.
- **Not device-identity.** In R1/R2 the non-UTC device is B and B's values survive; in R3 the zones are swapped so the non-UTC device is A, and A's values survive. The winner **follows the zone, not the device** — a device-stable law is ruled out.
- **YES — the numerically GREATER value survives, per attribute.** In all three runs the survivor's `creationDate` is `MAX` of the two candidates and its `userModificationDate` is `MAX`. Because a device west of UTC reaches local midnight LATER in absolute time, the non-UTC (Chicago) device always holds the numerically-later `creationDate` — which is why B won SY-3 and R1/R2, and why A wins once it is the Chicago device (R3).
- **`notes` merge as a UNION, not overwrite.** The survivor carries BOTH devices' marker notes, concatenated with a `\n\n--\n\n` separator (e.g. `SY3B-R1-B\n\n--\n\nSY3B-R1-A`). A whole-row last-writer overwrite could not produce a union; this is the proof that reconvergence is a **per-attribute** merge on the one shared uuid, with each attribute resolved on its own (scalars → max; text → union), rather than a row-level winner-take-all. (Observed but not load-bearing: the union's ordering varied — the second device's note appears first in R1/R3 and second in R2 — so the separator order is not a stable provenance signal; the surviving `creationDate`/`umd` values and the marker text together are.)

### The reconciled law (SY-3b)

> Two disconnected devices that materialize the same occurrence of the same synced repeating template each mint the **identical deterministic instance uuid**. On reconvergence Things Cloud performs a per-attribute **add/add 3-way merge** on that single row — there is never a true duplicate. For the timeline scalars the merge takes the **numerically greater value** (`creationDate` → MAX, `userModificationDate` → MAX); free-text (`notes`) merges as a **union**. The outcome is **device-independent and reconnect-order-independent**: the surviving `creationDate` is `MAX(local-midnight)`, i.e. the later local midnight — the non-UTC/western device's — regardless of which device reconnected first. This resolves the SY-3 winner-tiebreak residual: SY-3's "B's row won" was `MAX(creationDate)` selecting the later local midnight, not an arrival-order or device tiebreak.

**Honest caveat (cd vs umd co-variance).** By construction the device with the later local-midnight `creationDate` (the Chicago device, whose pinned "noon local" is a later *absolute* instant than UTC noon) also stamped the later `userModificationDate` on its marker note, so `creationDate` and `umd` co-varied and both resolved to `MAX` toward the same device in every run. These runs therefore cannot *independently* prove "`creationDate` maxes on its own" versus "`creationDate` follows the higher-`umd` side." What they DO establish unambiguously: the resolution is **per-attribute** (the `notes` union proves it is not whole-row LWW), the surviving `creationDate` is always the greater of the two, and the winner is value-based, not arrival-order or device-stable. Cleanly separating `creationDate`-max from `umd`-max (force one candidate's `umd` above the other's while its `creationDate` stays lower) is a queued micro-residual, not needed to answer the tiebreak question.

## Residuals (queued, not silently dropped)

- **`creationDate`-max vs `umd`-max isolation** — see the caveat above; a one-run follow-up with `umd` forced opposite to `creationDate` would settle whether each scalar independently maxes. Low priority (the tiebreak question is answered).
- **On-hardware push/pull cadence / APNs-woken receiver** — unchanged from SYNC2B: needs real hardware, not an account gate.
