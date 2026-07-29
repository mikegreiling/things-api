# API doctrine — the enshrined principles

This is the design canon for the things-api contract: the principles that decide what a response looks like, written for the maintainers who will extend it (human and AI alike). It is the *why* behind the *what* in [docs/contract.md](../contract.md); when a new view or operation has to be shaped, these principles decide it. They are ordered from the most structural to the most agent-specific.

The rules exist so the same arguments never have to be re-litigated per feature. Where a principle constrains something, the constraint is the point — a small, learnable contract is worth more than any local convenience that would erode it.

## 1. One grammar, learned once

Every response is an instance of one small grammar: an envelope (`apiVersion`, `ok`, `kind`, `data`, `meta`), a fixed set of `data` wrappers (`item`, `view`, `items`, `sections`), and one error shape. A consumer learns the grammar once and can then read a response to a command it has never seen, because the command's payload is just another instance of a class it already understands.

The design rule that follows: **a new view is an instance of the grammar, never an exception to it.** When a new read is added, it picks the wrapper its shape already fits (`items` for a flat list, `sections` for a split, `view` for a composite card, `item` for a single entity) — it does not invent a sixth container or root `data` at a bare array. The test to apply before shipping any new response is the ten-sentence test: if the envelope grammar in [docs/contract.md](../contract.md) can no longer be stated in ten sentences after your change, the change is wrong — either it belongs under an existing wrapper, or the grammar genuinely needs to grow and that growth is a deliberate, documented, contract-level decision, not a side effect of a feature.

## 2. The envelope speaks for the transport; the payload speaks for the domain

There is a hard line between the two layers of every response. The **envelope** answers transport-level questions — did the call succeed (`ok`), what shape is the payload (`kind`), how complete is it (`meta.truncation`), why did it fail (`error`). The **payload** (`data`) answers domain questions — what is this to-do's `status`, its `start` state, its tags. No success field ever lives inside `data`: a mutation's payload carries the observed result fields, but the *fact* that it succeeded is `ok: true` and nothing else. This is why the 1.0 shape break dropped the redundant `result`/`kind` discriminator from mutation payloads entirely — the envelope already carried call success, so repeating it in `data` was two words for one job (see principle 6).

The rationale is the envelope-school design: an envelope that is uniform across every operation lets a consumer write one response handler — check `ok`, switch on `kind`, read `meta` — instead of a bespoke parser per call. Mixing domain success signals into the payload forces the consumer to know, per operation, where to look for "did it work"; keeping that signal in the envelope means the answer is always in the same place. The domain data stays pure: `data` is only ever *about the user's stuff*, never about the call that fetched it.

## 3. Errors are product

An error is not the absence of a result; it is a result with its own contract. Every error answers three questions machine-readably: **what** happened (`error.code` from the frozen registry), **why** (`message`, and `likelyCause` when signals point somewhere), and **what to do next** (`remediation`, and the structured `error.detail`). An error a consumer cannot act on is a bug in the error, not just in the call.

The `error.detail` object is where self-correction lives. `candidates` (did-you-mean matches for an unresolved reference) and `suggestions` (the concrete command to run instead of a bare verb) exist so that an agent can fix its own mistake from the error payload alone — no second discovery round-trip. When a name is ambiguous, the response hands back the uuid-bearing candidates; when a verb is incomplete, it hands back the exact command that completes it. The measure of a good error here is whether the next correct action is already in the consumer's hands when the error arrives. This is the same instinct behind honest truncation and teaching responses (principle 7): the response carries what the consumer needs to proceed, rather than making it ask again.

## 4. The mutation lifecycle

A mutation moves through five stages, and each has a doctrine.

- **Preview.** A dry-run returns a plan — the compiled invocation (token-redacted), the chosen vector and tier, the guards checked, and the expected delta. The plan is the *same object* the executor consumes: previewing and executing differ only in whether the plan is dispatched, so a preview can never diverge from what a real run would do.
- **Idempotency.** A batch line may carry a caller-supplied `opId`; a resubmitted line whose `opId` matches a recent ok record is skipped as `already-applied` rather than re-executed, making an ambiguously-failed batch safe to resend. Single-op idempotency (a caller key on one mutation, for the retry-after-timeout case) is a queued design round, not yet shipped — the batch `opId` is the mechanism that exists today.
- **Verification.** `ok: true` means the expected change was OBSERVED in the database via read-after-write, not merely submitted. This is the project's crown jewel: it is what lets a consumer trust a result without a confirming read, and it is why a silent no-op is a first-class failure rather than a false success.
- **Reversal.** Every successful mutation returns an `undoToken`, and the machinery to invert it is universal — an inverse where one exists, an explicit irreversible flag where none does. Reversibility is a reported property of the result, never something the caller has to discover elsewhere.
- **Partial failure.** A batch reports a per-line `outcome` and a summary derived from those lines, so the two can never disagree; the aggregate exit code is the single worst outcome under a fixed precedence. Honesty about *which* legs landed is worth more than the tidiness of an all-or-nothing story the app layer cannot actually provide.

