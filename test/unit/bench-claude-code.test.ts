/**
 * The claude-code arm's cross-engine mapping (bench/claude-code.ts). Claude Code's
 * `--output-format stream-json` reports usage differently from pi-ai, so lock the
 * mapping into the bench's fields here (no `claude` spawn — pure parsing):
 *
 *   tokensIn   = input + cache_creation + cache_read   (from the `result` event)
 *   tokensInCached = cache_read
 *   tokensOut  = output ;  turns = num_turns
 *   errorsSeen = tool_result{is_error} + result.permission_denials
 *   toolCalls  = assistant tool_use blocks
 *   static     = FIRST assistant turn's total input (uncached + write + read)
 *   finalText  = result.result (fallback: last assistant text)
 */
import { describe, expect, it } from "vitest";

import { newCollector } from "../../bench/arms.ts";
import { CLAUDE_ARMS, isClaudeArm, parseClaudeStream } from "../../bench/claude-code.ts";

describe("isClaudeArm / CLAUDE_ARMS", () => {
  it("recognizes the claude arms and rejects the pi arms", () => {
    expect(isClaudeArm("claude-cli")).toBe(true);
    expect(isClaudeArm("claude-skill")).toBe(true);
    expect(isClaudeArm("cli")).toBe(false);
    expect(isClaudeArm("skill")).toBe(false);
    expect(isClaudeArm("mcp")).toBe(false);
    expect([...CLAUDE_ARMS].toSorted()).toEqual(["claude-cli", "claude-skill"]);
  });
});

describe("parseClaudeStream — token/friction mapping", () => {
  const stream = [
    JSON.stringify({ type: "system", subtype: "init", skills: ["things-cli", "dataviz"] }),
    JSON.stringify({ type: "rate_limit_event" }),
    JSON.stringify({ type: "system", subtype: "thinking_tokens" }),
    // First assistant turn: static = 10 + 4802 + 5512 = 10324; one tool_use.
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 4802,
          cache_read_input_tokens: 5512,
          output_tokens: 4,
        },
        content: [
          { type: "text", text: "Let me check." },
          { type: "tool_use", name: "Bash", input: { command: "things --help" } },
        ],
      },
    }),
    // A tool_result that FAILED (friction).
    JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", is_error: true, content: "curl not found" }],
      },
    }),
    // Second assistant turn: another tool_use (static must NOT be recaptured).
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        usage: { input_tokens: 8, cache_creation_input_tokens: 100, cache_read_input_tokens: 9000 },
        content: [{ type: "tool_use", name: "Bash", input: { command: "things inbox" } }],
      },
    }),
    JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", is_error: false, content: "{}" }],
      },
    }),
    // Final result carries the authoritative usage totals + one permission denial.
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: '```json\n{"n":1}\n```',
      num_turns: 4,
      permission_denials: [{ tool: "WebFetch" }],
      usage: {
        input_tokens: 26,
        cache_creation_input_tokens: 6416,
        cache_read_input_tokens: 15597,
        output_tokens: 484,
      },
    }),
  ];

  it("maps usage, friction, tool calls, static, and final answer", () => {
    const collector = newCollector();
    const parsed = parseClaudeStream(stream, collector);

    expect(parsed.tokensIn).toBe(26 + 6416 + 15597);
    expect(parsed.tokensInCached).toBe(15597);
    expect(parsed.tokensOut).toBe(484);
    expect(parsed.turns).toBe(4);
    // static = first assistant turn's full input context, not later turns'.
    expect(parsed.staticContextTokens).toBe(10 + 4802 + 5512);
    expect(parsed.skillsRegistered).toEqual(["things-cli", "dataviz"]);
    expect(parsed.finalText).toBe('```json\n{"n":1}\n```');
    expect(parsed.authError).toBe(false);
    // friction: one failed tool_result + one permission denial.
    expect(collector.errorsSeen).toBe(2);
    // toolCalls: two tool_use blocks.
    expect(collector.toolCalls).toBe(2);
  });

  it("flags an auth error from a Not-logged-in result", () => {
    const collector = newCollector();
    const parsed = parseClaudeStream(
      [
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: true,
          result: "Not logged in · Please run /login",
          num_turns: 1,
          usage: { input_tokens: 0, output_tokens: 0 },
        }),
      ],
      collector,
    );
    expect(parsed.authError).toBe(true);
  });

  it("falls back to the last assistant text when the result carries no text", () => {
    const collector = newCollector();
    const parsed = parseClaudeStream(
      [
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "bare answer" }] },
        }),
        JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1 }),
      ],
      collector,
    );
    expect(parsed.finalText).toBe("bare answer");
  });
});
