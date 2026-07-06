/**
 * `things doctor` — thin CLI surface over the library's diagnose().
 * Exit codes: 0 healthy; 5 drift/unknown-version; 7 environment problems.
 */
import type { Command } from "commander";

import { diagnose, type DiagnoseReport, type DiagnoseResult } from "../../diagnose.ts";
import { errorEnvelope, okEnvelope, type EnvelopeMeta } from "../../contracts.ts";

// Back-compat aliases for pre-seam consumers of the CLI module.
export type DoctorReport = DiagnoseReport;
export const runDoctor: (dbPath?: string) => DiagnoseResult = diagnose;

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
      const { report, error, exitCode, meta } = diagnose(opts.db);
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
          `experimental: ${report.experimental.reason}`,
        ];
        process.stdout.write(`${lines.join("\n")}\n`);
      } else if (error) {
        process.stderr.write(`doctor: ${error.message}\n`);
        if (error.remediation) process.stderr.write(`  remediation: ${error.remediation}\n`);
      }
      process.exitCode = exitCode;
    });
}
