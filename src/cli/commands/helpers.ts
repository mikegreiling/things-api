/**
 * `things helpers` — lifecycle for the optional helper pair (one installed
 * bundle housing both):
 *
 *   things-deputy — app automation (mutations), unsandboxed.
 *   things-reader — database/file reads, sandboxed to a user-granted folder.
 *
 * Running them means macOS permission prompts and grants attach to two stable
 * identities instead of every terminal or agent runtime that invokes
 * `things`, so grants stop re-prompting when those runtimes update. Routing is
 * tri-state (`helpers-enabled`: auto | true | false, default auto —
 * installation is the intent signal), overridable per invocation with
 * THINGS_API_HELPERS or the global `--helpers`/`--no-helpers` flags; the CLI
 * always falls back to direct execution when a helper is unavailable.
 */
import type { Command } from "commander";

import {
  type HelpersStatus,
  helpersStatus,
  ExitCode,
  grantReader,
  installHelpers,
  loadConfig,
  okEnvelope,
  restartHelpers,
  uninstallHelpers,
  type EnvelopeMeta,
} from "../../index.ts";

function envelopeMeta(started: number): EnvelopeMeta {
  return { dbVersion: null, fingerprint: "unknown", elapsedMs: Date.now() - started };
}

/** One line describing what the configured mode means for this machine. */
function routingLine(status: HelpersStatus): string {
  switch (status.mode) {
    case "true":
      return "enabled — every process routes through the helpers, and reports when it cannot";
    case "false":
      return "disabled (things config set helpers-enabled auto)";
    case "auto":
      return status.bundleInstalled
        ? "auto — the installed helpers are used while healthy; a failure is reported, never silent"
        : "auto — nothing installed, so everything runs direct (things helpers install to change that)";
  }
}

function renderStatus(status: HelpersStatus): string {
  const deputy = status.deputy;
  const lines = [`deputy: ${deputy.running ? "running" : "does not appear to be running"}`];
  // The plain no-socket case needs no elaboration; a socket that exists but
  // misbehaves (not answering, handshake refused) is worth its own line.
  if (!deputy.running && !deputy.detail.startsWith("not running")) {
    lines.push(`  detail: ${deputy.detail}`);
  }
  if (deputy.hungSocket) {
    lines.push("  next: `things helpers restart` — the socket is present but no handshake answers");
  }
  lines.push(
    `  routing: ${routingLine(status)}`,
    `  launchd: ${deputy.plistInstalled ? (deputy.loaded ? "installed + loaded" : "installed, NOT loaded") : "not installed (things helpers install)"}`,
    `  bundle: ${
      status.bundleInstalled
        ? `installed${status.installedVersion !== null ? ` (v${status.installedVersion})` : ""}`
        : "not installed"
    }`,
    `  socket: ${deputy.socketPath}`,
  );
  if (deputy.hello !== null) {
    lines.push(
      `  version: ${deputy.hello.deputyVersion} (protocol ${deputy.hello.protocol}, pid ${deputy.hello.pid})`,
    );
  }
  if (deputy.signing !== null) {
    lines.push(
      `  signing: ${deputy.signing.state}${deputy.signing.authority !== null ? ` (${deputy.signing.authority})` : ""}`,
    );
    if (deputy.signing.state !== "signed") {
      lines.push(
        "  warning: an unsigned/ad-hoc helper loses its macOS grants on every rebuild — run scripts/deputy-cert-setup.sh once, rebuild, reinstall",
      );
    }
  }
  const reader = status.reader;
  lines.push(
    `reader: ${reader.running ? (reader.granted ? "running, granted" : "running, NOT granted") : reader.installed ? reader.detail : "not installed"}`,
  );
  if (reader.running && !reader.granted) {
    lines.push(
      "  next: run `things helpers grant` and accept the panel (one time; the grant survives restarts, reboots, and rebuilds)",
    );
  }
  if (reader.hungSocket) {
    lines.push("  next: `things helpers restart` — the socket is present but no handshake answers");
  }
  return `${lines.join("\n")}\n`;
}

