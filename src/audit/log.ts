/**
 * JSONL audit writer: monthly files, never auto-deleted, structural token
 * redaction — the serializer refuses to emit any string containing the
 * loaded auth token.
 *
 * DURABILITY + TEAR-RESISTANCE (M5). Audit appends happen from processes that
 * do NOT hold the mutation lock (e.g. a drift-gate or lock-contention block is
 * recorded before/without ever acquiring it), so two things-api invocations can
 * append to the same monthly file concurrently. The append path is therefore:
 *
 *   open(path, O_APPEND) → ONE writeSync(fd, completeLineBuffer) → fsyncSync → close
 *
 * Two properties make this safe for our use in practice, on regular files:
 *  - ATOMIC APPEND. With O_APPEND the kernel positions the write at end-of-file
 *    and performs the append under the inode lock, so a SINGLE write() call
 *    cannot interleave with a concurrent write() from another fd — no torn or
 *    spliced line. We hand writeSync the COMPLETE `${line}\n` buffer so exactly
 *    one write() syscall carries the whole record. (The old appendFileSync path
 *    gave neither a single-write guarantee nor a flush.)
 *  - DURABILITY. fsyncSync flushes the record to disk before we return, so a
 *    crash immediately after the append cannot lose an already-acknowledged
 *    record — the pairing invariant the M3 intent record relies on holds.
 *
 * No lockfile is used, deliberately: for regular local files a single
 * O_APPEND write() is already interleave-safe, our records are small and writes
 * infrequent, and a lockfile would add a failure mode (stale locks, contention)
 * into a path that must NEVER throw into the mutation result. A short write from
 * write() only occurs on signals/full disks/pipes — not local regular-file
 * appends of records this size — so the "one writeSync = one record" assumption
 * holds; the >1MB round-trip test exercises the large-buffer case.
 *
 * NEVER THROWS INTO THE MUTATION PATH. If the durable path fails for any reason
 * (fsync unsupported on an exotic FS, transient open error, …) we fall back to a
 * best-effort plain append, and if THAT throws we swallow it: a mutation's
 * result must never break because auditing hit an I/O error.
 */
import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";

import type { AuditRecord } from "./schema.ts";

export interface AuditWriter {
  append(record: AuditRecord): void;
}

/** Durable single-write append (O_APPEND + fsync), best-effort fallback on failure. */
function durableAppend(path: string, buf: Buffer): void {
  try {
    const fd = openSync(path, "a"); // "a" → O_APPEND
    try {
      writeSync(fd, buf); // one write() with the complete line — atomic append
      fsyncSync(fd); // flush to disk before returning
    } finally {
      closeSync(fd);
    }
  } catch {
    // Best-effort fallback: try a plain append, then give up silently. An audit
    // write must never throw into the mutation path that called it.
    try {
      appendFileSync(path, buf);
    } catch {
      /* swallow — a mutation result must never break because auditing failed */
    }
  }
}

export function createAuditWriter(options: {
  dir: string;
  /** Secrets to structurally redact from every string field. */
  secrets: string[];
  enabled: boolean;
}): AuditWriter {
  const secrets = options.secrets.filter((s) => s.length > 0);
  return {
    append(record: AuditRecord): void {
      if (!options.enabled) return;
      mkdirSync(options.dir, { recursive: true });
      const month = record.ts.slice(0, 7); // YYYY-MM
      const line = JSON.stringify(record, (_key, value) => {
        if (typeof value === "string") {
          let out = value;
          for (const secret of secrets) {
            while (out.includes(secret)) out = out.replace(secret, "REDACTED");
          }
          return out;
        }
        return value;
      });
      durableAppend(join(options.dir, `${month}.jsonl`), Buffer.from(`${line}\n`, "utf8"));
    },
  };
}
