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

- `new Agent({ initialState: { systemPrompt, model, tools, thinkingLevel? }, getApiKey? })`.
  Default `streamFn` is `streamSimple` from `@earendil-works/pi-ai/compat`, which
  resolves auth from the environment (`OPENAI_API_KEY` for the openai provider).
- `AgentOptions.getApiKey: (provider) => Promise<string | undefined> | …` — resolved
  BEFORE each turn (`agent-loop.js`: `resolvedApiKey = (getApiKey ? await
  getApiKey(model.provider) : undefined) || config.apiKey`) and passed to the stream
  as `options.apiKey`. This is the hook for expiring OAuth tokens; `provider` is
  `model.provider`. Not passing it leaves the env path unchanged.
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
- Token/cost data lives on the assistant message: `message.usage` (the `Usage`
  type). See "Token accounting" below — `usage.input` is cache-DISCOUNTED.

### Token accounting — `usage.input` is cache-discounted (verified against 0.80.10)

The `Usage` type (`dist/types.d.ts`) an assistant `message.usage` carries:

- `input` — input tokens **minus** cache reads **minus** cache writes.
- `output` — output tokens (already includes `reasoning`).
- `cacheRead` — cached (prompt-cache-hit) input tokens.
- `cacheWrite` — cache-write input tokens (0 for OpenAI Responses in practice).
- `cacheWrite1h?` — Anthropic-only split.
- `reasoning?` — reasoning tokens, a subset of `output`.
- `totalTokens` — the provider's raw total (`input_tokens + output_tokens`).
- `cost` — per-bucket cost breakdown.