## 5. Self-description

The surface describes itself, so a consumer needs no out-of-band knowledge to use it. Three artifacts carry the self-description: `capabilities` / the legend (the operation × vector support matrix, disruption tiers, per-op reversibility and certification), the MCP tool schemas (typed inputs a model reads directly), and the generated envelope schema (the machine-readable form of [docs/contract.md](../contract.md)). Between them, an agent can discover what operations exist, what each one does, what it returns, and how to validate the return — all from the surface itself. A capability that exists but is not discoverable through one of these is, for an agent, a capability that does not exist.

## 6. One word per concept

Each reserved word in the contract means exactly one thing, everywhere. `ok` (and the exit code) is call success; `kind` is the payload class and nothing else; `outcome` dispositions a JSONL stream line and appears nowhere else; `status` is a resource's domain lifecycle; `error.code` plus `error.detail` say why a call failed. These five are deliberately kept from ever standing in for one another — the single most common way to misread a response is to conflate two of them, so the grammar refuses to overload them.

The glossary in [docs/contract.md](../contract.md) is not documentation *about* the contract; it is a contract *artifact* — the authoritative list of reserved words and their single meanings. Adding a word, or giving an existing word a second sense, is a contract change. On the description surfaces (CLI `--help`, MCP tool text, exported JSDoc) the same discipline is enforced mechanically: the banned-vocabulary tests in [surface-copy.md](surface-copy.md) fail the build if a description reaches for mechanism vocabulary instead of the one agreed word for a behavior. Shared parameter vocabulary lives in code (`src/surface-copy.ts`) and is used verbatim across surfaces, so a word learned on the CLI transfers to MCP unchanged.

## 7. Agent-native principles

The primary consumer is an agent with no out-of-band knowledge, and three properties follow from taking that seriously.

**Affordances in the response.** A response carries not just data but the consumer's next correct action. `meta.truncation` tells it whether to page for more; `meta.resolvedCommand` tells it the canonical command its sugar form became, so it can learn the stable spelling; a teaching error hands back candidates and suggestions so it can self-correct. The response is designed so that an agent driving the surface for the first time is nudged toward the right next call rather than left to guess.

**Token economy is a correctness concern.** When the consumer pays per token, information density is not cosmetics — a response bloated with `null`s, empty arrays, and redundant discriminators costs the consumer real budget and buries the signal. This is why omit-empty prunes empty fields, why the redundant success discriminator was dropped, and why the no-redundant-ancestry and named-detail-tier rounds (R6/R7, queued in [docs/up-next.md](../up-next.md)) exist: an item inside a project view should not repeat the project it is plainly inside, and a list view should default to a compact line-item rather than a full record. Density that preserves completeness (honest truncation still holds) is a form of correctness.

**Determinism as a testable property.** Same database state plus same command yields the same bytes, modulo `elapsedMs`. Additive `meta` fields appear only when their condition holds, so the shape does not wobble between identical calls, and a consumer can key on presence. This makes responses diffable, cacheable, and testable — determinism is not an aspiration here but an asserted invariant.

---

Cross-references: the consumer-facing covenant and registries are in [docs/contract.md](../contract.md); the description-surface vocabulary rules in [surface-copy.md](surface-copy.md); the architecture, the consumer air gap, and the ALPHA-CONTRACT doctrine in [architecture.md](architecture.md); the move-vs-reorder and heading-demotion shape decisions that these principles were pressure-tested against in [heading-demotion-and-move.md](heading-demotion-and-move.md).

<sub>**Influences.** The envelope-school split of transport-signal from domain-payload, the notion of errors as a first-class product surface, and idempotency keys on mutating operations are established patterns in modern HTTP and RPC API design; this document states them in the project's own terms rather than by external name. No external contract is imitated wholesale — the shapes here are derived from `src/contracts.ts`.</sub>
