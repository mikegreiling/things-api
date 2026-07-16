/**
 * The read driver: open the client, stamp the envelope meta, and emit either
 * the `--json` envelope or human lines (with the TTY-only title preamble,
 * normalized-form echo, and truncation hint). Plus the shared `--limit`/`--all`
 * cap parsing and the invocation-echo helpers every read command reuses. No
 * commander dependency — command registration lives in the command modules.
 */
import { openThings, type ThingsClient } from "../client.ts";
import { ThingsDbNotFoundError } from "../db/locate.ts";
import { ThingsDbOpenError } from "../db/connection.ts";
import { getInvocation } from "./resolve-invocation.ts";
import { dim } from "./style.ts";
import { viewHeaderLines } from "./render.ts";
import { candidatesJson, DidYouMeanError, renderDidYouMean } from "./did-you-mean.ts";
import { ReferenceResolutionError } from "../read/queries.ts";
import {
  errorEnvelope,
  ExitCode,
  okEnvelope,
  type EnvelopeMeta,
  type GroupedPagination,
  type Pagination,
} from "../contracts.ts";
import { resolveCap } from "../read/caps.ts";
import { DEFAULT_LIST_LIMIT } from "../read/pagination.ts";
import { omitEmpty } from "../model/serialize.ts";
import { schemaWarnings } from "../surface-copy.ts";

export interface GlobalReadOpts {
  json?: boolean;
  db?: string;
}

/**
 * The single usage-error emitter every command surface routes flag/argument
 * errors through, so `--json` is honored uniformly: under `--json` a
 * `{ok:false, error:{code:"usage", …}}` envelope goes to STDOUT (machine
 * consumers read one stream); otherwise the prose `error:` line goes to
 * STDERR. `details` carries the same machine-readable `candidates`/`suggestions`
 * shape the resolver errors use. Always sets the Usage exit code.
 */
export function usageError(
  opts: { json?: boolean },
  message: string,
  details?: { candidates?: unknown[]; suggestions?: string[] },
): void {
  if (opts.json === true) {
    const meta: EnvelopeMeta = { dbVersion: null, fingerprint: "unknown", elapsedMs: 0 };
    process.stdout.write(
      `${JSON.stringify(
        errorEnvelope({ code: "usage", message, ...(details !== undefined && { details }) }, meta),
      )}\n`,
    );
  } else {
    process.stderr.write(`error: ${message}\n`);
  }
  process.exitCode = ExitCode.Usage;
}

export interface PagedResult<T> {
  data: T;
  /** Flat-view truncation — carried into meta and the appended hint. */
  pagination?: Pagination;
  /** Grouped-view (anytime/someday) per-block truncation — carried into meta. */
  grouped?: GroupedPagination;
  /**
   * Precomputed human lines. Grouped views render inside `fn` (where the full
   * per-block totals live) and hand the finished lines back here; when absent,
   * `render(data)` produces them.
   */
  lines?: string[];
}

/**
 * The shared read driver: open the client, stamp the envelope meta (including
 * fingerprint + optional pagination), and either emit the `--json` envelope or
 * render human lines. When `hintBase` is given and the result was truncated,
 * the muted "N more items" hint (reconstructing the user's own invocation) is
 * appended to the human output — never to `--json`. When `header` names a view,
 * its title preamble leads the human output on a TTY only (viewHeaderLines).
 */
