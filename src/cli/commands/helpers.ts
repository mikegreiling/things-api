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
  type HelpersOnboardResult,
  type HelpersStatus,
  helpersStatus,
  ExitCode,
  installHelpers,
  loadConfig,
  okEnvelope,
  onboardHelpers,
  type OnboardStep,
  resetHelpers,
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
    // Absent on helpers older than 1.2.0 — the rows are simply omitted there
    // rather than guessed at.
    if (deputy.hello.automation !== undefined) {
      lines.push(
        `  automation: Things ${deputy.hello.automation.things}, System Events ${deputy.hello.automation.systemEvents}`,
      );
    }
    if (deputy.hello.axTrusted !== undefined) {
      lines.push(`  accessibility: ${deputy.hello.axTrusted ? "granted" : "not granted"}`);
    }
    if (
      deputy.hello.axTrusted === false ||
      deputy.hello.automation?.things === "denied" ||
      deputy.hello.automation?.systemEvents === "denied"
    ) {
      lines.push("  next: `things helpers grant` — one sitting settles every outstanding prompt");
    }
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

/** The closing report: one row per permission, then the single next-step line. */
function renderOnboard(result: HelpersOnboardResult): string {
  const width = Math.max(...result.steps.map((step: OnboardStep) => step.label.length));
  const rows = result.steps.map(
    (step: OnboardStep) =>
      `  ${step.label.padEnd(width)}  ${step.state}${step.state === "granted" ? "" : ` — ${step.detail}`}`,
  );
  return `\n${rows.join("\n")}\n\n${result.closing}\n`;
}

export function registerHelpers(program: Command): void {
  const helpers = program
    .command("helpers")
    .description(
      "Manage the optional helper pair that performs database reads and app automation " +
        "on the CLI's behalf, so macOS permission grants attach to stable helpers instead " +
        "of every terminal or agent runtime that runs `things`. Subcommands: status, " +
        "install, grant, restart, uninstall, reset.",
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
                ? "reader: installed, no read access yet\n"
                : "reader: installed, not answering yet — check `things helpers status`\n",
          );
        }
        process.stdout.write(
          "next: `things helpers grant` — one sitting settles every macOS permission the helpers need\n",
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

  helpers
    .command("grant")
    .description(
      "One sitting that settles every macOS permission the helpers need: a folder panel " +
        "for durable read access to the Things data folder, the two app-control prompts " +
        "(Things and System Events), the Accessibility switch, and a check that the " +
        "bundled shortcuts are installed. Already-granted steps are detected and skipped, " +
        "so rerunning is safe and prompts nothing. Interactive: run this at the machine, " +
        "not from an unattended session.",
    )
    .option("--json", "emit versioned JSON envelope on stdout")
    .action((opts: { json?: boolean }) => {
      const started = Date.now();
      // Under --json stdout belongs to the envelope alone; the human still
      // needs the instructions, so progress goes to stderr instead.
      const progress = (line: string): void => {
        (opts.json === true ? process.stderr : process.stdout).write(`${line}\n`);
      };
      let result: HelpersOnboardResult;
      try {
        result = onboardHelpers(loadConfig().helpersMode, process.env, { progress });
      } catch (err) {
        process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = ExitCode.Environment;
        return;
      }
      if (opts.json === true) {
        process.stdout.write(
          `${JSON.stringify(okEnvelope("helpers-onboard", result, envelopeMeta(started)))}\n`,
        );
      } else {
        process.stdout.write(renderOnboard(result));
      }
      // A human-pace `pending` is not a failure — the ceremony resumes on the
      // next run. Only a refusal earns a nonzero exit.
      process.exitCode = result.denied ? ExitCode.Environment : ExitCode.Ok;
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

  helpers
    .command("reset")
    .description(
      "Return this machine to the never-onboarded state: uninstall the helpers, revoke " +
        "their macOS permission grants (Automation, Accessibility, and every other class " +
        "keyed to the helper identities), and delete their local state including the " +
        "reader's read grant. The next `things helpers install` + `grant` replays " +
        "onboarding from zero. Idempotent: runs from any partial state — an " +
        "already-uninstalled helper still gets its grants revoked — and a rerun is a " +
        "no-op. The bundled things-proxy-* shortcuts cannot be removed by any tool and " +
        "are reported as a manual step.",
    )
    .option("--yes", "skip the interactive confirmation (required when stdin is not a terminal)")
    .option("--json", "emit versioned JSON envelope on stdout")
    .action(async (opts: { yes?: boolean; json?: boolean }) => {
      const started = Date.now();
      if (opts.yes !== true) {
        if (opts.json === true || !process.stdin.isTTY) {
          process.stderr.write(
            "helpers reset revokes macOS permission grants and deletes helper state — pass --yes to confirm\n",
          );
          process.exitCode = ExitCode.Usage;
          return;
        }
        const readline = await import("node:readline/promises");
        const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
        const answer = await rl.question(
          "This uninstalls the helpers, revokes their macOS permission grants, and deletes " +
            "their local state (including the reader's read grant). Type 'reset' to continue: ",
        );
        rl.close();
        if (answer.trim() !== "reset") {
          process.stderr.write("not confirmed — nothing was changed\n");
          process.exitCode = ExitCode.Usage;
          return;
        }
      }
      const result = resetHelpers();
      if (opts.json === true) {
        process.stdout.write(
          `${JSON.stringify(okEnvelope("helpers-reset", result, envelopeMeta(started)))}\n`,
        );
      } else {
        const lines: string[] = [];
        lines.push(
          result.removed.length > 0
            ? `removed:\n${result.removed.map((p) => `  ${p}`).join("\n")}`
            : "nothing was installed — grants and state legs still ran",
        );
        for (const t of result.tccResets) {
          lines.push(`permissions: ${t.target} — ${t.ok ? "revoked" : t.detail}`);
        }
        for (const w of result.warnings) lines.push(`warning: ${w}`);
        lines.push(`note: ${result.shortcutsNote}`);
        process.stdout.write(`${lines.join("\n")}\n`);
      }
      process.exitCode = result.warnings.length > 0 ? ExitCode.Environment : ExitCode.Ok;
    });
}