export function registerHelpers(program: Command): void {
  const helpers = program
    .command("helpers")
    .description(
      "Manage the optional helper pair that performs database reads and app automation " +
        "on the CLI's behalf, so macOS permission grants attach to stable helpers instead " +
        "of every terminal or agent runtime that runs `things`. Subcommands: status, " +
        "install, grant, restart, uninstall.",
    );

  helpers
    .command("status")
    .description(
      "Report both helpers' state: running or not, launchd installation, installed version, " +
        "code-signing identity, the reader's grant, and the routing mode on this machine. " +
        "Read-only.",
    )
    .option("--json", "emit versioned JSON envelope on stdout")
    .action((opts: { json?: boolean }) => {
      const started = Date.now();
      const status = helpersStatus(loadConfig().helpersMode);
      if (opts.json === true) {
        process.stdout.write(
          `${JSON.stringify(okEnvelope("helpers-status", status, envelopeMeta(started)))}\n`,
        );
      } else {
        process.stdout.write(renderStatus(status));
      }
      process.exitCode = ExitCode.Ok;
    });

  helpers
    .command("install")
    .description(
      "Install the helper bundle: copy it to its stable location, register both helpers " +
        "with launchd (starts now and on every login), and report signing + grant state. " +
        "Under the default helpers-enabled auto, an installed and healthy helper is used from " +
        "the next command on. Rerun after every rebuild.",
    )
    .option(
      "--bundle <path>",
      "path to a built Things API Helper.app (default: deputy/build/Things API Helper.app in this package)",
    )
    .action((opts: { bundle?: string }) => {
      try {
        const result = installHelpers(opts.bundle !== undefined ? { bundlePath: opts.bundle } : {});
        process.stdout.write(
          `installed ${result.bundlePath}\nlaunchd agent: ${result.plistPath}\n`,
        );
        if (result.readerInstalled) {
          process.stdout.write(
            result.readerGranted === true
              ? "reader: granted — file reads ride the scoped reader\n"
              : result.readerGranted === false
                ? "reader: installed — run `things helpers grant` once to give it durable read access\n"
                : "reader: installed, not answering yet — check `things helpers status`\n",
          );
        }
        for (const warning of result.warnings) {
          process.stderr.write(`warning: ${warning}\n`);
        }
        process.exitCode = ExitCode.Ok;
      } catch (err) {
        process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = ExitCode.Environment;
      }
    });

  helpers
    .command("grant")
    .description(
      "One-time ceremony: opens a folder panel presented by the sandboxed reader helper, " +
        "already showing the Things data folder. Accepting gives the reader durable read " +
        "access to exactly that folder — it survives restarts, reboots, and updates, and " +
        "macOS enforces that the reader can reach nothing else. Interactive: run this at " +
        "the machine, not from an unattended session.",
    )
    .action(() => {
      const result = grantReader();
      if (result.granted) {
        process.stdout.write("granted — file reads now ride the scoped reader\n");
        process.exitCode = ExitCode.Ok;
      } else {
        process.stderr.write(`not granted: ${result.detail}\n`);
        process.exitCode = ExitCode.Environment;
      }
    });

  helpers
    .command("restart")
    .description("Restart the launchd-managed helpers (picks up a rebuilt installed bundle).")
    .action(() => {
      try {
        restartHelpers();
        process.stdout.write("helpers restarted\n");
        process.exitCode = ExitCode.Ok;
      } catch (err) {
        process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = ExitCode.Environment;
      }
    });

  helpers
    .command("uninstall")
    .description(
      "Stop both helpers and remove their launchd registrations and the installed bundle. " +
        "Local state (access token, logs, the reader's grant) is kept; routing config is " +
        "untouched (commands fall back to direct execution).",
    )
    .action(() => {
      const result = uninstallHelpers();
      process.stdout.write(
        result.removed.length > 0
          ? `removed:\n${result.removed.map((p) => `  ${p}`).join("\n")}\n`
          : "nothing installed\n",
      );
      process.exitCode = ExitCode.Ok;
    });
}