The discount happens in `dist/api/openai-responses-shared.js` (shared by the
`openai-codex-responses` api the bench's `--provider openai-codex` uses), verbatim:

```js
const cachedTokens = inputDetails?.cached_tokens || 0;
const cacheWriteTokens = inputDetails?.cache_write_tokens || 0;
output.usage = {
  // OpenAI includes cached and cache-write tokens in input_tokens, so subtract both.
  input: Math.max(0, (response.usage.input_tokens || 0) - cachedTokens - cacheWriteTokens),
  output: response.usage.output_tokens || 0,
  cacheRead: cachedTokens,
  cacheWrite: cacheWriteTokens,
  reasoning: response.usage.output_tokens_details?.reasoning_tokens || 0,
  totalTokens: response.usage.total_tokens || 0,
  ...
};
```

Consequence: recording `usage.input` alone under-counts true context on cache-friendly
arms (round-0's MCP `tokensIn` 2.3k vs a 16.6k cached tool catalog). Because the split
**is** reported, the bench records the honest total directly — **no estimate needed**:
`runner.ts` accumulates `tokensIn = input + cacheRead + cacheWrite` (the true input the
model processed) and `tokensInCached = cacheRead`; `report.ts` shows `tok_in` (total)
alongside a `cached` column. The runner reads these off the `message_end` event's
`message.usage` (fields typed in `runner.ts`'s `UsageEvent`). `totalTokens` equals
`tokensIn + output` and is available if a raw cross-check is ever wanted.

### ChatGPT-subscription OAuth (`openai-codex`) — verified against 0.80.10

The bench runner's `--provider openai-codex` path (see `bench/codex-auth.ts`). Exact
APIs, all read from `node_modules/@earendil-works/pi-ai/dist`:

- **Provider:** `import { openaiCodexProvider } from
  "@earendil-works/pi-ai/providers/openai-codex"` → `Provider<"openai-codex-responses">`,
  id `"openai-codex"`, `baseUrl "https://chatgpt.com/backend-api"`, a STATIC model
  catalog (so `getModel` works with no network refresh), auth via
  `lazyOAuth({ name: "OpenAI (ChatGPT Plus/Pro)", … })`.
- **Collection:** `import { createModels } from "@earendil-works/pi-ai"` →
  `createModels({ credentials: CredentialStore })` returns a `MutableModels`;
  `models.setProvider(openaiCodexProvider())`, then `models.getModel("openai-codex",
  id)` (sync, `Model<Api>`).
- **Auth resolution + refresh:** `models.getAuth(providerId)` → `AuthResult | undefined`
  (`undefined` when unconfigured). It runs the OAuth refresh under the credential
  store's per-provider `modify` lock (so concurrent turns cannot double-refresh a
  rotated token) and returns the access token as `result.auth.apiKey`. The codex
  OAuth `toAuth(credential)` returns exactly `{ apiKey: credential.access }` — no
  headers, no baseUrl.
- **No custom `streamFn` needed.** The default `streamSimple` dispatches on
  `model.api` ("openai-codex-responses", registered via compat's
  `openai-codex-responses.lazy`). That backend
  (`api/openai-codex-responses.js`) needs ONLY `options.apiKey`: it parses the
  ChatGPT account id out of the JWT access token itself (`extractAccountId` →
  `atob(token.split(".")[1])`, claim `…chatgpt_account_id`) and resolves the request
  URL from `model.baseUrl`. So supplying the token through the agent's
  `getApiKey("openai-codex")` hook is the entire integration; `model.baseUrl` +
  the JWT cover the rest.
- **CredentialStore:** pi-ai exports the interface + an `InMemoryCredentialStore`
  only — NO file-backed store. `bench/codex-auth.ts` implements `CredentialStore`
  over a single `auth.json` (`{ [providerId]: Credential }`, 0600), the same shape
  the login CLI writes; `modify` is serialized per provider id.
- **Login CLI:** `node node_modules/@earendil-works/pi-ai/dist/cli.js login
  [provider]` (bin `pi-ai`). It writes `auth.json` in **CWD**; `npm run bench:login`
  (`bench/login.ts`) runs it with `cwd = ~/.config/things-api-bench/` and defaults
  the provider arg to `openai-codex`, so the file lands beside the store's read path
  and never in the repo. The CLI's `list` command enumerates OAuth-capable providers.
- Codex model ids present in the pinned catalog include `gpt-5.3-codex-spark`,
  `gpt-5.4-mini`, `gpt-5.4`, `gpt-5.5`, `gpt-5.6-sol`, `gpt-5.6-luna` — all reachable
  under one ChatGPT subscription.

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

## The `claude-code` arms (`bench/claude-code.ts`) — engine facts

Two arms — `claude-cli` (bare, `--help` only) and `claude-skill` (native skill) —
run the subject through the **Claude Code engine** on the operator's subscription,
never a metered API. Verified against Claude Code **v2.1.221** (Node 26), Max plan,
`authMethod: claude.ai`, subject `claude-haiku-4-5-20251001`.

### Engine choice: `claude -p` (headless CLI), not the Agent SDK

Evaluated both `claude -p` and `@anthropic-ai/claude-agent-sdk`; chose `claude -p`.
Rationale:

- **Fits the harness.** The bench already drives every arm by spawning a child
  process under a controlled env (the MCP arm spawns `node bin/things.js mcp`; the
  cli/skill arms spawn `bin/things.js` per command). `claude -p` slots into that
  exact pattern — full `env`/`cwd`/`PATH` control via `child_process`, which is
  precisely what the rebuilt real-shell fence needs.
- **Zero new dependency.** The `claude` binary is already installed; the Agent SDK
  would add a package that itself just wraps the same CLI + the same subscription
  auth, for no capability gain. (Also aligns with the repo's CLI-over-SDK doctrine.)
- **`--tools Bash` is a HARD tool fence.** The init event reports `tools:["Bash"]` —
  Read/Write/Edit/WebFetch/WebSearch and every other built-in are *not loaded at
  all*, a stronger guarantee than the SDK's runtime `canUseTool` callback (which
  gates tools that still exist). Network tools vanish by the same flag.
- **`--output-format stream-json --verbose`** emits newline-delimited events —
  `system/init` (lists `tools`, `skills`, `model`), `assistant` (content blocks incl.
  `tool_use`), `user` (tool_result blocks with `is_error`), and a final `result`
  carrying `usage`, `num_turns`, `permission_denials`, `total_cost_usd` — clean
  programmatic usage + friction + tool-call accounting without scraping prose.

### Auth — subscription, never metered

- `CLAUDE_CODE_OAUTH_TOKEN` (a **subscription** OAuth token) is honored by the CLI
  and is the auth path used. `resolveSubscriptionToken()` prefers that env var (e.g.
  from `claude setup-token`); otherwise it reads the login **keychain** item
  `Claude Code-credentials` (`security find-generic-password -w`, parse
  `.claudeAiOauth.accessToken`) in the PARENT process. `ANTHROPIC_API_KEY` is never
  set — that would meter spend, which the maintainer's constraint forbids.
- Passing the token via env **decouples auth from both the fenced PATH and HOME**:
  the child needs no `/usr/bin/security` on PATH and no real config dir. (Confirmed:
  with a fenced PATH lacking `/usr/bin`, keychain reads fail — "Not logged in" — so
  a bare fenced PATH *requires* the token env. Also confirmed: redirecting
  `CLAUDE_CONFIG_DIR` alone breaks keychain auth; the token env survives it.)
- **Subscription caveat:** Haiku draws on the operator's Claude plan **usage limits**
  (rate/weekly caps), not a metered balance. Cheap but not free — size batches
  accordingly (see the README subscription block).

### The rebuilt fence (real shell)

Claude Code's Bash is a REAL shell, so the just-bash VFS fence does not apply. Per
run, `buildFence()` creates a throwaway `HOME`, a `workdir` (cwd), a fenced `bin/`,
and a scratch `TMPDIR`, and the child is spawned with an env built from scratch
(no parent `CLAUDE_CODE_*`, no `ANTHROPIC_API_KEY`):

- **`PATH` = the fenced `bin/` only.** It holds a `things` **shim** plus a curated
  coreutils allowlist (symlinks resolved from the host). The shim HARDCODES the
  fixture fence env (`THINGS_DB`, `THINGS_SIM_WRITES=1`, `THINGS_API_*`, clock) and
  `exec`s `bin/things.js` by an **absolute node path** — node is NOT on PATH. Every
  network/escape binary (`curl` `wget` `nc` `ssh` `scp` `sqlite3` `osascript` `open`
  `node` `python*` `ruby` `perl` `security` `git`) is unreachable by omission, so the
  agent cannot shell out to the network or open the real Things DB behind `things`.
- **Fail-closed preflight** (`preflight()`), aborts the run on any ambiguity: token
  present; fixture DB exists; no forbidden binary present in the fenced bin; and the
  shim's `things … --dry-run --json` compiles to a `simulated:` invocation (the sim
  vector + `benchFixture` marker are wired → the real DB is unreachable via `things`).
  This is the `claude-code` analog of the runner's `assertFenceFunctional`.
- **Hermeticity:** `--no-session-persistence` + throwaway HOME + `--setting-sources
  project` keep the operator's real `~/.claude` settings/plugins out. Claude Code's
  **bundled** skills (dataviz, code-review, run, …) still appear in the init `skills`
  list — they ship with the binary and cannot be removed by HOME/config redirect —
  but they are IDENTICAL across both arms (pinned to the Claude Code version, which
  is recorded in `claudeMeta`), so they cancel in the paired `claude-cli` vs
  `claude-skill` comparison. The ONLY skill-set delta between arms is `things-cli`.

### Ingestion mode (the harness experiment) + metadata

- `claude-skill` installs the repo skill at `<workdir>/.claude/skills/things-cli/`
  for Claude Code's **native discovery** (progressive disclosure: name+description
  advertised; body read on demand). This differs from the pi `skill` arm's **static
  injection** (full skill bytes always in `staticText` + mounted in the VFS, with an
  explicit system-prompt advert). That difference IS the experiment. Confirmed: with
  Bash-only, Haiku discovered the installed skill and read `references/model.md`
  unprompted, answering from it.
- Each transcript records `claudeMeta = { engine, claudeVersion, model,
  ingestionMode, skillsRegistered }` so the ingestion mode is captured per run.

### Token accounting mapping (Claude Code → bench fields)

The `result.usage` shape differs from pi-ai; the mapping is:

- `tokensIn = input_tokens + cache_creation_input_tokens + cache_read_input_tokens`
  (the honest total context; `cache_creation` is the "cache write" analog).
- `tokensInCached = cache_read_input_tokens`.
- `tokensOut = output_tokens`; `turns = num_turns`.
- `errorsSeen` = count of `tool_result` blocks with `is_error:true` + `result`'s
  `permission_denials.length`; `toolCalls` = count of `tool_use` blocks.
- `staticContextTokens` is **measured, not text-estimated** for these arms: the first
  assistant turn's `cache_creation_input_tokens` ≈ the initial primed context (Claude
  Code's internal harness system prompt + tool defs + skill descriptions), cached
  once. This is NOT directly comparable to the pi arms' text-estimated static
  (different tokenizer; includes Claude Code's internal prompt) — compare across
  claude arms, and use `tokensIn` as the honest cross-engine headline.
  `dynamicContextTokens` uses the same `estimateTokens(transcript)` method as pi.
