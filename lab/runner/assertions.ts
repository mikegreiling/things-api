// Declarative assertion evaluation against before/after snapshots + delta.
//
// Where-clause values may be literals or refs:
//   "@uuidOf:TMTask:title=U04-TARGET"        uuid of the row matching col=value (after snapshot)
//   "@uuidOfBefore:TMArea:title=A25-AREA"    same, against the before snapshot (deleted rows)
//   "@seed:LAB-AREA-A"                       uuid from the golden seed manifest
//   "@ctx:token"                             value from the run context

import type {
  Assertion,
  CellValue,
  CommandResult,
  DbDelta,
  DbSnapshot,
  TableSnapshot,
  Where,
} from "./types.ts";

export interface AssertionContext {
  seed: Record<string, { uuid: string }>;
  ctx: Record<string, string>;
  /** Probe command transport results, for stdoutMatches assertions. */
  commands?: CommandResult[];
  /** Before-snapshot, for @uuidOfBefore refs (rows deleted by the probe). */
  before?: DbSnapshot;
}

export interface AssertionResult {
  assertion: Assertion;
  ok: boolean;
  detail: string;
}

export function evaluateAssertions(
  assertions: Assertion[],
  before: DbSnapshot,
  after: DbSnapshot,
  delta: DbDelta,
  context: AssertionContext,
): AssertionResult[] {
  return assertions.map((assertion) => {
    try {
      return check(assertion, before, after, delta, context);
    } catch (err) {
      return { assertion, ok: false, detail: `evaluation error: ${(err as Error).message}` };
    }
  });
}

function check(
  assertion: Assertion,
  before: DbSnapshot,
  after: DbSnapshot,
  delta: DbDelta,
  context: AssertionContext,
): AssertionResult {
  const fail = (detail: string) => ({ assertion, ok: false, detail });
  const pass = (detail: string) => ({ assertion, ok: true, detail });

  switch (assertion.kind) {
    case "rowExists": {
      const keys = matchRows(after[assertion.table], assertion.where, after, context);
      return keys.length > 0
        ? pass(`matched ${keys.length} row(s): ${keys.join(", ")}`)
        : fail(`no row in ${assertion.table} matches ${JSON.stringify(assertion.where)}`);
    }
    case "rowAbsent": {
      const keys = matchRows(after[assertion.table], assertion.where, after, context);
      return keys.length === 0
        ? pass("no matching row (as expected)")
        : fail(`unexpected row(s) in ${assertion.table}: ${keys.join(", ")}`);
    }
    case "inserted": {
      const keys = matchRows(after[assertion.table], assertion.where, after, context);
      const inserted = delta.inserted.filter(
        (i) => i.table === assertion.table && keys.includes(i.key),
      );
      return inserted.length > 0
        ? pass(`inserted: ${inserted.map((i) => i.key).join(", ")}`)
        : fail(
            `no insert in ${assertion.table} matching ${JSON.stringify(assertion.where)} ` +
              `(matched ${keys.length} existing row(s))`,
          );
    }
    case "notInserted": {
      let inserted = delta.inserted.filter((i) => i.table === assertion.table);
      if (assertion.where !== undefined) {
        const where = assertion.where;
        inserted = inserted.filter((i) => rowMatches(i.row, resolveWhere(where, after, context)));
      }
      return inserted.length === 0
        ? pass("no inserts (as expected)")
        : fail(
            `unexpected insert(s) in ${assertion.table}: ${inserted.map((i) => i.key).join(", ")}`,
          );
    }
    case "fieldEquals": {
      const key = requireOneRow(assertion.table, assertion.where, after, context);
      const row = after[assertion.table]?.[key] ?? {};
      const expected = resolveValue(assertion.value, after, context);
      const actual = row[assertion.field] ?? null;
      return cellEquals(actual, expected)
        ? pass(`${assertion.table}[${key}].${assertion.field} = ${JSON.stringify(actual)}`)
        : fail(
            `${assertion.table}[${key}].${assertion.field}: expected ${JSON.stringify(expected)}, ` +
              `got ${JSON.stringify(actual)}`,
          );
    }
    case "fieldUnchanged": {
      const key = requireOneRow(assertion.table, assertion.where, after, context);
      const beforeRow = before[assertion.table]?.[key];
      if (beforeRow === undefined)
        return fail(`${assertion.table}[${key}] absent in before-snapshot`);
      const afterRow = after[assertion.table]?.[key] ?? {};
      const diffs = assertion.fields.filter(
        (f) => !cellEquals(beforeRow[f] ?? null, afterRow[f] ?? null),
      );
      return diffs.length === 0
        ? pass(`fields unchanged: ${assertion.fields.join(", ")}`)
        : fail(`fields changed on ${assertion.table}[${key}]: ${diffs.join(", ")}`);
    }
    case "unchanged": {
      const key = requireOneRow(assertion.table, assertion.where, after, context);
      const touched =
        delta.changed.some((c) => c.table === assertion.table && c.key === key) ||
        delta.deleted.some((d) => d.table === assertion.table && d.key === key);
      return touched ? fail(`${assertion.table}[${key}] was modified`) : pass("row untouched");
    }
    case "rowCount": {
      const keys = matchRows(after[assertion.table], assertion.where, after, context);
      return keys.length === assertion.count
        ? pass(`count = ${keys.length}`)
        : fail(`expected ${assertion.count} row(s) in ${assertion.table}, found ${keys.length}`);
    }
    case "deltaEmpty": {
      const total = delta.inserted.length + delta.deleted.length + delta.changed.length;
      return total === 0
        ? pass("no DB changes")
        : fail(
            `delta not empty: ${delta.inserted.length} inserted, ` +
              `${delta.deleted.length} deleted, ${delta.changed.length} changed`,
          );
    }
    case "deleted": {
      // Match against the BEFORE snapshot (the row is gone from after).
      const keys = matchRows(before[assertion.table], assertion.where, before, context);
      if (keys.length === 0) {
        return fail(
          `no before-row in ${assertion.table} matches ${JSON.stringify(assertion.where)}`,
        );
      }
      const gone = keys.filter((k) =>
        delta.deleted.some((d) => d.table === assertion.table && d.key === k),
      );
      return gone.length === keys.length
        ? pass(`deleted: ${gone.join(", ")}`)
        : fail(
            `row(s) still present in ${assertion.table}: ` +
              keys.filter((k) => !gone.includes(k)).join(", "),
          );
    }
    case "stdoutMatches": {
      const cmd = context.commands?.[assertion.command];
      if (cmd === undefined) return fail(`no command at index ${assertion.command}`);
      // osascript always emits a trailing newline; anchors should see past it.
      const stdout = cmd.stdout.trim();
      return new RegExp(assertion.pattern).test(stdout)
        ? pass(`stdout of command ${assertion.command} matches /${assertion.pattern}/`)
        : fail(
            `stdout of command ${assertion.command} does not match /${assertion.pattern}/: ` +
              JSON.stringify(stdout.slice(0, 200)),
          );
    }
    default: {
      const exhaustive: never = assertion;
      return { assertion: exhaustive, ok: false, detail: "unknown assertion kind" };
    }
  }
}

