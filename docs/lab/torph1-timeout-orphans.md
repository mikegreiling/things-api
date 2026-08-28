# TORPH1 — timeout orphans and the same-key retry, under real concurrency

**Probed under:** `things-lab-golden-v4` · Things **3.23** (build 32300036) · dbv **27** · pinned clock **2026-07-05** · macOS Sequoia guest · things-api **0.19.4** (branch `mg/intent-records`).
**Driver:** [`lab/scripts/research-torph1.sh`](../../lab/scripts/research-torph1.sh) (`A` `B` `C`). **Record run:** `torph1-20260828-133616`, **11 PASS / 0 FAIL**, beep sentinel **0 beeps** in all three cells.
**Issue:** [#639](https://github.com/mikegreiling/things-api/issues/639).

## Why this campaign exists

`--op-id` promises that resubmitting a write is safe. It was, except in the one window a caller actually retries in: **while the original is still running.** The lookback that keeps the promise ran BEFORE the mutation lock, so a retry fired mid-drive found no record (the original had not written one yet), queued behind the lock, waited the original out, and then executed the whole verb a second time. On a promote that is a second clone, a second trashed original, and a second repeating series.

Nothing could even *see* an in-flight keyed write: the trail's `intent` marker named no process, so `things op-result` had to hedge — "it is still running, **or** the process died mid-flight" — at exactly the moment the difference decides what the caller should do.

Unit tests can simulate the ordering. They cannot prove it against a real app under two real processes, which is what these cells do: **two concurrent `things` processes in one guest**, driving one real Things 3.23.

Every process pair is launched, waited on and reaped inside ONE ssh invocation, so a dropped connection can never orphan a drive (the BEEP1 `measure.sh` rule).

## Cell A — a same-key retry launched while the original is mid-drive

Fixture: a plain to-do; verb: `todo make-repeating --frequency weekly --interval 1 --dangerously-drive-gui --op-id KA`.

The retry is fired on an **observation, not a sleep**: a third process polls `op-result KA` until the key stops reading `unknown`, so the retry provably lands inside the in-flight window. (The first attempt used a fixed 2s sleep and landed during the original's own preflight, before any of the state under test existed — the cell measured nothing and passed anyway. Recorded because it is the standard trap for a concurrency cell: a timing assumption that fails OPEN.)

```
POLLED=9   RETRY_EXIT=4   ORIG_EXIT=0
```

**op-result, while the original was still driving:**

```json
{"opId":"KA","op":"todo.make-repeating","result":null,"uuid":"Kk57ft54j4CUZwwpxCAuWE",
 "ts":"2026-07-05T12:00:20.771Z",
 "holder":{"pid":772,"start":"Sun Jul  5 12:00:20 2026","alive":true},
 "status":"in-flight",
 "note":"the operation is STILL RUNNING — it started 2026-07-05T12:00:20.771Z …"}
```

**The retry:**

```json
{"ok":false,"error":{"code":"blocked:in-flight",
 "message":"an earlier submission with this idempotency key is STILL RUNNING (started 2026-07-05T12:00:20.771Z, pid 772) — it has not recorded an outcome yet, so nothing was run again here",
 "remediation":"poll `things op-result KA` until it reports a final outcome, then act on that; do not resubmit while it is running (…)"}}
```

**Trail for `KA`** (`ts · result · txn role · vector · tier · holder · oracle · durationMs`):

```
2026-07-05T12:00:20.771Z  intent  summary  -   t-   pid772@Sun Jul  5 12:00:20 2026  oracle     dur0
2026-07-05T12:00:20.771Z  ok      summary  ui  t3   noholder                         no-oracle  dur7154
```

**Verdicts.** A1 in-flight reading ✓ · A2 retry refused on the live-holder intent ✓ · A3 **exactly one** series exists afterwards ✓ · 0 beeps.

Note the two records share a `ts` — the composite's intent is stamped with the verb's own `startedAt`, the same instant its summary carries. That is deliberate, and §Findings explains why it is load-bearing.

## Cell B — the holder SIGKILLed mid-drive, then the same key retried

Same fixture and verb under `--op-id KB`. The kill is likewise fired on an observation: poll until `op-result` reads `in-flight`, **then** `kill -9`.

```
POLLED=2
LOCK-BEFORE-KILL: {"pid":947,"ts":"2026-07-05T12:00:50.113Z"}
ORIG_KILLED=137
LOCK-AFTER-KILL:  {"pid":947,"ts":"2026-07-05T12:00:50.113Z"}
```

The lockfile **survives the kill** — nothing unlinks it, which is exactly the stale-lock case the steal path exists for.

**op-result after the kill:**

```json
{"opId":"KB","op":"todo.make-repeating","result":null,"uuid":"RcrdeijtYYuE3jFyx2fdYd",
 "ts":"2026-07-05T12:00:49.948Z",
 "holder":{"pid":947,"start":"Sun Jul  5 12:00:49 2026","alive":false},
 "status":"orphaned",
 "note":"the operation started 2026-07-05T12:00:49.948Z and the process that owned it (pid 947) is GONE without recording an outcome — its app-side change may or may not have landed…"}
```

**The retry** — 1 second, so the stale lock was **stolen**, not waited out (a live-holder wait would have burned the full 30s):

```json
{"ok":false,"error":{"code":"blocked:H-CLONE-SOURCE",
 "message":"the source to-do is in the Trash — a trashed item cannot be cloned",
 "remediation":"restore it first with `things todo restore <uuid>`, then clone"}}
```

That is the full chain working. The retry read the orphaned intent, took its recorded oracle ("a repeating template titled TorphB created since this call started"), re-evaluated it against current state, found the series **absent** — so it did not replay — and ran normally, whereupon it met the killed drive's actual residue at the clone-source guard and refused honestly.

**Trail for `KB`:**

```
2026-07-05T12:00:49.948Z  intent                  summary  pid947@Sun Jul  5 12:00:49 2026  oracle     dur0
2026-07-05T12:00:52.535Z  intent                  summary  pid992@Sun Jul  5 12:00:52 2026  oracle     dur0
2026-07-05T12:00:52.535Z  blocked:H-CLONE-SOURCE  summary  noholder                         no-oracle  dur0
```

The third record is `closeSummaryIntent` doing its job: a refused composite writes no summary of its own, so the machinery appends one to close its intent. Without it the retry's own key would have been left looking permanently in flight.

**Verdicts.** B1 holder reads GONE ✓ · B2 stale lock stolen in 1s ✓ · B3 reconciled-or-refused-honestly ✓ · B4 **nothing double-minted** (0 live templates titled `TorphB`) ✓ · 0 beeps.

### What does NOT get cleaned up (recorded, out of scope)

A killed driver runs no abort path, so whatever it had already done to the app stands. **In this run, `modal sheets standing after the kill = 0`** — the kill landed on the clone/trash legs, which run before the Repeat dialog opens, so no sheet was stranded. The residue was the other shape: the **source row already in the Trash**, which is what the retry then met.

Both shapes are the same gap: nothing on the app side reaps a dead driver's work. That is deputy-side execution and is **out of scope for #639**, which is about the trail telling the truth about such a write, not about undoing it. Recorded here so the gap is not mistaken for closed. A kill landing mid-dialog would strand a sheet instead, and the retry would then meet the sheet-open preflight — the driver reports the sheet census either way rather than assuming which shape it got.

## Cell C — two DIFFERENT keyed promotes launched simultaneously

Two plain to-dos, two keys, both `make-repeating` launched at once.

```
C1_EXIT=0  C2_EXIT=0
ok results = 2 · blocked:lock refusals = 0
live templates: TorphC1=1 · TorphC2=1
```

They **serialized on the mutation lock** — the second waited the first out rather than refusing — and both landed exactly once. This matters for the promote specifically: it selects its promoted row **by title**, so two interleaved composites could have had one pick up the other's clone. The composite-scope lock is what prevents that, and holds under real concurrency.

**Verdicts.** C1 serialized ✓ · C2 neither landed twice ✓ · C3 both landed exactly once ✓ · 0 beeps.

## Findings

1. **The double-checked lookback holds under real concurrency** (A). A retry fired inside the in-flight window is refused at the pre-lock check on the live-holder intent, and the post-acquire re-check catches the narrower race where the original finishes while the retry is between its first answer and the lock. Both endings leave exactly one series.

2. **Supersession must pair intent↔final by `ts`, NOT by position — measured the hard way** (B, iteration 2). The design said "an intent is pending while it is the last record for its key". That is wrong here, and the campaign is what caught it: `readAuditRecords` **re-sorts the whole trail by `ts`**, so file order does not survive the read. A composite's intent was stamped when it took the lock, which is *later* than the summary's `startedAt` — so the intent sorted last and **every finished promote read as permanently in flight**, wedging its key for the whole 7-day lookback window. Two changes fix it together: a composite's intent now carries the verb's own `startedAt` (so an attempt's two records share a `ts`, matching the schema's documented sibling invariant), and both `findPendingIntent` and `opResult` pair by that `ts` instead of trusting order. The re-dispatch shape (intent+final, then a fresh intent) falls out of pairing for free. Regression cells pin both surfaces.

3. **A concurrency cell that fires on a sleep can pass while measuring nothing** (A and B, iteration 1). A fixed 2s delay landed during the original's own preflight — before the lock, before the intent — so cell A "passed" on a replay that had nothing to do with the in-flight path, and cell B killed a process that had not started the work yet. Both now fire on an **observation** (poll `op-result` until the key reads in-flight). Standing rule for any concurrency cell: synchronize on the state you are testing for, never on a duration.

4. **The stale lock is stolen, not waited out** (B): 1s versus the 30s a live-holder wait costs. The lockfile survives SIGKILL; the steal path reads the dead holder and reclaims it.

5. **`op-result` now answers the question the caller actually has** (A, B): `in-flight` with a live pid, or `orphaned` with a dead one — instead of one hedged `intent-only` that made the caller guess between "wait" and "recover".

6. **Nothing double-minted in any cell**, which is the headline: the campaign exists because the old ordering could produce a second series, and none of the three concurrency shapes produces one now.

## Reproducing

```sh
TART_HOME=/Volumes/Workspace/tart bash lab/scripts/research-torph1.sh A B C
#   KEEP=1 leaves the clone up · REUSE=1 attaches to it · SKIP_BUILD=1 reuses dist/
#   lab/scripts/torph1-redeploy.sh re-ships dist/ to a kept clone between iterations
```

Both lab escapes (`THINGS_API_UI_DIRECT=1`, `THINGS_API_WRITE_DIRECT=1`) are applied to every guest CLI call; the beep sentinel is default-on and asserted per cell (cell B allows 4, on the theory that a killed drive could beep — it measured 0).
