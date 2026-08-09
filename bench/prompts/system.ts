/**
 * Fixed, versioned system prompts for the three arms. Their hashes are recorded per
 * run (RunRecord.promptHash) so a copy change is never mistaken for a model change.
 *
 * Bump PROMPT_VERSION on any edit. Keep the CLI base prompt free of Things knowledge:
 * the whole point of the bench is that the arm's surface (help / skill / MCP) must
 * teach the model, not the prompt.
 */

export const PROMPT_VERSION = "v2";

/** Shared final-answer contract so answer grading is identical across arms. */
export const FINAL_ANSWER_PROTOCOL =
  "Final-answer protocol: when the task asks a question, finish your reply with exactly " +
  "one fenced code block tagged `json` containing the answer as a JSON object, as the " +
  "last thing in your message with nothing after it. When the task only asks you to " +
  "change something, no json block is required.";

/**
 * Bare-CLI arm. A single bash tool; the `things` CLI is installed but undocumented
 * here — the model discovers it via `--help`.
 */
export const CLI_SYSTEM_PROMPT =
  "You are an assistant helping a user manage their tasks in the Things app (Things 3, " +
  "by Cultured Code).\n\n" +
  "You have one tool: a bash shell. The `things` command-line program is installed and " +
  "on PATH; use it to inspect and change the user's tasks. You have no prior knowledge " +
  "of how `things` works — discover its commands, flags, and output by running " +
  "`things --help` and `things <command> --help`.\n\n" +
  "Standard POSIX utilities (cat, grep, jq, sed, ls, ...) are available in the shell " +
  "for parsing output.\n\n" +
  FINAL_ANSWER_PROTOCOL;

/** The bare CLI-family system prompt (cli arm, and the append-prompt for both claude arms). */
export function cliSystemPrompt(): string {
  return CLI_SYSTEM_PROMPT;
}

/**
 * Skill arm = the CLI base prompt plus the NATIVE pi-agent-core skills advertisement.
 *
 * `advert` is `formatSkillsForSystemPrompt(skills)` output verbatim (the library's own
 * `<available_skills>` block: name + description + `<location>` per skill, with the
 * relative-path-resolution preamble) — the exact advertisement real pi injects. There is
 * NO bench-authored advert and NO static injection of the skill body: only the skill's
 * name+description+location are in-context; the SKILL.md body and its `references/*.md` are
 * read on demand from the VFS mount at the advertised `<location>` (progressive disclosure).
 * This makes the arm 1-to-1 with real pi's skills flow — the bespoke `SKILL_ADVERT` +
 * static body accounting it replaced is retired (see ROADMAP.md native-ingestion round).
 */
export function skillSystemPrompt(advert: string): string {
  return `${CLI_SYSTEM_PROMPT}\n\n${advert}`;
}

/** The MCP arm's system prompt: the server's own instructions, then the answer protocol. */
export function mcpSystemPrompt(instructions: string): string {
  const base = instructions.trim();
  return base ? `${base}\n\n${FINAL_ANSWER_PROTOCOL}` : FINAL_ANSWER_PROTOCOL;
}
