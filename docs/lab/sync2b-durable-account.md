# SYNC2B — durable-account Things Cloud sync probes

**Environment.** `things-lab-golden-v2` · Things **3.22.12** (build 32212016) · macOS 15.7 guest · DB schema v26. Two NETWORKED clones (A, B) booted **concurrently** (the 2-VM ceiling), both signed into **ONE durable throwaway Things Cloud account**. Clock **PINNED 2026-07-05** (trial valid "13 days left", TLS to `cloud.culturedcode.com` == 200 — the SYNCLAT recipe; the pinned clock ticks at real rate so last-sync signal deltas == real seconds). Clone **A keeps the guest default zone (UTC / GMT+0000)**; clone **B is pinned to `America/Chicago` (CDT, UTC−5)** for the cross-zone questions. Script: [lab/scripts/research-sync2b.sh](../../lab/scripts/research-sync2b.sh) (`sy1`/`sy2`/`sy3` phases). Runs 2026-08-13.

**Documented airgap deviation (sanctioned).** These probes REQUIRE the sync server, so the harness airgap default is deliberately overridden — network stays UP for the clones (TOMB1/SYNC2/SYNCLAT precedent). Everything else (READS-only prod, writes via official surfaces, disposable VMs) is unchanged. The host Things app/container and Mike's real Things Cloud account are **never** touched.

