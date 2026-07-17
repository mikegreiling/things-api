# bench — build-time facts (not doctrine)

Concrete library APIs the harness was built against, so a later reader does not have
to re-derive them. These are engineering facts about pinned dependency versions, not
project doctrine (doctrine lives in [CONSTITUTION.md](CONSTITUTION.md)).

## Pinned dependencies (devDependencies, exact)

- `@earendil-works/pi-agent-core@0.80.10` — agent loop + tool runtime
- `@earendil-works/pi-ai@0.80.10` — unified LLM API (peer of agent-core)
- `just-bash@3.1.0` — simulated bash + virtual filesystem (the sandbox)
- `@modelcontextprotocol/sdk` — already a runtime dependency (the server); reused as
  the MCP client for the `mcp` arm.

## `@earendil-works/pi-agent-core`

- `new Agent({ initialState: { systemPrompt, model, tools, thinkingLevel? } })`.
  Default `streamFn` is `streamSimple` from `@earendil-works/pi-ai/compat`, which
  resolves auth from the environment (`OPENAI_API_KEY` for the openai provider).
- `agent.prompt(text)` runs the loop to completion; `agent.abort()` cancels;
  `agent.state.messages` holds the transcript afterwards.
- `agent.subscribe((event) => …)` streams events. Relevant types:
  - `turn_start` — one per LLM turn (used for the `maxTurns` cap + `turns` metric).
  - `tool_execution_start` — one per tool call (`toolCalls` metric).
  - `message_end` — `event.message`; assistant messages carry
    `message.usage = { input, output, cost }` (token metrics).
- `AgentTool` (extends `Tool`): `{ name, label, description, parameters: TSchema,
  execute, prepareArguments?, executionMode? }`.
  - `execute: (toolCallId, params, signal?, onUpdate?) => Promise<AgentToolResult>`.
  - `AgentToolResult = { content: (Text|Image)[], details, terminate?, addedToolNames? }`.
  - Tools THROW to signal failure (the loop reports it to the model as `isError`);
    they do not encode errors in `content`.

## `@earendil-works/pi-ai`

- `Type` (TypeBox) is re-exported from the package root — used for tool `parameters`.
- Model lookup for the default agent stream: `import { getModel } from
  "@earendil-works/pi-ai/compat"` → `getModel("openai", "<model-id>")`. This is the
  same global API the default `streamSimple` consumes, so auth resolves from env.
- Token/cost data lives on the assistant message: `message.usage.{input,output,cost}`.

## `just-bash@3.1.0`

- `new Bash({ customCommands, files, env, cwd })`; `bash.exec(line, { env?, cwd? })`
  → `{ stdout, stderr, exitCode, env }`.
- `defineCommand(name, async (args, ctx) => ({ stdout, stderr, exitCode }))` — `args`
  is the already-tokenized argv from the shell parser. The execute closure runs in
  the HOST Node process, so it can `execFile(process.execPath, …)` directly.
- Built-in commands (cat, grep, ls, jq, sed, …) are all available to the agent by
  default; we register exactly one custom command, `things`.
- Initial VFS files via `files: { "/skill/SKILL.md": "…" }` (used to mount the skill
  for arm B).

## `@modelcontextprotocol/sdk` (client side)

- `import { Client } from "@modelcontextprotocol/sdk/client/index.js"` +
  `import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"`.
- After `client.connect(transport)`: `client.getInstructions()` returns the server's
  `instructions` string; `client.listTools()` → `{ tools: [{ name, description,
  inputSchema }] }`; `client.callTool({ name, arguments })` → `{ content, isError? }`.
- The server is launched as a child: `node bin/things.js mcp` with the fence env.
  `inputSchema` is JSON Schema; it is passed verbatim as an `AgentTool.parameters`
  (cast to `TSchema`) when bridging.

## Env fence (every `things` child process)

`THINGS_DB` (per-run fixture), `THINGS_SIM_WRITES=1`, `THINGS_NOW` / `THINGS_TZ`
(task clock), `THINGS_WIDTH=100`, `THINGS_CONFIG_DIR` / `THINGS_STATE_DIR` (per-run
scratch dirs). The CLI binary is `bin/things.js`, run with `process.execPath`.

`THINGS_SIM_WRITES` is the simulator write vector being built concurrently in `src/`
(`src/write/vectors/simulator.ts`); the harness only sets the flag and passes it
through. Until that lands, write tasks are expected to fail grading (writes blocked /
unsupported) — that is by design.

## Deviations / notes

- **Pseudo mode is arm-independent.** `--pseudo` replays a task's `pseudoScript`
  (bash) through a cli-style sandbox regardless of the requested arm, then synthesizes
  the final answer from the task's answer assertions. `pseudoScript` is bash, which
  does not map onto MCP tool calls, so an `mcp`-arm pseudo run still executes via the
  sandbox and records the requested arm on the RunRecord. Pseudo is a plumbing smoke
  test (seed → sandbox → grade → report), not a fidelity test of any arm.
- **db-unchanged hashing is LOGICAL, not raw bytes** (contract said "byte/hash
  compare"). A raw file/WAL hash false-positives on pure reads: merely opening a
  WAL-mode DB can trigger a benign checkpoint that rewrites `-wal`/main and bumps the
  header change counter with no data change (observed in the pseudo smoke — `things
  inbox` flipped the raw hash). `hashDbFiles` instead hashes every user table's rows
  (order-independent, BLOBs hex-encoded, BigInt tagged), which is invariant under
  checkpoints — stable across read-only workloads, sensitive to any real write.
- The skill for arm B is mounted from the repo's real `skills/things-cli/` tree
  (SKILL.md + references/), read from disk at run time.
- The pseudo final answer is **synthesized from the task's answer assertions** (the
  `answer` / `answer-includes` matchers), not from a separate canned field — a
  pseudo run trivially satisfies its own answer matchers so the read path proves the
  grade→report plumbing end to end.
