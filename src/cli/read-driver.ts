/**
 * The read driver: open the client, stamp the envelope meta, and emit either
 * the `--json` envelope or human lines (with the TTY-only title preamble,
 * normalized-form echo, and truncation hint). Plus the shared `--limit`/`--all`
 * cap parsing and the invocation-echo helpers every read command reuses. No
 * commander dependency — command registration lives in the command modules.
 */
import { getInvocation } from "./resolve-invocation.ts";
import { dim } from "./style.ts";
import { viewHeaderLines } from "./render.ts";
import {
  candidatesJson,
  DidYouMeanError,
  didYouMeanMessage,
  renderDidYouMean,
} from "./did-you-mean.ts";
import {
  ClockError,
  DEFAULT_LIST_LIMIT,
  errorEnvelope,
  ExitCode,
  okEnvelope,
  omitEmpty,
  openThings,
  shapeReadPayload,
  ReferenceResolutionError,
  schemaWarnings,
  ThingsDbNotFoundError,
  ThingsDbOpenError,
  type EnvelopeMeta,
  type ThingsClient,
  type TodayView,
  type Truncation,
  type ViewFilterMeta,
} from "../index.ts";

/**
 * Kinds whose read payload is a flat list; their envelope `data` is the R1
 * `{ items: [...] }` wrapper (data is ALWAYS a JSON object, never a bare array).
 */
const ITEMS_WRAPPER_KINDS: ReadonlySet<string> = new Set([
  "inbox",
  "upcoming",
  "logbook",
  "trash",
  "changes",
  "search",
  "projects",
  "areas",
  "tags",
]);

/**
 * Shape a read payload into its envelope `data` object (the 1.0 contract, R1/R2):
 * `data` is always an object. Flat lists become `{ items }`; the sectioned
 * catalogues (anytime/someday) become `{ sections }`; `today` becomes
 * `{ sections: [{key,items}…], badge }`; the composite cards become `{ view }`;
 * a single-entity detail becomes `{ item }`. Everything already object-shaped
 * (open/snapshot/…) passes through. The human-render path keeps the raw inner
 * payload — this transform is the JSON emit boundary only.
 */
export function wrapEnvelopeData(kind: string, data: unknown): unknown {
  if (ITEMS_WRAPPER_KINDS.has(kind)) return { items: data };
  if (kind === "anytime" || kind === "someday") return { sections: data };
  if (kind === "today") {
    const view = data as TodayView;
    return {
      sections: [
        { key: "today", items: view.today },
        { key: "evening", items: view.evening },
      ],
      badge: view.badge,
    };
  }
  if (kind === "area-view" || kind === "project-view") return { view: data };
  if (kind === "detail") return { item: data };
  return data;
}

