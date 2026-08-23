# Behavioral canary for the private reorder command — design (DRAFT, awaiting maintainer ratification)

Status: **drafted 2026-08-23, not ratified, not implemented.** Open decision points for the maintainer are listed at the end; nothing here is built until they are settled.

## Problem

Things 3.23 left `_private_experimental_ reorder` DECLARED in the sdef but SILENTLY INERT (gv4-323-certification.md; o-suite ≥3.23 rows assert `deltaEmpty`). The shipped mitigation is a hardcoded version gate (`privateReorderIsNoOp`, ≥3.23, `src/write/experimental.ts`) plus the pre-dispatch block in the pipeline. Two protections are still missing:

1. **A host whose app moves between lab runs.** The declaration canary (sdef presence) catches a *removed* command; nothing at runtime catches a command that stays declared but stops (or starts) working.
2. **A self-lifting gate.** The ≥3.23 range is open-ended: if Cultured Code fixes the command in 3.24, every host keeps refusing/degrading until a lab run turns the o-suite rows red AND a code change lands. The gate should lift itself on the first proven success instead.

## Design: layered verdicts, probe-by-first-write

Layer 0 — **declaration canary** (shipped, unchanged): the command absent from the sdef → surface refused, nothing probed.

Layer 1 — **measured-build seed table**: replace the open `>= 3.23` range with a table of *exact builds we measured in the lab* (today: `3.23 (32300036) → inert`; earlier certified goldens → working). A build in the table needs no runtime probe. The o-suite remains the lab-side instrument that populates this table.

Layer 2 — **cached runtime verdict**: a per-host verdict file in the state dir keyed by `(app version, build, sdef hash)`. Any key change invalidates the cache. Values: `working` | `inert`, each carrying the ISO timestamp and the evidence shape (which write proved it).

Layer 3 — **attempt-and-memoize**: when the key is in neither table nor cache (an app build newer than our lab evidence), the first native-eligible write ATTEMPTS the native wire and reads back:

- requested order landed → cache `working`; the gate has lifted itself.
- clean `deltaEmpty` read-back (the measured 3.23 signature) → cache `inert`, then degrade to the park+re-enter MOVE/bounce fallback *within the same write* where a fallback exists, or refuse loudly where none does (heading order, template-bearing wires).
- timeout, error, or a PARTIAL application → **do not cache**; fail the write loudly (verify-first discipline). A transient must never brand a working surface inert, and a partial landing is a fresh app bug to report, not a verdict.

A probe attempt is only informative when the requested order differs from the current order; a same-order request skips the probe (no information) and does not cache.

Why attempt-by-first-write rather than a standalone probe: the burned attempt costs one inert AE round-trip **once per app build** — negligible — and it needs no scratch data because the measured inert mode is *fully side-effect-free* (`deltaEmpty`). The write that triggers it either succeeds natively (command works) or falls back/refuses exactly as the hardcoded gate does today.

## Optional explicit diagnostic (opt-in only)

`things doctor --probe-native-reorder`: create a throwaway project with two synthetic to-dos via the URL scheme (official surface), issue a native swap, read back, trash the scaffolding, and stamp the Layer-2 cache. Gives an on-demand verdict with no real write pending. It MUTATES the user library (creates + trash residue + sync traffic), so it must be explicit and opt-in, never automatic — and it is strictly optional: Layer 3 covers the need without it.

## Failure-direction argument

The fail-closed direction is **positive proof to enable**: `working` is only ever cached from a verified native success; `inert` only from a clean measured no-op; everything ambiguous stays `unknown` and is re-attempted next time. The worst false outcome under this rule is one extra inert attempt per ambiguous write — never a wrong order landed (verify catches it) and never a working surface durably disabled by a transient (transients don't cache).

## Decision points for the maintainer

1. **Attempt-and-memoize acceptable?** The first native-eligible write on an unmeasured app build pays one inert AE round-trip before degrading. (Recommended: yes — it is the only shape that needs no scratch mutations.)
2. **Scratch-container diagnostic acceptable as an opt-in doctor flag?** It creates and trashes rows in the real library. (Recommended: yes, opt-in only; ship later or never — Layer 3 suffices.)
3. **Seed table replaces the open ≥3.23 range?** Consequence: a future 3.24 attempts native once instead of refusing pre-dispatch, and the gate lifts itself on success. (Recommended: yes — this is the point of the canary.)
