/**
 * Arm builders. Each returns the system prompt + pi-agent-core tools + the static
 * context text (for token accounting) for one surface under test:
 *   - cli:   a single bash tool over the sandbox; no Things knowledge in the prompt.
 *   - skill: same bash tool + the NATIVE pi skills advertisement (name+description+location
 *            via formatSkillsForSystemPrompt); the skill body is read on demand, NOT static.
 *   - mcp:   NO bash — the server's tools bridged verbatim; server instructions form
 *            the system prompt; init cost = instructions + serialized tool catalog.
 *
 * A shared Collector accumulates friction (error responses seen) and tool-call counts
 * across whatever tools the agent invokes.
 */
import type { AgentTool, Skill } from "@earendil-works/pi-agent-core";
import { formatSkillsForSystemPrompt } from "@earendil-works/pi-agent-core";
import type { TSchema } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";

import { cliSystemPrompt, mcpSystemPrompt, skillSystemPrompt } from "./prompts/system.ts";
import type { Sandbox, ShellResult } from "./sandbox.ts";

/** Mutable per-run tallies written by the tool wrappers. */
export interface Collector {
  errorsSeen: number;
  toolCalls: number;
}

export function newCollector(): Collector {
  return { errorsSeen: 0, toolCalls: 0 };
}

/** What an arm hands the runner to construct the Agent. */
export interface ArmContext {
  systemPrompt: string;
  tools: AgentTool[];
  /**
   * Fixed context text for static-token accounting: system prompt + tool defs. For the
   * skill arm the system prompt already carries the native skills advertisement; the skill
   * BODY is NOT included here (it is read on demand → dynamic, not static).
   */
  staticText: string;
  /** Release any spawned resources (the MCP client/child). */
  dispose?: () => Promise<void>;
}

/** Render a shell result for the model: stdout, then stderr, then the exit code. */
function formatShell(r: ShellResult): string {
  const parts: string[] = [];
  if (r.stdout.trim() !== "") parts.push(r.stdout.replace(/\n+$/, ""));
  if (r.stderr.trim() !== "") parts.push(`[stderr]\n${r.stderr.replace(/\n+$/, "")}`);
  parts.push(`[exit ${r.exitCode}]`);
  return parts.join("\n");
}

/** The single bash tool used by the cli and skill arms. */
function bashTool(sandbox: Sandbox, collector: Collector): AgentTool {
  return {
    name: "bash",
    label: "Bash",
    description:
      "Run a command line in a bash shell. The `things` CLI and standard POSIX " +
      "utilities are available. Returns combined stdout/stderr and the exit code.",
    parameters: Type.Object({
      command: Type.String({ description: "The bash command line to execute." }),
    }),
    execute: async (_toolCallId, params: unknown) => {
      collector.toolCalls++;
      const { command } = params as { command: string };
      const result = await sandbox.exec(command);
      if (result.exitCode !== 0) collector.errorsSeen++;
      return {
        content: [{ type: "text" as const, text: formatShell(result) }],
        details: { exitCode: result.exitCode },
      };
    },
  };
}

/** Bare-CLI arm. */
export function buildCliArm(sandbox: Sandbox, collector: Collector): ArmContext {
  const systemPrompt = cliSystemPrompt();
  const tools = [bashTool(sandbox, collector)];
  return { systemPrompt, tools, staticText: staticTextFor(systemPrompt, tools) };
}

/**
 * CLI + skill arm — NATIVE pi-agent-core ingestion (no static body injection).
 *
 * `skills` are loaded via the library's `loadSkills` over the same file map that seeds the
 * VFS (see runner `loadSkill` + `bench/skill-env.ts`); their `formatSkillsForSystemPrompt`
 * advertisement (name + description + `<location>`) enters the system prompt exactly as in
 * real pi. The skill BODY and `references/*.md` are NOT static — the model reads them on
 * demand from the VFS mount. Static tokens therefore cover only the prompt (including the
 * advert) + the bash tool def; the skill bytes moved into the DYNAMIC accounting, entering
 * context only when the model actually reads them (ingestion mode `pi-native`, replacing the
 * retired `static-injection`).
 */
export function buildSkillArm(sandbox: Sandbox, collector: Collector, skills: Skill[]): ArmContext {
  const advert = formatSkillsForSystemPrompt(skills);
  const systemPrompt = skillSystemPrompt(advert);
  const tools = [bashTool(sandbox, collector)];
  return { systemPrompt, tools, staticText: staticTextFor(systemPrompt, tools) };
}

/** Serialized static surface: system prompt + the tool definitions the model sees. */
function staticTextFor(systemPrompt: string, tools: AgentTool[]): string {
  const defs = tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
  return `${systemPrompt}\n${JSON.stringify(defs)}`;
}

/** Minimal shape of an MCP tool descriptor from listTools(). */
interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/** Minimal shape of an MCP callTool result. */
interface McpCallResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

/** Minimal client surface we depend on (avoids importing the SDK types at top level). */
interface McpClientLike {
  callTool: (params: {
    name: string;
    arguments: Record<string, unknown>;
  }) => Promise<McpCallResult>;
  close: () => Promise<void>;
}

function mcpResultToText(res: McpCallResult): string {
  const text = (res.content ?? [])
    .map((b) => (b.type === "text" && b.text !== undefined ? b.text : JSON.stringify(b)))
    .join("\n");
  return text === "" ? "[no content]" : text;
}

/** Bridge one MCP tool into a pi AgentTool, verbatim (name/description/inputSchema). */
function bridgeMcpTool(
  client: McpClientLike,
  tool: McpToolDescriptor,
  collector: Collector,
): AgentTool {
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description ?? "",
    // MCP inputSchema is JSON Schema; pass it through as the tool parameters. A
    // permissive passthrough avoids double-validating the server's own schema.
    parameters: (tool.inputSchema ?? { type: "object" }) as TSchema,
    prepareArguments: (args: unknown) => args as never,
    execute: async (_toolCallId, params: unknown) => {
      collector.toolCalls++;
      const res = await client.callTool({
        name: tool.name,
        arguments: (params ?? {}) as Record<string, unknown>,
      });
      if (res.isError === true) collector.errorsSeen++;
      return {
        content: [{ type: "text" as const, text: mcpResultToText(res) }],
        details: { isError: res.isError === true },
      };
    },
  };
}

export interface McpArmOptions {
  fenceEnv: Record<string, string>;
  binPath: string;
}

/**
 * MCP arm. Spawns `node bin/things.js mcp` under the fence env, connects the SDK
 * Client over stdio, bridges every server tool, and uses the server's instructions as
 * the system prompt base. Static cost = instructions + serialized tool catalog.
 */
export async function buildMcpArm(
  options: McpArmOptions,
  collector: Collector,
): Promise<ArmContext> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [options.binPath, "mcp"],
    env: options.fenceEnv,
  });
  const client = new Client({ name: "agentbench", version: "0" });
  await client.connect(transport);

  const instructions = client.getInstructions() ?? "";
  const listed = await client.listTools();
  const mcpTools = listed.tools as McpToolDescriptor[];
  const tools = mcpTools.map((t) =>
    bridgeMcpTool(client as unknown as McpClientLike, t, collector),
  );

  const systemPrompt = mcpSystemPrompt(instructions);
  // Init token cost per the contract: instructions + the serialized tool catalog.
  const staticText = `${instructions}\n${JSON.stringify(mcpTools)}`;

  return {
    systemPrompt,
    tools,
    staticText,
    dispose: async () => {
      await client.close();
    },
  };
}
