/**
 * The `claude-code` arm family: run the bench subject through the Claude Code engine
 * (`claude -p`, headless) under a REBUILT fence. Unlike the pi-agent-core arms, whose
 * "shell" is just-bash (a VFS with no host FS/network and the `things` command as the
 * only escape hatch), Claude Code's Bash tool is a REAL shell — so the fence the
 * 2026-07-17 host-escape incident hardened must be reconstructed here from scratch:
 *
 *   - A throwaway HOME + workdir per run (Claude Code writes caches/session there),
 *     cleaned up afterwards; hermetic vs the operator's real ~/.claude settings.
 *   - A fenced PATH containing ONLY a curated coreutils allowlist + a `things` SHIM.
 *     The shim HARDCODES the fixture fence env (THINGS_DB / THINGS_SIM_WRITES=1 /
 *     THINGS_API_*), so the agent cannot unset it (the incident-review requirement),
 *     and it invokes bin/things.js by an ABSOLUTE node path — node itself is NOT on
 *     PATH. Network/escape binaries (curl, wget, nc, ssh, sqlite3, osascript, open,
 *     node, python, …) are excluded by omission → no shell-out to the network or to
 *     the real Things DB.
 *   - Tools locked to Bash only (`--tools Bash`): Read/Write/Edit/WebFetch/WebSearch
 *     and every other built-in are not loaded at all — a stronger guarantee than a
 *     runtime permission callback.
 *   - Subscription auth via CLAUDE_CODE_OAUTH_TOKEN (the operator's Claude plan),
 *     extracted from the login keychain by the PARENT process. This decouples auth
 *     from both the fenced PATH (no /usr/bin/security needed) and HOME, and — the
 *     hard constraint — never touches ANTHROPIC_API_KEY, so no metered API spend.
 *   - Fail-closed preflight: token present, the shim's `--dry-run` compiles to
 *     `simulated:` (the sim vector + benchFixture marker are wired), the fixture DB
 *     exists, and no escape binary is reachable on the fenced PATH. Any ambiguity
 *     aborts the run before the subject is spawned.
 *
 * Engine choice (`claude -p` over the Agent SDK) rationale lives in bench/NOTES.md.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Collector } from "./arms.ts";
import type { Arm, Clock } from "./types.ts";

/** The arm labels served by the Claude Code engine. */
export const CLAUDE_ARMS: ReadonlySet<Arm> = new Set<Arm>(["claude-cli", "claude-skill"]);

export function isClaudeArm(arm: Arm): boolean {
  return CLAUDE_ARMS.has(arm);
}

/** The provider string recorded on RunRecord for the Claude Code arms. */
export const CLAUDE_PROVIDER = "claude-code";

/**
 * Coreutils the subject legitimately needs for parsing `things` output. Curated
 * allowlist — anything not here is unreachable on the fenced PATH. Deliberately
 * EXCLUDES every network/escape binary (curl, wget, nc, ssh, scp, sqlite3,
 * osascript, open, node, python*, ruby, perl, security, git): the agent must not be
 * able to reach the network or the real Things DB behind the `things` shim.
 */
const COREUTILS_ALLOWLIST = [
  "sh",
  "bash",
  "cat",
  "ls",
  "grep",
  "egrep",
  "fgrep",
  "sed",
  "awk",
  "jq",
  "head",
  "tail",
  "sort",
  "uniq",
  "cut",
  "tr",
  "echo",
  "env",
  "printf",
  "date",
  "dirname",
  "basename",
  "wc",
  "find",
  "xargs",
  "expr",
  "test",
  "[",
  "tee",
  "comm",
  "paste",
  "true",
  "false",
] as const;

/** Escape/network binaries that MUST NOT be reachable on the fenced PATH. */
const FORBIDDEN_ON_PATH = [
  "curl",
  "wget",
  "nc",
  "ncat",
  "ssh",
  "scp",
  "sftp",
  "telnet",
  "sqlite3",
  "osascript",
  "open",
  "node",
  "python",
  "python3",
  "ruby",
  "perl",
  "security",
  "git",
] as const;

const SEARCH_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
];

