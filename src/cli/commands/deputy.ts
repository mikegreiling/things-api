/**
 * `things deputy` — lifecycle for the optional things-deputy helper process.
 *
 * The deputy is a small launchd-managed helper that performs Things database
 * reads and app automation on the CLI's behalf. Running it means macOS
 * permission prompts and grants attach to the helper — one stable identity —
 * instead of every terminal or agent runtime that invokes `things`, so grants
 * stop re-prompting when those runtimes update. Routing is opt-in
 * (`things config set deputy-enabled true`, THINGS_API_DEPUTY, or the global
 * `--deputy` flag) and the CLI always falls back to direct execution when the
 * helper is unavailable.
 */
import type { Command } from "commander";

import {
  type DeputyStatus,
  deputyStatus,
  ExitCode,
  installDeputy,
  loadConfig,
  okEnvelope,
  restartDeputy,
  uninstallDeputy,
  type EnvelopeMeta,
} from "../../index.ts";

function envelopeMeta(started: number): EnvelopeMeta {
  return { dbVersion: null, fingerprint: "unknown", elapsedMs: Date.now() - started };
}

function renderStatus(status: DeputyStatus): string {
  const lines = [`deputy: ${status.running ? "running" : "does not appear to be running"}`];
  // The plain no-socket case needs no elaboration; a socket that exists but
  // misbehaves (not answering, handshake refused) is worth its own line.
  if (!status.running && !status.detail.startsWith("not running")) {
    lines.push(`  detail: ${status.detail}`);
  }
  lines.push(
    `  routing: ${status.enabled ? "enabled" : "disabled (things config set deputy-enabled true)"}`,
    `  launchd: ${status.plistInstalled ? (status.loaded ? "installed + loaded" : "installed, NOT loaded") : "not installed (things deputy install)"}`,
    `  binary: ${status.binaryInstalled ? "installed" : "not installed"}`,
    `  socket: ${status.socketPath}`,
  );
  if (status.hello !== null) {
    lines.push(
      `  version: ${status.hello.deputyVersion} (protocol ${status.hello.protocol}, pid ${status.hello.pid})`,
      `  database: ${status.hello.dbPath ?? "not found"}`,
    );
  }
  if (status.signing !== null) {
    lines.push(
      `  signing: ${status.signing.state}${status.signing.authority !== null ? ` (${status.signing.authority})` : ""}`,
    );
    if (status.signing.state !== "signed") {
      lines.push(
        "  warning: an unsigned/ad-hoc helper loses its macOS grants on every rebuild — run scripts/deputy-cert-setup.sh once, rebuild, reinstall",
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

export function registerDeputy(program: Command): void {
  const deputy = program
    .command("deputy")
    .description(
      "Manage the optional helper process that performs database reads and app automation " +
        "on the CLI's behalf, so macOS permission grants attach to one stable helper instead " +
        "of every terminal or agent runtime that runs `things`. Subcommands: status, install, " +
        "restart, uninstall.",
    );

  deputy
    .command("status")
    .description(
      "Report the helper's state: running or not, launchd installation, code-signing " +
        "identity, and whether routing is enabled on this machine. Read-only.",
    )
    .option("--json", "emit versioned JSON envelope on stdout")
    .action((opts: { json?: boolean }) => {
      const started = Date.now();
      const status = deputyStatus(loadConfig().deputyEnabled);
      if (opts.json === true) {
        process.stdout.write(
          `${JSON.stringify(okEnvelope("deputy-status", status, envelopeMeta(started)))}\n`,
        );
      } else {
        process.stdout.write(renderStatus(status));
      }
      process.exitCode = ExitCode.Ok;
    });

  deputy
    .command("install")
    .description(
      "Install the helper: copy the built binary to its stable location, register it with " +
        "launchd (starts now and on every login), and report signing state. Does NOT enable " +
        "routing — set deputy-enabled true when ready. Rerun after every rebuild.",
    )
    .option(
      "--binary <path>",
      "path to a built things-deputy binary (default: deputy/build/things-deputy in this package)",
    )
    .action((opts: { binary?: string }) => {
      try {
        const result = installDeputy(opts.binary !== undefined ? { binaryPath: opts.binary } : {});
        process.stdout.write(
          `installed ${result.binaryPath}\nlaunchd agent: ${result.plistPath}\n`,
        );
        for (const warning of result.warnings) {
          process.stderr.write(`warning: ${warning}\n`);
        }
        process.exitCode = ExitCode.Ok;
      } catch (err) {
        process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = ExitCode.Environment;
      }
    });

  deputy
    .command("restart")
    .description("Restart the launchd-managed helper (picks up a rebuilt installed binary).")
    .action(() => {
      try {
        restartDeputy();
        process.stdout.write("deputy restarted\n");
        process.exitCode = ExitCode.Ok;
      } catch (err) {
        process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = ExitCode.Environment;
      }
    });

  deputy
    .command("uninstall")
    .description(
      "Stop the helper and remove its launchd registration and installed binary. Local state " +
        "(access token, logs) is kept; routing config is untouched (commands fall back to " +
        "direct execution).",
    )
    .action(() => {
      const result = uninstallDeputy();
      process.stdout.write(
        result.removed.length > 0
          ? `removed:\n${result.removed.map((p) => `  ${p}`).join("\n")}\n`
          : "nothing installed\n",
      );
      process.exitCode = ExitCode.Ok;
    });
}
