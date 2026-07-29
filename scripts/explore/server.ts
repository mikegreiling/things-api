/**
 * `npm run explore` — a localhost-only debug view over the live CLI.
 *
 * Serves a single-page explorer (scripts/explore/index.html) and a POST /run
 * endpoint that executes `bin/things.js` with a tokenized argv (never a
 * shell). Reads on the allowlist run verbatim; EVERY other command gets
 * `--dry-run` force-appended server-side, so a mutation typed into the box can
 * only ever produce a plan. `--json` is implied. The echoed argv in every
 * response shows exactly what ran, forced flags included.
 *
 * Binds strictly to 127.0.0.1. Environment (THINGS_DB / THINGS_NOW /
 * THINGS_TZ) is inherited from the shell that launched the server.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const BIN = join(REPO_ROOT, "bin", "things.js");
const DEFAULT_PORT = 5711;
const RUN_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/**
 * Split a command line into argv with double/single-quote support. No
 * escapes, no expansion — the result is passed to execFile as an array, so
 * shell injection is structurally impossible. Throws on unbalanced quotes.
 */
export function tokenize(input: string): string[] {
  const argv: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let hasToken = false;
  for (const ch of input) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasToken) {
        argv.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (quote !== null) throw new Error(`unbalanced ${quote} quote in command`);
  if (hasToken) argv.push(current);
  return argv;
}

/**
 * Read commands that run VERBATIM (plus implied --json). Everything not
 * matched here is forced through --dry-run. Kept in sync with the CLI
 * registry by a unit test (test/unit/explore.test.ts).
 */
export const READ_VIEWS: readonly string[] = [
  "inbox",
  "today",
  "upcoming",
  "anytime",
  "someday",
  "logbook",
  "search",
  "changes",
  "projects",
  "areas",
  "tags",
  "legend",
  "capabilities",
  "doctor",
  "show",
];

/** Noun/subcommand pairs that are reads (`things <noun> <sub> …`). */
export const READ_SUBCOMMANDS: ReadonlyArray<readonly [string, string]> = [
  ["todo", "show"],
  ["project", "show"],
  ["area", "show"],
  ["config", "get"],
];

/** Commands the explorer refuses outright (with the reason shown to the user). */
const REFUSED: Readonly<Record<string, string>> = {
  batch: "batch reads JSONL from stdin — use the CLI directly (its lines are already --json)",
  mcp: "mcp starts a long-running server — not runnable from the explorer",
};

export interface Classified {
  kind: "run" | "refused";
  /** Final argv (without the node/bin prefix) — present when kind is "run". */
  argv?: string[];
  /** Flags the server force-appended (transparency for the UI). */
  forced?: string[];
  /** Present when kind is "refused". */
  reason?: string;
}

/**
 * Classify a tokenized command and stamp the safety flags. A leading `things`
 * token is tolerated and stripped. `help` passes through untouched (no --json
 * — it is TTY text). Reads on the allowlist run verbatim; `trash` is a read
 * only in its bare-view form (`trash empty` is a mutation and falls through
 * to the forced-dry-run path). Everything else gains `--dry-run`.
 */
export function classify(tokens: string[]): Classified {
  const argv = [...tokens];
  if (argv[0] === "things") argv.shift();
  if (argv.length === 0) return { kind: "refused", reason: "empty command" };

  const head = argv[0]!;
  const refusal = REFUSED[head];
  if (refusal !== undefined) return { kind: "refused", reason: refusal };
  if (head === "help") return { kind: "run", argv, forced: [] };

  const nextPositional = argv.slice(1).find((t) => !t.startsWith("-"));
  const isRead =
    READ_VIEWS.includes(head) ||
    (head === "trash" && nextPositional === undefined) ||
    READ_SUBCOMMANDS.some(([noun, sub]) => head === noun && nextPositional === sub);

  const forced: string[] = [];
  if (!isRead && !argv.includes("--dry-run")) {
    argv.push("--dry-run");
    forced.push("--dry-run");
  }
  if (!argv.includes("--json")) {
    argv.push("--json");
    forced.push("--json");
  }
  return { kind: "run", argv, forced };
}

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  elapsedMs: number;
  argv: string[];
  forced: string[];
  refused?: string;
}

function runCommand(command: string): Promise<RunResult> {
  let classified: Classified;
  try {
    classified = classify(tokenize(command));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Promise.resolve({
      stdout: "",
      stderr: message,
      exitCode: null,
      elapsedMs: 0,
      argv: [],
      forced: [],
      refused: message,
    });
  }
  if (classified.kind === "refused") {
    return Promise.resolve({
      stdout: "",
      stderr: "",
      exitCode: null,
      elapsedMs: 0,
      argv: [],
      forced: [],
      refused: classified.reason ?? "refused",
    });
  }
  const argv = classified.argv ?? [];
  const forced = classified.forced ?? [];
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [BIN, ...argv],
      { timeout: RUN_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, env: process.env },
      (err, stdout, stderr) => {
        const exitCode =
          err === null
            ? 0
            : typeof (err as { code?: unknown }).code === "number"
              ? (err as { code: number }).code
              : null;
        resolve({
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          exitCode,
          elapsedMs: Date.now() - started,
          argv,
          forced,
        });
      },
    );
  });
}

export function startExploreServer(opts: { port?: number } = {}): Promise<Server> {
  const html = readFileSync(join(HERE, "index.html"), "utf8");
  const server = createServer((req, res) => {
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    if (req.method === "POST" && req.url === "/run") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
        if (body.length > 65536) req.destroy();
      });
      req.on("end", () => {
        void (async () => {
          let command: unknown;
          try {
            command = (JSON.parse(body) as { command?: unknown }).command;
          } catch {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "body must be JSON: {command}" }));
            return;
          }
          if (typeof command !== "string" || command.trim() === "") {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "command must be a non-empty string" }));
            return;
          }
          const result = await runCommand(command);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(result));
        })();
      });
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  return new Promise((resolve) => {
    server.listen(opts.port ?? DEFAULT_PORT, "127.0.0.1", () => resolve(server));
  });
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const portFlag = process.argv.indexOf("--port");
  const port = portFlag !== -1 ? Number(process.argv[portFlag + 1]) : DEFAULT_PORT;
  const noOpen = process.argv.includes("--no-open");
  void startExploreServer({ port }).then((server) => {
    const address = server.address();
    const actual = typeof address === "object" && address !== null ? address.port : port;
    const url = `http://127.0.0.1:${actual}/`;
    process.stderr.write(
      `things explore — ${url}\n` +
        `reads run live against your default Things DB · mutations are always --dry-run · localhost only\n`,
    );
    if (!noOpen && process.platform === "darwin") {
      execFile("open", [url], () => {});
    }
  });
}
