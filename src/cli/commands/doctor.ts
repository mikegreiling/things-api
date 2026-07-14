/**
 * `things doctor` — thin CLI surface over the library's diagnose().
 * Exit codes: 0 healthy; 5 drift/unknown-version; 7 environment problems.
 */
import type { Command } from "commander";

import { diagnose, type DiagnoseReport, type DiagnoseResult } from "../../diagnose.ts";
import { describeEnvironmentChanges } from "../../write/environment.ts";
import { errorEnvelope, okEnvelope, type EnvelopeMeta } from "../../contracts.ts";

// Back-compat aliases for pre-seam consumers of the CLI module.
export type DoctorReport = DiagnoseReport;
export const runDoctor: (dbPath?: string) => DiagnoseResult = diagnose;

function environmentLine(env: DiagnoseReport["environment"]): string {
  if (env.lastVerifiedWrite === null) {
    return "no verified write recorded yet (the tuple is recorded on the first successful write)";
  }
  if (env.changes.length === 0) return "unchanged since the last verified write";
  return (
    `CHANGED since the last verified write — ${describeEnvironmentChanges(env.changes)} ` +
    "(a macOS consent prompt may reappear on the next automation call)"
  );
}

/** The `── Sync health ──` section: freshness proxies + the cloud last-attempt signal. */
function syncHealthLines(sh: DiagnoseReport["syncHealth"]): string[] {
  return [
    "── Sync health ──",
    `app:         ${sh.appRunning.verdict}`,
    `wal:         ${sh.wal.verdict}`,
    `last edit:   ${sh.lastLocalEdit.verdict}`,
    `foreground:  ${sh.lastForeground.verdict}`,
    `cloud:       ${sh.cloud.verdict}`,
  ];
}

export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description(
      "Check environment health: database location, database schema compatibility, app " +
        "presence, any one-time setup still needed (macOS permissions, the app's " +
        "'Enable Things URLs' setting), whether the environment changed since the last " +
        "successful write, and a sync-health summary (whether the app is running, how recently " +
        "the data changed, and — when a Things Cloud account is attached — the last sync " +
        "attempt) — with steps to fix. " +
        "Exit 0 healthy; 5 schema drift (writes disabled); 7 environment problem.",
    )
    .option("--json", "emit versioned JSON envelope on stdout")
    .option("--db <path>", "explicit database path (overrides THINGS_DB and discovery)")
    .option(
      "--probe-automation",
      "actively test whether automation of Things is authorized (may show a one-time macOS " +
        "consent prompt; skipped when Things is not running)",
    )
    .action((opts: { json?: boolean; db?: string; probeAutomation?: boolean }) => {
      const started = Date.now();
      const { report, error, exitCode, meta } = diagnose(opts.db, {
        ...(opts.probeAutomation === true && { probeAutomation: true }),
      });
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
          `environment: ${environmentLine(report.environment)}`,
          `automation:  ${report.automation.status}${
            report.automation.status === "granted" ? "" : ` — ${report.automation.detail}`
          }`,
          `url scheme:  ${
            report.availability.urlScheme.enabled === true
              ? "enabled"
              : report.availability.urlScheme.enabled === false
                ? "DISABLED"
                : "unknown"
          } — ${report.availability.urlScheme.detail}`,
          `shortcuts:   ${report.availability.shortcuts.present.length}/${
            report.availability.shortcuts.present.length +
            report.availability.shortcuts.missing.length
          } proxies installed — ${report.availability.shortcuts.detail}`,
          `repeats:     ${report.recurrence.templates} template(s), ${
            report.recurrence.undecodable
          } undecodable${report.recurrence.undecodable > 0 ? ` — ${report.recurrence.detail}` : ""}`,
          ...syncHealthLines(report.syncHealth),
        ];
        process.stdout.write(`${lines.join("\n")}\n`);
      } else if (error) {
        process.stderr.write(`doctor: ${error.message}\n`);
        if (error.remediation) process.stderr.write(`  remediation: ${error.remediation}\n`);
      }
      process.exitCode = exitCode;
    });
}
