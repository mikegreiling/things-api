/**
 * Read-only connection to a Things database via node:sqlite.
 *
 * WAL policy (docs/design/architecture.md §0):
 * - `readOnly: true`, never `immutable=1` — the DB changes while Things runs;
 *   immutable would poison verification polling with stale snapshots.
 * - Each statement outside a transaction gets a fresh WAL read snapshot;
 *   the verification poller relies on this. Never wrap polling in a
 *   long-lived transaction.
 * - Requires the -shm/-wal sidecars to be accessible (present whenever
 *   Things has run at least once).
 */
import { DatabaseSync } from "node:sqlite";

export interface ThingsConnection {
  db: DatabaseSync;
  path: string;
  close(): void;
}

export class ThingsDbOpenError extends Error {
  constructor(path: string, cause: unknown) {
    super(
      `Could not open Things database read-only at ${path}. ` +
        `If this is a WAL/-shm access error, launch Things once and retry.`,
      { cause },
    );
    this.name = "ThingsDbOpenError";
  }
}

export function openConnection(path: string): ThingsConnection {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, {
      readOnly: true,
      timeout: 2000,
    });
  } catch (cause) {
    throw new ThingsDbOpenError(path, cause);
  }
  return {
    db,
    path,
    close() {
      db.close();
    },
  };
}
