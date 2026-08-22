/**
 * A DatabaseSync-shaped READ facade over the deputy's `sql` verb. The read
 * layer types against node:sqlite's DatabaseSync and only ever prepares
 * SELECT/PRAGMA statements consumed via `.all()` / `.get()`; this facade
 * implements exactly that surface synchronously (through the bridge) and
 * throws a teaching error on anything else — never a silent no-op. WAL
 * freshness is preserved: the deputy holds one read-only connection outside
 * any transaction, so every statement sees a fresh snapshot exactly like a
 * local connection (docs/design/architecture.md §0).
 */
import type { DatabaseSync } from "node:sqlite";

import { type DeputyRow, reviveRow } from "./protocol.ts";
import { fileSyncRequest } from "./routing.ts";

const SQL_TIMEOUT_MS = 15_000;

type SqlParam = string | number | bigint | null;

function normalizeParams(params: unknown[], sql: string): SqlParam[] {
  return params.map((param, index) => {
    if (param === null || typeof param === "string" || typeof param === "number") return param;
    if (typeof param === "bigint") {
      if (param > BigInt(Number.MAX_SAFE_INTEGER) || param < BigInt(Number.MIN_SAFE_INTEGER)) {
        throw new TypeError(`deputy sql: bigint parameter ${index} exceeds JSON-safe range`);
      }
      return Number(param);
    }
    throw new TypeError(
      `deputy sql: unsupported ${typeof param} parameter at index ${index} for: ${sql.slice(0, 80)}`,
    );
  });
}

function queryRows(sql: string, params: unknown[], env: NodeJS.ProcessEnv): DeputyRow[] {
  // Rides the granted reader when present, else the deputy (routing.ts).
  const res = fileSyncRequest(
    { verb: "sql", sql, params: normalizeParams(params, sql) },
    SQL_TIMEOUT_MS,
    env,
  );
  return (res["rows"] as DeputyRow[]).map(reviveRow);
}

function unsupported(member: string): () => never {
  return () => {
    throw new Error(
      `DatabaseSync.${member} is not available on a deputy-routed connection — the deputy brokers read-only prepare/all/get only. Disable the helpers (THINGS_API_HELPERS=false) for local access.`,
    );
  };
}

/**
 * Build the facade. The cast is confined to this one construction site: the
 * object structurally implements the read subset, a Proxy turns any other
 * member access into a teaching error, and symbol probes (inspect, iterators)
 * stay undefined so logging never explodes.
 */
export function createDeputyDbFacade(env: NodeJS.ProcessEnv = process.env): DatabaseSync {
  const base = {
    prepare(sql: string) {
      const statement = {
        all(...params: unknown[]): unknown[] {
          return queryRows(sql, params, env);
        },
        get(...params: unknown[]): unknown {
          return queryRows(sql, params, env)[0];
        },
        run: unsupported("prepare(...).run (writes never touch the database directly)"),
        iterate: unsupported("prepare(...).iterate"),
        expandedSQL: sql,
        sourceSQL: sql,
      };
      return new Proxy(statement, {
        get(target, prop, receiver) {
          if (typeof prop === "symbol" || prop in target)
            return Reflect.get(target, prop, receiver);
          return unsupported(`prepare(...).${String(prop)}`)();
        },
      });
    },
    exec: unsupported("exec"),
    close(): void {
      // The bridge outlives individual connections; nothing to release here.
    },
    isOpen: true,
    isTransaction: false,
  };
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (typeof prop === "symbol" || prop in target) return Reflect.get(target, prop, receiver);
      return unsupported(String(prop))();
    },
  }) as unknown as DatabaseSync;
}