**Account-reuse doctrine (NO churn).** Unlike TOMB1/SYNC2/SYNCLAT (which each minted-then-BURNED a per-run account), this campaign mints **ONE durable account** and **keeps it alive** — it serves all present and future sync probes so Cultured Code never sees account churn. Minted once in-VM via a [mail.tm](https://mail.tm) inbox (needed only for the one-time 6-digit verify code) + a random 16-char lowercase+digit Things Cloud password, no Apple ID. Credentials + the account's `BSSyncronyMetadata` coordinates live ONLY in gitignored `lab/artifacts/sync-durable-account/` (the repo is public; git history is public; redaction does not unpublish). Future sync runs use the LOGIN path (`sy2`/`sy3`), never re-registration.

## SY-1 — baseline convergence sanity (topology validated)

Both clones logged into the durable account (merge = **Keep only the to-dos from Things Cloud** — the identical golden seed on both clones converges to **34** `LAB-%` rows on each side, no duplication). Then a round-trip in both directions, forcing the receiver's pull with a Things quit+relaunch (APNs push is unavailable in the VM, so a receiver only pulls on relaunch / `things:///show` — SYNCLAT).

| Direction | Action | Result |
|---|---|---|
| A → B | A creates `SY1-A` (`things:///add`) | after B relaunch, **`SY1-A` present on B** ✓ |
| B → A | B creates `SY1-B` (`things:///add`) | after A relaunch, **`SY1-B` present on A** ✓ |

Convergence works both ways; no duplication, no ghost. Each write advanced the writer's push signal within a couple of seconds (A `804945788.955`→`804945824.194`; B `→804945795.720`, NSDate-2001 seconds == 2026-07-05 12:03 UTC — write-triggered push, SYNCLAT-consistent).

### `BSSyncronyMetadata` — re-confirmed under golden-v2/3.22.12, third-account confirmation of the key caveat

Attaching the account flipped `BSSyncronyMetadata` **0 → 11 rows** on A (SYNC1 pre-account = 0), matching the golden-v1 SYNC2 finding under the new golden. Decoding this durable account's 11 rows (raw dump in the gitignored artifacts):

- The **last-sync-attempt timestamp** lives under a **NEW opaque key** (`XZfVzfh8ZXTkw8p1GCGfoo` here) — **different** from SYNC2's `GryCJ44xPcJG6go5KeTZp1` and SYNCLAT's `KgDieoLhfTENjtYqU1sCxX`. This is now the **THIRD independent account** confirming the key is **account-specific**, not universal, so the shipped `doctor` sync-health reader (`src/sync-health.ts`) is right to key off the **value-based nearest-to-now heuristic** (the `BSSyncronyMetadata` bplist-double nearest to now, excluding the ~now+31yr lease sentinel) as its robust primary path rather than any fixed key.
- The account email key, the **shared sync-history UUID** (app-deterministic, shared across both devices), `SYPrepActionNone`, the now+31yr lease sentinel, and the small per-slot monotonic sequence counters are all present as SYNC2 documented — the taxonomy is stable across the version bump. (The concrete email + UUID are live-account identifiers → gitignored artifacts only, never committed.)

## SY-2 — THE GATE: `--preserve-modified` / AS `set modification date` vs Things Cloud

**Verdict: the flag is SYNC-SAFE.** A hand-written *past* `userModificationDate` (`umd`) — exactly what the shipped `--preserve-modified` restore leg writes (`src/write/preserve-modified.ts`: `set modification date of <addressor> id X to floor(preUmd)`) — **propagates cleanly to the peer device AND survives the sync round-trip on the originating device, in BOTH directions, with no duplication / ghost / conflict-UI.** Things Cloud treats `umd` as **ordinary per-attribute synced data, NOT a protected or monotonic sync clock**: propagation is driven by the sync engine's own change-log (the `BSSyncronyMetadata` sequence counters / server change vector), *not* by `umd` ordering, so lowering a row's `umd` neither blocks its own propagation nor gets rejected/clamped by the server.

The target for every probe was a genuinely synced seed row (baseline `umd` byte-identical on A and B before the write). Receiver pulls forced with a Things quit+relaunch (APNs unavailable in the VM).

| Probe | Action | umd on originator (pre → after restore) | umd landed on PEER | umd on originator after round-trip | dup/ghost |
|---|---|---|---|---|---|
| **P1** (A→B) | AS restore `umd` to `floor(preUmd)` on `LAB-ANYTIME-1` (sub-second lower) | `1783055113.80175` → `1783055113.0` | **`1783055113.0`** (peer got the lowered value) | **`1783055113.0`** (survived) | none (A=1,B=1) |
| **P2** (A→B) | AS backdate `LAB-DEADLINE-ONLY` `umd` to **2020-01-01** (extreme) | `1783055114.98961` → `1577836800.0` | **`1577836800.0`** (6-yr backdate propagated in full) | **`1577836800.0`** (survived) | none |
| **P3** (B→A) | AS backdate `LAB-EVENING-1` `umd` to **2020-01-01** on **B** | `1783055113.51667` → `1577836800.0` | **`1577836800.0`** on A (reverse direction) | **`1577836800.0`** on B (survived) | none |

Answering the gate's four sub-questions:
- **(a) Does the edit itself propagate (is propagation driven by something other than `umd`)? YES.** [confirmed by SY-2M below — content rides the change-log independent of `umd`]
- **(b) Does A's restored (older) `umd` survive the round-trip or get rewritten? It SURVIVES** — unchanged on the originator after a full push+pull cycle (P1/P2/P3). The sync engine never bumped it back up.
- **(c) What `umd` lands on B? The restored (older) value** — the peer ends with exactly the hand-written `umd`, so the timeline-silent property propagates: a `changes`/`watch` query on the *peer* also won't surface the edit.
- **(d) Conflict / duplication / ghost? NONE** — one row each side, no merge UI, no split-brain.

**The one residual caveat (fails SAFE).** SYNC2's per-attribute 3-way merge sets a conflicted row's `umd` to the **max** of the two edit timestamps. So if the SAME row's `umd` is edited **concurrently** on another device during the preserve-modified window, that device's fresh (higher) `umd` wins the merge and the row **resurfaces** on the timeline. This is not data loss and not specific to the flag — it is the conservative direction for a `changes --since` consumer (a genuinely concurrent edit is never silently hidden). In the non-concurrent case (the flag's normal use) the restore holds across sync.

**Consequence for the shipped copy.** The `--help`/MCP/skill/`timestamps.md` §4 "**UNSYNCED databases only — interaction with Things Cloud sync is unproven**" caveat is **retired**: the flag is sync-safe against a live Things Cloud store. Replaced with the accurate note (restore is sync-durable and propagates; a concurrent same-row edit elsewhere re-bumps `umd` via the 3-way max-merge, which fails safe).

### SY-2M — content-mutation propagation (the AS vector, answering sub-question (a) cleanly)

sy2 P1's URL `things:///update?...&add-tags=SYNC2B-P1` leg was a **no-op** (A's `umd` never bumped; no tag applied). The diagnostic in SY-2M isolated the cause: a URL `things:///update?...&notes=…` with the golden `auth-token` DID work (notes changed, `umd` bumped `1783055113.0 → 1783252978.43035`), so the token is valid — **URL `add-tags` silently ignores a tag that does not already exist** (unlike the `add` command's `tags=`, it never creates tags), so the no-op was the missing tag, not the token. SY-2M redid the mutation with the **token-free AppleScript vector** (also the surface the shipped flag's restore leg uses):

| Sub-probe | Mutation on A (bumps `umd`) → restore `umd` to `floor(preUmd)` | Propagated to B? | B `umd` | A after round-trip |
|---|---|---|---|---|
| **M1** notes | AS `set notes` = `NOTESMUT-…` (`umd` `…978.43`→`…984.58` bump → restored `…978.0`) | **YES — B notes = `NOTESMUT-…`** | **`…978.0`** (restored) | notes + `umd …978.0` both held |
| **M2** tag (canonical) | AS `set tag names` = `Errand` (`umd` `…978.0`→`…043.34` bump → restored `…978.0`) | **YES — B tags = `Errand`** | **`…978.0`** (restored) | — (no dup: A=1, B=1) |

So a real content edit (notes or the canonical tag apply) **propagates to the peer even though the row's `umd` was restored to an OLDER value** — propagation rides the sync change-log, not `umd` — and the peer receives the lowered `umd` too, keeping the edit off the timeline on both devices. Also observed: the `1783055113.0` baseline seen by these fresh clones is the **floored `umd` from sy2's P1**, i.e. a hand-lowered `umd` is **durably stored server-side** and re-materializes on a fresh device's first sync-down — the restore is not a local-only artifact.

## SY-3 — spawn dedupe + creationDate zone

Both clones carry the SAME synced daily template lineage (`LAB-REPEAT-DAILY`, template uuid `W3PZB9e7W6BEtKmEKP4deG` identical on both), each with 3 pre-existing instances. Both were taken TRULY offline (quit Things, delete both default routes, `curl cloud == 000` verified on each), their clocks advanced **+1 day to 2026-07-06** (A stays UTC, B stays `America/Chicago`), and Things relaunched on each **while disconnected from each other** — so each device **independently materialized the 07-06 occurrence** (instance count 3 → 4 on both, with different instance UUIDs). Then both were rebooted (clean DHCP reconnect), re-pinned to 07-06, and relaunched to reconverge over the cloud.

### Zone (the SERDEL S5 residual — RESOLVED)

The independently-spawned 07-06 instances carried **device-local-zone midnight** creationDates:

| Device | zone | spawned 07-06 instance `creationDate` | = |
|---|---|---|---|
| A | UTC (GMT+0000) | `1783296000` | 2026-07-06 **00:00:00 UTC** |
| B | America/Chicago (CDT, −5) | `1783314000` | 2026-07-06 **00:00:00 CDT** (= `1783296000` + 18000) |

The two differ by exactly the CDT offset (5 h). **A spawned occurrence stamps its `creationDate` at the occurrence day's `00:00:00` in the SPAWNING DEVICE's local zone** — resolving the SERDEL S5 residual (the UTC-only VM could not tell "local midnight" from "UTC midnight"; the non-UTC device disambiguates it).

### Dedupe (the headline — ONE instance, B's row wins)

**After reconvergence there is exactly ONE 07-06 instance on each device (A=1, B=1) — Things Cloud DEDUPED the two independently-materialized occurrences into a single row; no duplicate, no ghost.** The surviving row on BOTH devices is **B's** (uuid `U8NHn3sSbJx5rGUmVrgRGB`, `creationDate 1783314000` = Chicago-local midnight); A's independently-spawned UTC-midnight instance (`1783296000`) was discarded. So:

- Multi-device repeating-instance materialization is **safe** — the app recognizes the same occurrence of the same template lineage across devices and collapses to one instance rather than duplicating (a piece of sync craft; [things-app-craft.md](../things-app-craft.md)).
- The **winner** here was the non-UTC device's row (the one with the numerically LATER `creationDate` / later local midnight). A consequence worth noting: after dedupe the occurrence's stored `creationDate` on EVERY device is the winner's device-local midnight (`1783314000`), so even the UTC device A ends up showing the Chicago-midnight `creationDate` for that occurrence — the surviving `creationDate` is a property of whichever instance won the merge, not each viewer's local midnight. (Single run: the precise winner tiebreak — later `creationDate` vs sync arrival/sequence order — is not isolated; the observed outcome is the later-`creationDate`/non-UTC row surviving.)

## Residuals (queued, not silently dropped)

- **Dedupe winner tiebreak (SY-4 residual).** WHY B's row won (later `creationDate` vs. sync arrival/sequence order vs. a uuid comparison) is not isolated by this single run. A follow-up could force the opposite arrival order (reconnect A first) to separate "later-creationDate wins" from "last-arriver wins".
- **Previously-queued SYNC2 questions (roadmap) — status.** Baseline convergence + `BSSyncronyMetadata` taxonomy (SY-1) and the timestamp-merge / `umd` sync-safety (SY-2) are answered. The **on-hardware push/pull cadence** and **sender-side stale-panel repro** (the SYNCLAT residue) remain **needs-hardware** — the VM cannot reproduce a real APNs-woken receiver, so they stay queued as on-hardware items, not run here.


