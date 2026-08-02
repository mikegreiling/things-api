/**
 * `npm run explore` — a localhost-only debug view over the live CLI.
 *
 * Serves a single-page explorer (scripts/explore/index.html) and a POST /run
 * endpoint that executes `bin/things.js` with a tokenized argv (never a
 * shell). Reads on the allowlist run verbatim; EVERY other command gets
 * `--dry-run` force-appended server-side, so a mutation typed into the box can
 * only ever produce a plan. Since `--dry-run` is now a UNIVERSAL flag (accepted
 * by every command; a no-op on reads), force-appending it to a read this
 * allowlist doesn't recognize is harmless — that command just runs normally
 * instead of erroring on an unknown option. `--json` is implied. The echoed argv
 * in every response shows exactly what ran, forced flags included.
 *
 * Binds to 127.0.0.1 by default. With `--public` it binds 0.0.0.0 for LAN
 * access (phone/tablet on the same network) and gates every request behind a
 * random per-launch token: the page is served only to a request carrying the
 * `?key=` (which then plants an `exploreKey` cookie) or that cookie; `/run`
 * also accepts an `x-explore-key` header. Environment (THINGS_DB / THINGS_NOW /
 * THINGS_TZ) is inherited from the shell that launched the server.
 */
import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
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
 * matched here is forced through --dry-run — harmless even for a read this list
 * misses, since --dry-run is universal and a no-op on reads. Kept in sync with
 * the CLI registry by a unit test (test/unit/explore.test.ts).
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

/** True iff `value` equals `token` (length-checked timing-safe compare). */
function keyMatches(value: string | null | undefined, token: string): boolean {
  if (value === null || value === undefined) return false;
  const a = Buffer.from(value);
  const b = Buffer.from(token);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Parse a `Cookie:` header into a name→value map (no decoding needed here). */
function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (header === undefined) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name !== "") out[name] = part.slice(eq + 1).trim();
  }
  return out;
}

/** 403 with a short plain-text body naming the fix. */
function unauthorized(res: ServerResponse): void {
  res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
  res.end("unauthorized — open the printed ?key= URL first\n");
}

/** Non-internal IPv4 addresses of every network interface. */
function lanIPv4s(): string[] {
  const out: string[] = [];
  for (const infos of Object.values(networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === "IPv4" && !info.internal) out.push(info.address);
    }
  }
  return out;
}

export interface ExploreServerOptions {
  port?: number;
  /** Bind 0.0.0.0 and gate every request behind a per-launch token. */
  public?: boolean;
  /** Inject a fixed token (test seam); otherwise one is minted at random. */
  token?: string;
}

export interface ExploreServerHandle {
  server: Server;
  /** The gating token in public mode; null in local (ungated) mode. */
  token: string | null;
}

export function startExploreServer(opts: ExploreServerOptions = {}): Promise<ExploreServerHandle> {
  const isPublic = opts.public === true;
  const token = isPublic ? (opts.token ?? randomBytes(16).toString("hex")) : null;
  const rawHtml = readFileSync(join(HERE, "index.html"), "utf8");
  // In public mode the served copy swaps the local-only banner phrase; the file
  // on disk is left untouched so local mode still reads "localhost only".
  const html = isPublic ? rawHtml.replace("localhost only", "LAN access · token-gated") : rawHtml;

  const server = createServer((req, res) => {
    const parsed = new URL(req.url ?? "/", "http://localhost");
    const pathname = parsed.pathname;
    const cookies = parseCookies(req.headers.cookie);
    if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8" };
      if (isPublic && token !== null) {
        const keyOk = keyMatches(parsed.searchParams.get("key"), token);
        const cookieOk = keyMatches(cookies["exploreKey"], token);
        if (!keyOk && !cookieOk) return unauthorized(res);
        // A fresh ?key= plants the cookie so the phone stays signed in.
        if (keyOk) headers["set-cookie"] = `exploreKey=${token}; HttpOnly; SameSite=Lax; Path=/`;
      }
      res.writeHead(200, headers);
      res.end(html);
      return;
    }
    if (req.method === "POST" && pathname === "/run") {
      if (isPublic && token !== null) {
        const headerKey = req.headers["x-explore-key"];
        const authorized =
          keyMatches(cookies["exploreKey"], token) ||
          keyMatches(parsed.searchParams.get("key"), token) ||
          keyMatches(Array.isArray(headerKey) ? headerKey[0] : headerKey, token);
        if (!authorized) return unauthorized(res);
      }
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
  const host = isPublic ? "0.0.0.0" : "127.0.0.1";
  return new Promise((resolve) => {
    server.listen(opts.port ?? DEFAULT_PORT, host, () => resolve({ server, token }));
  });
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const portFlag = process.argv.indexOf("--port");
  const port = portFlag !== -1 ? Number(process.argv[portFlag + 1]) : DEFAULT_PORT;
  const noOpen = process.argv.includes("--no-open");
  const isPublic = process.argv.includes("--public");
  void startExploreServer({ port, public: isPublic }).then(({ server, token }) => {
    const address = server.address();
    const actual = typeof address === "object" && address !== null ? address.port : port;
    const suffix = token !== null ? `?key=${token}` : "";
    const localUrl = `http://127.0.0.1:${actual}/${suffix}`;
    if (token !== null) {
      const urls = ["127.0.0.1", ...lanIPv4s()].map(
        (ip) => `  http://${ip}:${actual}/?key=${token}`,
      );
      process.stderr.write(
        `things explore — LAN access · token-gated\n` +
          `reads run live against your default Things DB · mutations are always --dry-run\n\n` +
          `${urls.join("\n")}\n\n` +
          `open once on your phone — a cookie keeps you signed in\n`,
      );
    } else {
      process.stderr.write(
        `things explore — ${localUrl}\n` +
          `reads run live against your default Things DB · mutations are always --dry-run · localhost only\n`,
      );
    }
    if (!noOpen && process.platform === "darwin") {
      execFile("open", [localUrl], () => {});
    }
  });
}
