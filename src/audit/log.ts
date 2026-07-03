/**
 * JSONL audit writer: monthly files, never auto-deleted, structural token
 * redaction — the serializer refuses to emit any string containing the
 * loaded auth token.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import type { AuditRecord } from "./schema.ts";

export interface AuditWriter {
  append(record: AuditRecord): void;
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
      appendFileSync(join(options.dir, `${month}.jsonl`), `${line}\n`);
    },
  };
}
