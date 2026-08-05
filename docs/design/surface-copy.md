# Surface copy: how we describe the API to its consumers

This contract governs every consumer-facing description string: MCP tool descriptions, CLI command/option help, and the JSDoc on exported library methods. It exists because these surfaces are read by agents and developers who should be able to use the API without knowing how it works inside.

**We present ourselves as an interface to Things.** A description says what the call does to the user's data, what its side effects are, and what comes back. If a call cannot do what it says, the caller receives an error that explains why and, where possible, what to pass instead. That contract is implied everywhere and stated nowhere.

## Scope — this governs DESCRIPTIONS, not runtime results (Mike's ruling, 2026-07-16)

The policy and its regression tests govern **descriptions**: `--help` text, help topics, MCP tool descriptions and server instructions, and exported JSDoc — the copy a consumer reads to decide what to call, *before* running anything. That is the "front of the API" the banned vocabulary of rule 2 protects.

**Runtime RESULT and DIAGNOSTIC output is out of scope and MAY name the delivery mechanism and tier as operational fact.** After a call runs, the human-readable success line deliberately reports how the work was done — e.g. `ok todo.update <uuid> (vector=applescript, tier=0, verified)` (`src/cli/commands/writes.ts`) — and `doctor` prints a `── ui vector (Accessibility GUI) ──` section (`src/cli/commands/doctor.ts`). These are reporting *what happened on this run*, not advertising *what a call is for*, so `vector`, tier numbers, and `verified` are appropriate there and are NOT banned. The banned-vocabulary contract tests scan only the description surfaces (`test/mcp/server.test.ts`, `test/cli/help-contract.test.ts`), never result/diagnostic emitters, and must stay that way.

The **JSON envelope** carries `vector`, `tier`, and verification as **structured data fields regardless** — a machine consumer always gets them; they are simply not surfaced in the prose descriptions a human reads to choose a call.

## Rules

1. **State behavior, never mechanism.** "Tags must name existing tags" — not which layer enforces it, not what the app would have done without us, not the word "guard".
2. **No pipeline vocabulary.** Banned from descriptions: *verified*, *read-after-write*, *audit*, *pipeline*, *hazard*, *pre-read*, *drift*, *fingerprint*, *vector*, *probe*, hazard ids (`H-…`), probe-evidence ids (`P16`, `E06`, …), and disruption-tier numbers. These live in `docs/` and in the `capabilities` output — the designated drill-down surfaces — not on the front of the API.
3. **Success means it happened; failure means an error.** Never describe how a result is confirmed. Never enumerate internal failure taxonomies; `--help`/tool descriptions may name the caller-visible error *contract* (exit codes, `remediation` field) in behavior terms.
4. **Side effects that DO belong in descriptions:**
   - **Cascades and permanence.** "Canceling a project also cancels its open to-dos." "Deleting a tag permanently deletes its nested child tags." Confirmation parameters (`dangerously_permanent`, `acknowledge_*`, `children` policies) are described by their *consequence*, never by an internal hazard name.
   - **App disruption.** If an operation activates or drives the Things UI, say so in plain language ("briefly brings the Things window forward"). Silent operations say nothing.
   - **Genuine behavioral trade-offs.** When two ways of expressing an intent produce different *results*, the difference is real API surface: "moving a to-do to the Inbox removes its schedule", "Evening reorders handle at most 10 items". Keep these; they are behavior, not implementation.
   - **Onboarding and environment.** Permission prompts, one-time app settings ("Enable Things URLs"), and setup steps are real side effects of *adopting* the API. They belong in `doctor`, setup docs, and server instructions.
5. **Shared vocabulary is shared code.** The exact wording for recurring parameter formats (`when` values, date/reminder formats, "uuid or unique name") lives in `src/surface-copy.ts` and is used verbatim by the CLI option help and the MCP schemas, so vocabulary learned on one surface transfers to the others. Prose is NOT shared: each surface phrases its own descriptions in its own format for its own reader (a paragraph for an MCP model, a one-liner plus flags for a terminal, type-adjacent notes for JSDoc).

## Enforcement

Contract tests scan every MCP tool description, schema description, and the server instructions (`test/mcp/server.test.ts`) and every CLI `--help` string (`test/cli/help-contract.test.ts`) for the banned vocabulary of rule 2. When one fails, rewrite the sentence in consumer terms or move the detail into `docs/`.

## Where the internals live instead

The verified write pipeline, audit trail, hazard guards, schema-drift gate, disruption tiers, vector matrices, and lab evidence are documented in `docs/design/`, `docs/lab/`, and surfaced structurally by `things capabilities` / the `capabilities` tool and `--dry-run` plans. Consumers who want to know how the machine works are welcome there; consumers who just want to move a to-do should never need to.