function findExecutable(name: string): string | undefined {
  for (const dir of SEARCH_DIRS) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return undefined;
}

/** Resolve the `claude` binary (CLAUDE_BIN override, then common install paths). */
export function resolveClaudeBin(): string {
  const override = process.env["CLAUDE_BIN"];
  if (override !== undefined && existsSync(override)) return override;
  const candidates = [
    join(process.env["HOME"] ?? "", ".local/bin/claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(
    "claude binary not found — install Claude Code or set CLAUDE_BIN to its path. " +
      "The claude-code arms require the Claude Code CLI (subscription auth).",
  );
}

/**
 * Resolve the subscription OAuth token — NEVER an API key (that would meter spend).
 * Prefers an explicit CLAUDE_CODE_OAUTH_TOKEN (e.g. `claude setup-token`); otherwise
 * reads the login keychain item the CLI itself uses. Throws (fail closed) if neither
 * yields a token — a run must never fall back to metered/unauthenticated paths.
 */
export function resolveSubscriptionToken(): string {
  const fromEnv = process.env["CLAUDE_CODE_OAUTH_TOKEN"];
  if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv.trim();

  const res = spawnSync(
    "/usr/bin/security",
    ["find-generic-password", "-w", "-s", "Claude Code-credentials"],
    { encoding: "utf8" },
  );
  if (res.status === 0 && typeof res.stdout === "string" && res.stdout.trim() !== "") {
    try {
      const cred = JSON.parse(res.stdout) as {
        claudeAiOauth?: { accessToken?: string };
        accessToken?: string;
      };
      const token = cred.claudeAiOauth?.accessToken ?? cred.accessToken;
      if (typeof token === "string" && token.trim() !== "") return token.trim();
    } catch {
      // fall through to the throw below
    }
  }
  throw new Error(
    "no Claude subscription token — set CLAUDE_CODE_OAUTH_TOKEN (run `claude setup-token`) " +
      "or `claude auth login` so the login keychain item exists. Refusing to run the " +
      "claude-code arm without subscription auth (never falls back to a metered API key).",
  );
}

let claudeVersionCache: string | undefined;
function claudeVersion(claudeBin: string): string {
  if (claudeVersionCache !== undefined) return claudeVersionCache;
  const res = spawnSync(claudeBin, ["--version"], { encoding: "utf8" });
  claudeVersionCache = (res.stdout ?? "").trim().split("\n")[0] ?? "unknown";
  return claudeVersionCache;
}

/** POSIX single-quote a string for safe interpolation into the shim script. */
function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

interface FenceDirs {
  root: string;
  home: string;
  workdir: string;
  binDir: string;
  tmp: string;
  cleanup: () => void;
}

/**
 * Build the per-run fenced dirs: throwaway HOME, workdir (cwd for the subject; the
 * skill is installed here for the skill arm), a fenced bin (things shim + curated
 * coreutils), and a scratch TMPDIR. The shim bakes in the fixture fence env.
 */
function buildFence(params: {
  arm: Arm;
  fixturePath: string;
  clock: Clock;
  configDir: string;
  stateDir: string;
  binPath: string; // repo bin/things.js
  nodeExec: string; // absolute node to run things.js
  skillDir: string; // repo skills/things-cli
}): FenceDirs {
  const root = mkdtempSync(join(tmpdir(), "bench-claude-"));
  const home = join(root, "home");
  const workdir = join(root, "work");
  const binDir = join(root, "bin");
  const tmp = join(root, "tmp");
  for (const d of [home, workdir, binDir, tmp]) mkdirSync(d, { recursive: true });

  // Native skill install: Claude Code discovers project skills under <cwd>/.claude/skills/.
  if (params.arm === "claude-skill") {
    const skillsDir = join(workdir, ".claude", "skills");
    mkdirSync(skillsDir, { recursive: true });
    cpSync(params.skillDir, join(skillsDir, "things-cli"), { recursive: true });
  }

  // The `things` shim: hardcode the fixture fence env (agent cannot unset it) and
  // exec bin/things.js by ABSOLUTE node path (node stays off the fenced PATH).
  const shim =
    "#!/bin/sh\n" +
    `export THINGS_DB=${shq(params.fixturePath)}\n` +
    "export THINGS_SIM_WRITES=1\n" +
    `export THINGS_NOW=${shq(params.clock.now)}\n` +
    `export THINGS_TZ=${shq(params.clock.tz)}\n` +
    "export THINGS_WIDTH=100\n" +
    `export THINGS_API_CONFIG_DIR=${shq(params.configDir)}\n` +
    `export THINGS_API_STATE_DIR=${shq(params.stateDir)}\n` +
    "export THINGS_API_NO_SKILL_CHECK=1\n" +
    "export NO_COLOR=1\n" +
    `exec ${shq(params.nodeExec)} ${shq(params.binPath)} "$@"\n`;
  const shimPath = join(binDir, "things");
  writeFileSync(shimPath, shim);
  chmodSync(shimPath, 0o755);

  for (const name of COREUTILS_ALLOWLIST) {
    const src = findExecutable(name);
    if (src !== undefined) {
      try {
        symlinkSync(src, join(binDir, name));
      } catch {
        // duplicate/name clash — skip
      }
    }
  }

  return {
    root,
    home,
    workdir,
    binDir,
    tmp,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Fail-closed fence preflight — abort on ANY ambiguity (2026-07-17 incident doctrine).
 * Proves: no escape binary is reachable on the fenced PATH; the fixture DB exists; and
 * the shim's `--dry-run` compiles to a `simulated:` invocation (sim vector + fixture
 * marker wired), i.e. the real Things DB is unreachable through `things`.
 */
function preflight(fence: FenceDirs, fixturePath: string): void {
  if (!existsSync(fixturePath)) {
    throw new Error(`claude fence preflight FAILED: fixture DB missing at ${fixturePath}`);
  }
  for (const bad of FORBIDDEN_ON_PATH) {
    if (existsSync(join(fence.binDir, bad))) {
      throw new Error(
        `claude fence preflight FAILED: escape binary ${bad} is reachable on the fenced PATH`,
      );
    }
  }
  const shimPath = join(fence.binDir, "things");
  if (!existsSync(shimPath)) {
    throw new Error("claude fence preflight FAILED: things shim missing from fenced bin");
  }
  const res = spawnSync(shimPath, ["todo", "add", "__fence_preflight__", "--dry-run", "--json"], {
    env: { PATH: fence.binDir },
    encoding: "utf8",
    timeout: 30_000,
  });
  let invocation = "";
  try {
    const env = JSON.parse(res.stdout) as { data?: { invocation?: string } };
    invocation = env.data?.invocation ?? "";
  } catch {
    // fall through to the error below
  }
  if (res.status !== 0 || !invocation.startsWith("simulated:")) {
    throw new Error(
      `claude fence preflight FAILED — refusing to run. shim dry-run exit=${res.status}, ` +
        `invocation=${JSON.stringify(invocation)} (expected "simulated:todo.add"). ` +
        `stderr: ${(res.stderr ?? "").slice(0, 400)}`,
    );
  }
}

// --- stream-json parsing ---------------------------------------------------

interface TurnUsage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
}

interface StreamEvent {
  type?: string;
  subtype?: string;
  message?: { role?: string; content?: unknown; usage?: TurnUsage };
  skills?: string[];
  is_error?: boolean;
  result?: string;
  num_turns?: number;
  usage?: {
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
  };
  permission_denials?: unknown[];
}

interface ContentBlock {
  type?: string;
  text?: string;
  is_error?: boolean;
}

export interface ClaudeOutcome {
  turns: number;
  tokensIn: number;
  tokensInCached: number;
  tokensOut: number;
  finalText: string | null;
  dynamicText: string;
  messages: unknown[];
  /** Measured initial cached context (first assistant turn's cache_creation). */
  staticContextTokens: number;
  meta: {
    engine: "claude-code";
    claudeVersion: string;
    model: string;
    ingestionMode: string;
    skillsRegistered: string[];
  };
}

/**
 * Parse the `claude -p --output-format stream-json` transcript into bench metrics.
 * Exported for unit testing the cross-engine token/friction mapping (see NOTES.md).
 * Mutates `collector` (toolCalls / errorsSeen).
 */
export function parseClaudeStream(
  lines: string[],
  collector: Collector,
): {
  events: StreamEvent[];
  turns: number;
  tokensIn: number;
  tokensInCached: number;
  tokensOut: number;
  finalText: string | null;
  staticContextTokens: number;
  skillsRegistered: string[];
  authError: boolean;
} {
  const events: StreamEvent[] = [];
  let turns = 0;
  let tokensIn = 0;
  let tokensInCached = 0;
  let tokensOut = 0;
  let finalText: string | null = null;
  let lastAssistantText: string | null = null;
  let staticContextTokens = 0;
  let staticSeen = false;
  let skillsRegistered: string[] = [];
  let authError = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let ev: StreamEvent;
    try {
      ev = JSON.parse(trimmed) as StreamEvent;
    } catch {
      continue;
    }
    events.push(ev);

    if (ev.type === "system" && ev.subtype === "init") {
      skillsRegistered = Array.isArray(ev.skills) ? ev.skills : [];
      continue;
    }

    if (ev.type === "assistant" && ev.message) {
      const content = ev.message.content;
      if (Array.isArray(content)) {
        for (const block of content as ContentBlock[]) {
          if (block.type === "tool_use") collector.toolCalls++;
          if (block.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
            lastAssistantText = block.text;
          }
        }
      }
      // The FIRST assistant turn's total input (uncached + cache-write + cache-read)
      // ≈ the initial static context Claude Code primed: its internal harness system
      // prompt + tool defs + skill descriptions + the appended framing (the task
      // prompt is a small part of it). Measured, not text-estimated — see NOTES.md.
      const au = ev.message.usage;
      if (!staticSeen && au) {
        staticContextTokens =
          (au.input_tokens ?? 0) +
          (au.cache_creation_input_tokens ?? 0) +
          (au.cache_read_input_tokens ?? 0);
        staticSeen = true;
      }
      continue;
    }

    if (ev.type === "user" && ev.message) {
      const content = ev.message.content;
      if (Array.isArray(content)) {
        for (const block of content as ContentBlock[]) {
          if (block.type === "tool_result" && block.is_error === true) collector.errorsSeen++;
        }
      }
      continue;
    }

    if (ev.type === "result") {
      turns = ev.num_turns ?? turns;
      if (ev.usage) {
        const u = ev.usage;
        tokensIn +=
          (u.input_tokens ?? 0) +
          (u.cache_creation_input_tokens ?? 0) +
          (u.cache_read_input_tokens ?? 0);
        tokensInCached += u.cache_read_input_tokens ?? 0;
        tokensOut += u.output_tokens ?? 0;
      }
      collector.errorsSeen += Array.isArray(ev.permission_denials)
        ? ev.permission_denials.length
        : 0;
      if (typeof ev.result === "string") finalText = ev.result;
      if (
        ev.is_error === true &&
        typeof ev.result === "string" &&
        /not logged in|please run \/login|invalid.*token|authentication/i.test(ev.result)
      ) {
        authError = true;
      }
    }
  }

  return {
    events,
    turns,
    tokensIn,
    tokensInCached,
    tokensOut,
    finalText: finalText ?? lastAssistantText,
    staticContextTokens,
    skillsRegistered,
    authError,
  };
}