export function runRead<T>(
  opts: GlobalReadOpts,
  kind: string,
  fn: (client: ThingsClient) => PagedResult<T>,
  render: (data: T) => string[],
  hintBase?: string,
  header?: string,
): void {
  const started = Date.now();
  // An empty --db would silently fall through to the default database path —
  // reject it loudly instead of reading somewhere the caller did not name.
  if (opts.db !== undefined && opts.db.trim() === "") {
    usageError(opts, "--db requires a non-empty path");
    return;
  }
  let client: ThingsClient | null = null;
  try {
    client = openThings(opts.db ? { dbPath: opts.db } : {});
    const fp = client.fingerprint();
    // Reads never block on a schema change — they warn (design decision). The
    // note reuses the same cached fingerprint the write path gates on.
    const warnings = schemaWarnings(client.schemaStatus());
    const { data, pagination, grouped, lines: precomputed } = fn(client);
    // The canonical command a sugar invocation normalized to — known now that
    // `fn` has resolved any reference. Present only for the routing sugars
    // (bare noun, keyword-in-show, uuid/share-link routing); null otherwise.
    const resolvedCommand = getInvocation()?.canonical ?? null;
    const meta: EnvelopeMeta = {
      dbVersion: fp.observation.databaseVersion,
      fingerprint: fp.kind === "ok" ? "ok" : fp.kind === "drift" ? "drift" : "unknown",
      elapsedMs: Date.now() - started,
      ...(pagination !== undefined && { pagination }),
      ...(grouped !== undefined && { grouped }),
      ...(resolvedCommand !== null && { resolvedCommand }),
      ...(warnings.length > 0 && { warnings }),
    };
    // Human output gets the note once on STDERR (never mixed into the piped
    // stdout rows); the --json envelope carries it in meta.warnings instead.
    if (!opts.json) {
      for (const warning of warnings) process.stderr.write(`warning: ${warning}\n`);
    }
    if (opts.json) {
      // Omit-empty applies to the entity/data payload only (contracts.md); the
      // envelope meta/pagination is untouched, and the human render below keeps
      // the full, unpruned `data`.
      process.stdout.write(`${JSON.stringify(okEnvelope(kind, omitEmpty(data), meta))}\n`);
    } else {
      const lines = precomputed ?? render(data);
      if (pagination !== undefined && hintBase !== undefined) {
        const hint = truncationHint(hintBase, pagination);
        if (hint !== null) lines.push("", hint);
      }
      // The view title preamble is a TTY-only affordance (`things inbox | grep`
      // must stay clean) and never rides --json — both gates already hold here.
      const withHeader =
        header !== undefined && process.stdout.isTTY === true
          ? [...viewHeaderLines(header), ...lines]
          : lines;
      // The normalized-form echo: one dim line naming the canonical command a
      // sugar invocation resolved to, adjacent to the header. Same gates as the
      // preamble (TTY-only, never in --json) — canonical invocations echo
      // nothing because `resolvedCommand` is null for them.
      const out =
        resolvedCommand !== null && process.stdout.isTTY === true
          ? [dim(`≡ ${resolvedCommand}`), ...withHeader]
          : withHeader;
      process.stdout.write(`${out.join("\n")}\n`);
    }
    process.exitCode = ExitCode.Ok;
  } catch (err) {
    const meta: EnvelopeMeta = {
      dbVersion: null,
      fingerprint: "unknown",
      elapsedMs: Date.now() - started,
    };
    // An unresolved show/bare-noun subject carries did-you-mean candidates: a
    // usage-level failure (exit 2) with a lite title-search fallback, not the
    // generic unexpected path.
    if (err instanceof DidYouMeanError) {
      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            errorEnvelope(
              {
                code: "not-found",
                message: err.message,
                details: { candidates: candidatesJson(err) },
              },
              meta,
            ),
          )}\n`,
        );
      } else {
        process.stderr.write(`${renderDidYouMean(err).join("\n")}\n`);
      }
      process.exitCode = ExitCode.Usage;
      return;
    }
    // An unresolved uuid/partial-uuid/name (ambiguous or not-found) is a
    // usage-class failure carrying machine-readable candidates.
    if (err instanceof ReferenceResolutionError) {
      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            errorEnvelope(
              { code: err.code, message: err.message, details: { candidates: err.candidates } },
              meta,
            ),
          )}\n`,
        );
      } else {
        process.stderr.write(`error: ${err.message}\n`);
      }
      process.exitCode = ExitCode.Usage;
      return;
    }
    const isEnv = err instanceof ThingsDbNotFoundError || err instanceof ThingsDbOpenError;
    const message = err instanceof Error ? err.message : String(err);
    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify(errorEnvelope({ code: isEnv ? "environment" : "unexpected", message }, meta))}\n`,
      );
    } else {
      process.stderr.write(`error: ${message}\n`);
    }
    process.exitCode = isEnv ? ExitCode.Environment : ExitCode.Unexpected;
  } finally {
    client?.close();
  }
}

/**
 * Structured single-payload read: `fn` produces the whole payload, `render`
 * turns it into human lines. Generic so `fn`'s return type flows into
 * `render`'s parameter — the compiler verifies the renderer matches the data.
 */
export function withClient<T>(
  opts: GlobalReadOpts,
  kind: string,
  fn: (client: ThingsClient) => T,
  render: (data: T) => string[],
): void {
  runRead<T>(opts, kind, (client) => ({ data: fn(client) }), render);
}

/** Result of resolving `--limit`/`--all`; `limit: null` means every row. */
export type LimitResolution = { ok: true; limit: number | null } | { ok: false };

/**
 * Resolve the shared `--limit`/`--all` pair (flat views) into a row cap
 * (null = no cap), writing a loud usage error and setting the exit code on
 * bad input: `--limit` must be a positive integer, and it may not combine
 * with `--all`.
 */
export function parseLimit(opts: {
  limit?: string;
  all?: boolean;
  json?: boolean;
}): LimitResolution {
  return parseCap("--limit", opts.limit, DEFAULT_LIST_LIMIT, opts.all === true, opts.json === true);
}

/**
 * Resolve one cap flag (`--limit`, `--area-limit`, `--project-limit`) against
 * `--all`: positive integer required, `--all` conflicts with an explicit
 * value and otherwise lifts the cap (null). The conflict/default decision is
 * the shared {@link resolveCap}; this surface adds the string→integer
 * validation and the usage-error emission.
 */
export function parseCap(
  flag: string,
  value: string | undefined,
  defaultLimit: number,
  all: boolean,
  json = false,
): LimitResolution {
  const n = value === undefined ? undefined : Number(value);
  const decision = resolveCap(n, all, defaultLimit);
  // Conflict takes precedence over value validation (an explicit value beside
  // --all is rejected before we scrutinize the value itself).
  if (decision === "conflict") {
    usageError({ json }, `${flag} and --all are mutually exclusive`);
    return { ok: false };
  }
  if (n !== undefined && (!Number.isInteger(n) || n < 1)) {
    usageError({ json }, `${flag} must be a positive integer`);
    return { ok: false };
  }
  return { ok: true, limit: decision };
}

export { shellQuote } from "./shell-quote.ts";

/** Reconstruct `things <name> <flags…>`, dropping falsy/empty parts. */
export function invocation(name: string, parts: Array<string | false | undefined>): string {
  return [
    "things",
    name,
    ...parts.filter((p): p is string => typeof p === "string" && p !== ""),
  ].join(" ");
}

/**
 * The unified truncation hint: a muted `── N more items — see more: … · … ──`
 * line whose commands echo the user's actual invocation, so a bigger
 * `--limit` or `--all` is one copy-paste away. Returns null when nothing was
 * dropped or the caller already asked for every row.
 */
export function truncationHint(base: string, pagination: Pagination): string | null {
  if (!pagination.truncated || pagination.limit === null) return null;
  const more = pagination.total - pagination.shown;
  const bigger = pagination.limit * 2;
  return dim(
    `── ${more} more item${more === 1 ? "" : "s"} — see more: \`${base} --limit ${bigger}\` · \`${base} --all\` ──`,
  );
}