export interface GlobalReadOpts {
  json?: boolean;
  db?: string;
  /**
   * Force the FULL detail tier (R7) in a list context — restore the per-row
   * density a compact list drops (`created`/`modified`, the full `repeating`
   * block, full `notes`, the default-valued fields). Set by the `--full` flag on
   * the list-emitting commands; absent = the compact default. The no-redundant-
   * ancestry pruning (R6) is applied regardless.
   */
  full?: boolean;
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
        errorEnvelope(
          { code: "usage", message, ...(details !== undefined && { detail: details }) },
          meta,
        ),
      )}\n`,
    );
  } else {
    process.stderr.write(`error: ${message}\n`);
  }
  process.exitCode = ExitCode.Usage;
}

export interface PagedResult<T> {
  data: T;
  /**
   * The unified completeness metadata — flat-view row counts, the Today split's
   * per-section counts, OR a grouped view's per-block `blocks`. Carried into
   * `meta.truncation` and (for flat views with a `hintBase`) the appended hint.
   */
  truncation?: Truncation;
  /**
   * Override the envelope `kind` (and thus the R1/R2 data wrapper) for this
   * result — set by the loose `show` router, which resolves its target kind
   * only inside `fn` (a to-do → `detail`, a project → `project-view`, an area →
   * `area-view`). Absent = the `kind` argument passed to {@link runRead}.
   */
  kind?: string;
  /** Active content filter (the `--area` scope) — carried into `meta.filter`. */
  filter?: ViewFilterMeta;
  /**
   * Additional non-blocking advisories from the read itself (ADDITIVE), merged
   * with the schema-drift warnings into `meta.warnings` (and echoed once on
   * stderr for human output). Used by the `loose` pseudo-area reads to surface
   * the resolution-shadow disclosure.
   */
  warnings?: string[];
  /**
   * Precomputed human lines. Grouped views render inside `fn` (where the full
   * per-block totals live) and hand the finished lines back here; when absent,
   * `render(data)` produces them.
   */
  lines?: string[];
}

/**
 * The shared read driver: open the client, stamp the envelope meta (including
 * fingerprint + optional truncation), and either emit the `--json` envelope or
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
    const {
      data,
      truncation,
      kind: kindOverride,
      filter,
      warnings: readWarnings,
      lines: precomputed,
    } = fn(client);
    // Schema-drift advisories plus any read-specific advisories (e.g. the loose
    // pseudo-area resolution-shadow disclosure).
    const warnings = [...schemaWarnings(client.schemaStatus()), ...(readWarnings ?? [])];
    const effectiveKind = kindOverride ?? kind;
    // The canonical command a sugar invocation normalized to — known now that
    // `fn` has resolved any reference. Present only for the routing sugars
    // (bare noun, keyword-in-show, uuid/share-link routing); null otherwise.
    const resolvedCommand = getInvocation()?.canonical ?? null;
    // The clock honesty field: present only when a consumer zone / pinned now
    // is in effect (absent = host clock, so the wire shape is unchanged).
    const clock = client.clockMeta();
    // The active container scope (additive): present only when the client is
    // jailed, so an agent knows its own jail (not an oracle for what's outside).
    const scope = client.scope;
    const meta: EnvelopeMeta = {
      dbVersion: fp.observation.databaseVersion,
      fingerprint: fp.kind === "ok" ? "ok" : fp.kind === "drift" ? "drift" : "unknown",
      elapsedMs: Date.now() - started,
      ...(truncation !== undefined && { truncation }),
      ...(resolvedCommand !== null && { resolvedCommand }),
      ...(warnings.length > 0 && { warnings }),
      ...(clock !== undefined && { clock }),
      ...(filter !== undefined && { filter }),
      ...(scope !== undefined && { scope }),
    };
    // Human output gets the note once on STDERR (never mixed into the piped
    // stdout rows); the --json envelope carries it in meta.warnings instead.
    if (!opts.json) {
      for (const warning of warnings) process.stderr.write(`warning: ${warning}\n`);
    }
    if (opts.json) {
      // Omit-empty applies to the entity/data payload only (contracts.md); the
      // envelope meta/truncation is untouched, and the human render below keeps
      // the full, unpruned `data`.
      const shaped = shapeReadPayload(effectiveKind, data, opts.full === true);
      process.stdout.write(
        `${JSON.stringify(okEnvelope(effectiveKind, omitEmpty(wrapEnvelopeData(effectiveKind, shaped)), meta))}\n`,
      );
    } else {
      const lines = precomputed ?? render(data);
      if (truncation !== undefined && hintBase !== undefined) {
        const hint = truncationHint(hintBase, truncation);
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
      // The scope banner: one dim line naming the active jail, so a scoped
      // read is never silently partial (TTY-only, never in --json). A
      // stored-config scope must not be a mystery jail.
      const scopeBanner =
        scope !== undefined && process.stdout.isTTY === true
          ? [dim(`scoped to ${scope.kind} "${scope.title}"`)]
          : [];
      const normalized =
        resolvedCommand !== null && process.stdout.isTTY === true
          ? [dim(`≡ ${resolvedCommand}`)]
          : [];
      const out = [...scopeBanner, ...normalized, ...withHeader];
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
                message: didYouMeanMessage(err),
                detail: { candidates: candidatesJson(err) },
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
              { code: err.code, message: err.message, detail: { candidates: err.candidates } },
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
    // A malformed THINGS_TZ / THINGS_NOW (or per-read zone) fails closed as a
    // usage error naming the expected form — never a silent host fallback.
    if (err instanceof ClockError) {
      usageError(opts, err.message);
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
  /** Optional read-specific advisories (merged into `meta.warnings` + stderr). */
  warnings?: (client: ThingsClient) => string[] | undefined,
): void {
  runRead<T>(
    opts,
    kind,
    (client) => {
      const data = fn(client);
      const w = warnings?.(client);
      return { data, ...(w !== undefined && w.length > 0 && { warnings: w }) };
    },
    render,
  );
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
 * value and otherwise lifts the cap (null). This surface owns the string→integer
 * validation and the usage-error emission; the client re-applies the same
 * conflict/default semantics on the resolved value it receives.
 */
export function parseCap(
  flag: string,
  value: string | undefined,
  defaultLimit: number,
  all: boolean,
  json = false,
): LimitResolution {
  const n = value === undefined ? undefined : Number(value);
  // Resolve --all/value into a cap: an explicit value beside --all is a
  // conflict; --all alone lifts the cap (null); otherwise the value or default.
  const decision: number | null | "conflict" =
    all && n !== undefined ? "conflict" : all ? null : (n ?? defaultLimit);
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
export function truncationHint(base: string, truncation: Truncation): string | null {
  if (!truncation.truncated || truncation.limit === null) return null;
  const more = truncation.total - truncation.shown;
  const bigger = truncation.limit * 2;
  return dim(
    `── ${more} more item${more === 1 ? "" : "s"} — see more: \`${base} --limit ${bigger}\` · \`${base} --all\` ──`,
  );
}
