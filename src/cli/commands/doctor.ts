/**
 * `things doctor` — environment/database/fingerprint health report.
 * Exit codes: 0 healthy; 5 drift/unknown-version; 7 environment problems.
 */
import { existsSync } from "node:fs";
import type { Command } from "commander";

import { BASELINES } from "../../db/baselines/index.ts";
import { openConnection, ThingsDbOpenError } from "../../db/connection.ts";
import { locateThingsDb, ThingsDbNotFoundError } from "../../db/locate.ts";
import { compareToBaseline, observeSchema } from "../../db/fingerprint.ts";
import { ExitCode } from "../exit-codes.ts";
import { errorEnvelope, okEnvelope, type EnvelopeMeta } from "../output.ts";

const THINGS_APP = "/Applications/Things3.app";

export interface DoctorReport {
  db: {
    path: string;
    source: "option" | "env" | "container";
    otherCandidates: string[];
    databaseVersion: number | null;
  };
  fingerprint: {
    status: "ok" | "drift" | "unknown-version";
    value: string;
    expected: string | null;
    detail: string[];
    extraColumns: Record<string, string[]>;
  };
  app: {
    installed: boolean;
  };
  writes: {
    enabled: boolean;
    reason: string;
  };
}

export function runDoctor(dbPath?: string): {
  report: DoctorReport | null;
  error: { code: string; message: string; remediation?: string } | null;
  exitCode: ExitCode;
  meta: Pick<EnvelopeMeta, "dbVersion" | "fingerprint">;
} {
  let located: ReturnType<typeof locateThingsDb>;
  try {
    located = locateThingsDb(dbPath ? { dbPath } : undefined);
  } catch (err) {
    if (err instanceof ThingsDbNotFoundError) {
      return {
        report: null,
        error: {
          code: "environment",
          message: err.message,
          remediation: "Install Things 3 and launch it once, or set THINGS_DB.",
        },
        exitCode: ExitCode.Environment,
        meta: { dbVersion: null, fingerprint: "unknown" },
      };
    }
    throw err;
  }

  let conn: ReturnType<typeof openConnection>;
  try {
    conn = openConnection(located.path);
  } catch (err) {
    if (err instanceof ThingsDbOpenError) {
      return {
        report: null,
        error: {
          code: "environment",
          message: err.message,
          remediation: "Launch Things once so the WAL sidecars exist, then retry.",
        },
        exitCode: ExitCode.Environment,
        meta: { dbVersion: null, fingerprint: "unknown" },
      };
    }
    throw err;
  }

  try {
    const observation = observeSchema(conn.db);
    const status = compareToBaseline(observation, BASELINES);
    const fingerprintStatus =
      status.kind === "ok" ? "ok" : status.kind === "drift" ? "drift" : "unknown-version";
    const writesEnabled = status.kind === "ok";
    const extraColumns: Record<string, string[]> = {};
    for (const t of observation.tables) {
      if (t.extraColumns.length > 0) extraColumns[t.table] = t.extraColumns;
    }
    const report: DoctorReport = {
      db: {
        path: located.path,
        source: located.source,
        otherCandidates: located.otherCandidates,
        databaseVersion: observation.databaseVersion,
      },
      fingerprint: {
        status: fingerprintStatus,
        value: observation.fingerprint,
        expected: status.kind === "drift" ? status.expected : null,
        detail: status.kind === "drift" ? status.detail : [],
        extraColumns,
      },
      app: { installed: existsSync(THINGS_APP) },
      writes: {
        enabled: writesEnabled,
        reason: writesEnabled
          ? "schema fingerprint matches shipped baseline"
          : status.kind === "drift"
            ? "schema fingerprint deviates from baseline — writes disabled until revalidated"
            : "unknown databaseVersion — update things-api or revalidate",
      },
    };
    return {
      report,
      error: null,
      exitCode: writesEnabled ? ExitCode.Ok : ExitCode.DriftBlocked,
      meta: {
        dbVersion: observation.databaseVersion,
        fingerprint: fingerprintStatus === "unknown-version" ? "unknown" : fingerprintStatus,
      },
    };
  } finally {
    conn.close();
  }
}

export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description(
      "Check environment health: database location, schema fingerprint vs baseline, app presence. " +
        "Exit 0 healthy; 5 schema drift (writes disabled); 7 environment problem.",
    )
    .option("--json", "emit versioned JSON envelope on stdout")
    .option("--db <path>", "explicit database path (overrides THINGS_DB and discovery)")
    .action((opts: { json?: boolean; db?: string }) => {
      const started = Date.now();
      const { report, error, exitCode, meta } = runDoctor(opts.db);
      const fullMeta: EnvelopeMeta = { ...meta, elapsedMs: Date.now() - started };
      if (opts.json) {
        const envelope = report
          ? okEnvelope("doctor", report, fullMeta)
          : errorEnvelope(error ?? { code: "unexpected", message: "no report" }, fullMeta);
        process.stdout.write(`${JSON.stringify(envelope)}\n`);
      } else if (report) {
        const lines = [
          `db:          ${report.db.path} (${report.db.source})`,
          `db version:  ${report.db.databaseVersion ?? "unknown"}`,
          `fingerprint: ${report.fingerprint.status} (${report.fingerprint.value.slice(0, 23)}…)`,
          ...report.fingerprint.detail.map((d) => `  drift: ${d}`),
          `app:         ${report.app.installed ? "installed" : "NOT INSTALLED"}`,
          `writes:      ${report.writes.enabled ? "enabled" : "DISABLED"} — ${report.writes.reason}`,
        ];
        process.stdout.write(`${lines.join("\n")}\n`);
      } else if (error) {
        process.stderr.write(`doctor: ${error.message}\n`);
        if (error.remediation) process.stderr.write(`  remediation: ${error.remediation}\n`);
      }
      process.exitCode = exitCode;
    });
}