function requireOneRow(
  table: string,
  where: Where,
  after: DbSnapshot,
  context: AssertionContext,
): string {
  const keys = matchRows(after[table], where, after, context);
  const first = keys[0];
  if (first === undefined) {
    throw new Error(`no row in ${table} matches ${JSON.stringify(where)}`);
  }
  if (keys.length > 1) {
    throw new Error(
      `ambiguous selector: ${keys.length} rows in ${table} match ${JSON.stringify(where)}`,
    );
  }
  return first;
}

function matchRows(
  table: TableSnapshot | undefined,
  where: Where,
  after: DbSnapshot,
  context: AssertionContext,
): string[] {
  if (table === undefined) return [];
  const resolved = resolveWhere(where, after, context);
  return Object.keys(table)
    .filter((key) => {
      const row = table[key];
      return row !== undefined && rowMatches(row, resolved);
    })
    .toSorted();
}

function rowMatches(row: Record<string, CellValue>, where: Where): boolean {
  return Object.entries(where).every(([col, val]) => cellEquals(row[col] ?? null, val));
}

function resolveWhere(where: Where, after: DbSnapshot, context: AssertionContext): Where {
  const out: Where = {};
  for (const [col, val] of Object.entries(where)) {
    out[col] = resolveValue(val, after, context);
  }
  return out;
}

export function resolveValue(
  value: CellValue,
  after: DbSnapshot,
  context: AssertionContext,
): CellValue {
  if (typeof value !== "string" || !value.startsWith("@")) return value;

  const uuidOf = value.match(/^@uuidOf(Before)?:([^:]+):([^=]+)=(.*)$/);
  if (uuidOf !== null) {
    const [, inBefore, table = "", col = "", literal = ""] = uuidOf;
    const source = inBefore !== undefined ? (context.before ?? {}) : after;
    const rows = source[table] ?? {};
    const keys = Object.keys(rows)
      .filter((k) => cellEquals(rows[k]?.[col] ?? null, literal))
      .toSorted();
    const first = keys[0];
    if (first === undefined) throw new Error(`@uuidOf: no ${table} row with ${col}=${literal}`);
    if (keys.length > 1) throw new Error(`@uuidOf: ambiguous ${table} ${col}=${literal}`);
    return first;
  }

  const seed = value.match(/^@seed:(.+)$/);
  if (seed !== null) {
    const name = seed[1] ?? "";
    const entry = context.seed[name];
    if (entry === undefined) throw new Error(`@seed: no manifest entry "${name}"`);
    return entry.uuid;
  }

  const ctx = value.match(/^@ctx:(.+)$/);
  if (ctx !== null) {
    const key = ctx[1] ?? "";
    const entry = context.ctx[key];
    if (entry === undefined) throw new Error(`@ctx: no context key "${key}"`);
    return entry;
  }

  throw new Error(`unknown ref syntax: ${value}`);
}

function cellEquals(a: CellValue, b: CellValue): boolean {
  if (typeof a === "number" && typeof b === "number") {
    return a === b || Math.abs(a - b) < 1e-6;
  }
  // Snapshot cells are typed (int/real/text); where-clauses written in JSON
  // may express integers for text columns and vice versa — compare loosely
  // across the number/string boundary only when a lossless coercion exists.
  if (typeof a === "number" && typeof b === "string" && b !== "" && Number(b) === a) return true;
  if (typeof a === "string" && typeof b === "number" && a !== "" && Number(a) === b) return true;
  return a === b;
}