// --- the arm entry point ---------------------------------------------------

export interface RunClaudeParams {
  arm: Arm;
  prompt: string;
  /**
   * Bench framing APPENDED to Claude Code's default system prompt (via
   * `--append-system-prompt`): the same bare-CLI orientation the pi arms get (a bash
   * shell is available, `things` is on PATH, discover it via `--help`, and the
   * final-answer JSON protocol). Deliberately carries NO skill advert — the skill arm
   * relies on Claude Code's NATIVE discovery, so the only difference between the two
   * claude arms is the installed skill, not the prompt.
   */
  appendSystemPrompt: string;
  model: string;
  fixturePath: string;
  clock: Clock;
  configDir: string;
  stateDir: string;
  binPath: string; // repo bin/things.js
  nodeExec: string; // absolute node
  skillDir: string; // repo skills/things-cli
  collector: Collector;
  timeoutMs: number;
}

/**
 * Run one task attempt through Claude Code, fenced. Builds + preflights the fence,
 * spawns `claude -p` (subscription auth, Bash-only, fenced PATH/cwd/HOME), parses the
 * stream-json transcript into the bench's metrics, and cleans up the fenced dirs.
 */
export async function runClaudeCode(params: RunClaudeParams): Promise<ClaudeOutcome> {
  const claudeBin = resolveClaudeBin();
  const token = resolveSubscriptionToken();
  const fence = buildFence({
    arm: params.arm,
    fixturePath: params.fixturePath,
    clock: params.clock,
    configDir: params.configDir,
    stateDir: params.stateDir,
    binPath: params.binPath,
    nodeExec: params.nodeExec,
    skillDir: params.skillDir,
  });

  try {
    preflight(fence, params.fixturePath);

    const env: Record<string, string> = {
      HOME: fence.home,
      PATH: fence.binDir,
      TMPDIR: fence.tmp,
      CLAUDE_CODE_OAUTH_TOKEN: token,
      NO_COLOR: "1",
      TERM: "dumb",
      LANG: process.env["LANG"] ?? "en_US.UTF-8",
      // Defense-in-depth: the shim already hardcodes these, but pass them so any
      // `things` invoked another way still lands on the fixture fence.
      THINGS_DB: params.fixturePath,
      THINGS_SIM_WRITES: "1",
      THINGS_NOW: params.clock.now,
      THINGS_TZ: params.clock.tz,
      THINGS_WIDTH: "100",
      THINGS_API_CONFIG_DIR: params.configDir,
      THINGS_API_STATE_DIR: params.stateDir,
      THINGS_API_NO_SKILL_CHECK: "1",
    };

    const args = [
      "-p",
      params.prompt,
      "--model",
      params.model,
      "--output-format",
      "stream-json",
      "--verbose",
      "--tools",
      "Bash",
      "--permission-mode",
      "bypassPermissions",
      "--setting-sources",
      "project",
      "--no-session-persistence",
      "--append-system-prompt",
      params.appendSystemPrompt,
    ];

    const lines = await new Promise<string[]>((resolve) => {
      const child = spawn(claudeBin, args, { cwd: fence.workdir, env });
      let buf = "";
      const out: string[] = [];
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        if (buf.trim() !== "") out.push(buf);
        resolve(out);
      };
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2_000);
      }, params.timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          out.push(buf.slice(0, idx));
          buf = buf.slice(idx + 1);
        }
      });
      child.stderr.on("data", () => {
        /* Claude Code stderr is noise (spinner/telemetry); the transcript is on stdout. */
      });
      child.on("error", () => {
        clearTimeout(timer);
        done();
      });
      child.on("close", () => {
        clearTimeout(timer);
        done();
      });
    });

    const parsed = parseClaudeStream(lines, params.collector);
    if (parsed.authError) {
      throw new Error(
        "claude-code run hit an auth error (Not logged in / invalid token). Re-auth with " +
          "`claude setup-token` or `claude auth login`, then re-run. Aborting the sweep " +
          "rather than recording auth-failed runs as task failures.",
      );
    }

    const dynamicText = JSON.stringify(parsed.events);
    return {
      turns: parsed.turns,
      tokensIn: parsed.tokensIn,
      tokensInCached: parsed.tokensInCached,
      tokensOut: parsed.tokensOut,
      finalText: parsed.finalText,
      dynamicText,
      messages: parsed.events,
      staticContextTokens: parsed.staticContextTokens,
      meta: {
        engine: "claude-code",
        claudeVersion: claudeVersion(claudeBin),
        model: params.model,
        ingestionMode:
          params.arm === "claude-skill"
            ? "native (Claude Code progressive-disclosure discovery from .claude/skills/things-cli)"
            : "none (bare CLI, --help only)",
        skillsRegistered: parsed.skillsRegistered,
      },
    };
  } finally {
    fence.cleanup();
  }
}
