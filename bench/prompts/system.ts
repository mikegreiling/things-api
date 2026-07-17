/**
 * Fixed, versioned system prompts for the three arms. Their hashes are recorded per
 * run (RunRecord.promptHash) so a copy change is never mistaken for a model change.
 *
 * Bump PROMPT_VERSION on any edit. Keep the CLI base prompt free of Things knowledge:
 * the whole point of the bench is that the arm's surface (help / skill / MCP) must
 * teach the model, not the prompt.
 */

export const PROMPT_VERSION = "v0";

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

/**
 * Skill arm = the CLI base prompt plus this advertisement. The skill tree is mounted
 * read-only in the sandbox VFS under /skill (SKILL.md + references/).
 */
export const SKILL_ADVERT =
  "A reference skill for the `things` CLI is mounted in the filesystem. Before working " +
  "by trial and error, read /skill/SKILL.md — it documents the data model, the " +
  "available commands and their flags, output shapes, and safety/recovery notes. It " +
  "links to files under /skill/references/ (reads, writes, gui, data-model, recurrence, " +
  "safety-and-recovery); read the ones relevant to your task. The skill describes the " +
  "same CLI you have; prefer it over rediscovering the interface from --help.";

/** The composed system prompt for the CLI-family arms. */
export function cliSystemPrompt(withSkill: boolean): string {
  return withSkill ? `${CLI_SYSTEM_PROMPT}\n\n${SKILL_ADVERT}` : CLI_SYSTEM_PROMPT;
}

/** The MCP arm's system prompt: the server's own instructions, then the answer protocol. */
export function mcpSystemPrompt(instructions: string): string {
  const base = instructions.trim();
  return base ? `${base}\n\n${FINAL_ANSWER_PROTOCOL}` : FINAL_ANSWER_PROTOCOL;
}
