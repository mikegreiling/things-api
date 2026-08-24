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
  type HelpersInstallResult,
  type HelpersOnboardResult,
  type HelpersStatus,
  type HelpersUninstallResult,
  helpersStatus,
  ExitCode,
  installHelpers,
  loadConfig,
  okEnvelope,
  onboardHelpers,
  type OnboardStep,
  restartHelpers,
  uninstallHelpers,
  type EnvelopeMeta,
} from "../../index.ts";

function envelopeMeta(started: number): EnvelopeMeta {
  return { dbVersion: null, fingerprint: "unknown", elapsedMs: Date.now() - started };
}

/**
 * The grants `auto` routing requires before either half carries traffic — the
 * same gate src/deputy/routing.ts applies, phrased for a human. Accessibility
 * and System Events are deliberately absent: the UI vector is gated separately.
 */
function missingRequisites(status: HelpersStatus): string[] {
  const missing: string[] = [];
  const hello = status.deputy.hello;
  if (hello === null) {
    missing.push("the deputy is not answering");
  } else if (hello.automation === undefined) {
    missing.push("automation → Things (these helpers predate the permission handshake — rebuild)");
  } else if (hello.automation.things !== "granted") {
    missing.push(`automation → Things (${hello.automation.things})`);
  }
  if (status.reader.installed && !status.reader.granted) missing.push("the reader's read grant");
  return missing;
}

/** One line describing what the configured mode means for this machine. */
function routingLine(status: HelpersStatus): string {
  switch (status.mode) {
    case "true":
      return "enabled — every process routes through the helpers, and reports when it cannot";
    case "false":
      return "disabled (things config set helpers-enabled auto)";
    case "auto": {
      if (!status.bundleInstalled) {
        return "auto — nothing installed, so everything runs direct (things helpers setup to change that)";
      }
      const missing = missingRequisites(status);
      return missing.length > 0
        ? `auto — dormant: onboarding incomplete (missing: ${missing.join("; ")}) — things helpers setup`
        : "auto — routing (onboarded): the installed helpers are used while healthy; a failure is reported, never silent";
    }
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
    `  launchd: ${deputy.plistInstalled ? (deputy.loaded ? "installed + loaded" : "installed, NOT loaded") : "not installed (things helpers setup)"}`,
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
      lines.push("  next: `things helpers setup` — one sitting settles every outstanding prompt");
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
      "  next: run `things helpers setup` and accept the panel (one time; the grant survives restarts, reboots, and rebuilds)",
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

/** What the uninstall removed, plus the revocation legs when they ran. */
function renderUninstall(result: HelpersUninstallResult): string {
  const lines: string[] = [];
  const revocation = result.revocation;
  lines.push(
    result.removed.length > 0
      ? `removed:\n${result.removed.map((p) => `  ${p}`).join("\n")}`
      : revocation !== null
        ? "nothing was installed — the grant and state legs still ran"
        : "nothing installed",
  );
  if (revocation !== null) {
    if (revocation.registeredBundle !== null) {
      lines.push(
        `registered ${revocation.registeredBundle} with LaunchServices so the grants could be addressed (it stays registered — the file is really there)`,
      );
    }
    for (const reset of revocation.tccResets) {
      lines.push(`permissions: ${reset.target} — ${reset.detail}`);
    }
    lines.push(`note: ${revocation.shortcutsNote}`);
  }
  for (const warning of result.warnings) lines.push(`warning: ${warning}`);
  return `${lines.join("\n")}\n`;
}

export function registerHelpers(program: Command): void {
  const helpers = program
    .command("helpers")
    .description(
      "Manage the optional helper pair that performs database reads and app automation " +
        "on the CLI's behalf, so macOS permission grants attach to stable helpers instead " +
        "of every terminal or agent runtime that runs `things`. Subcommands: status, " +
        "restart, setup, uninstall.",
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
    .command("setup")
    .description(
      "Install (or update) the helper bundle and settle every macOS permission it needs, " +
        "in one sitting: the bundle is copied to its stable location and registered with " +
        "launchd, then a folder panel grants durable read access to the Things data folder, " +
        "the two app-control prompts (Things and System Events) are raised, the " +
        "Accessibility switch is offered, and the bundled shortcuts are counted. Steps " +
        "already satisfied are detected and skipped, so rerunning is safe and asks nothing. " +
        "Interactive: run this at the machine, not from an unattended session. Exits " +
        "nonzero while any permission is still outstanding.",
    )
    .option(
      "--bundle <path>",
      "path to a built Things API Helper.app (default: the bundle shipped with this package)",
    )
    .option("--json", "emit versioned JSON envelope on stdout")
    .action((opts: { bundle?: string; json?: boolean }) => {
      const started = Date.now();
      // Under --json stdout belongs to the envelope alone; the human still
      // needs the instructions, so progress goes to stderr instead.
      const progress = (line: string): void => {
        (opts.json === true ? process.stderr : process.stdout).write(`${line}\n`);
      };
      let install: HelpersInstallResult;
      try {
        install = installHelpers(opts.bundle !== undefined ? { bundlePath: opts.bundle } : {});
      } catch (err) {
        process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = ExitCode.Environment;
        return;
      }
      progress(`installed ${install.bundlePath}`);
      progress(`launchd agent: ${install.plistPath}`);
      for (const warning of install.warnings) {
        process.stderr.write(`warning: ${warning}\n`);
      }
      let ceremony: HelpersOnboardResult;
      try {
        ceremony = onboardHelpers(loadConfig().helpersMode, process.env, { progress });
      } catch (err) {
        process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = ExitCode.Environment;
        return;
      }
      if (opts.json === true) {
        process.stdout.write(
          `${JSON.stringify(okEnvelope("helpers-setup", { install, ceremony }, envelopeMeta(started)))}\n`,
        );
      } else {
        process.stdout.write(renderOnboard(ceremony));
      }
      // A setup that ends with anything outstanding is an UNFINISHED setup —
      // nonzero, so an agent driving this for an absent human sees it. Pending
      // is still human-pace and resumable; the closing line says where to pick
      // it up.
      process.exitCode = ceremony.denied || ceremony.pending ? ExitCode.Environment : ExitCode.Ok;
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
        "Local state (access token, logs, the reader's grant) is kept and the macOS " +
        "permission grants stay on record against the two helper identities, so a later " +
        "setup picks them straight back up; routing config is untouched (commands fall " +
        "back to direct execution). Pass --revoke to also revoke those grants and delete " +
        "the local state, returning the machine to its never-onboarded condition.",
    )
    .option(
      "--revoke",
      "also revoke both helper identities' macOS permission grants and delete their local state, including the reader's read grant",
    )
    .option(
      "--yes",
      "skip the interactive confirmation for --revoke (required when stdin is not a terminal)",
    )
    .option("--json", "emit versioned JSON envelope on stdout")
    .action(async (opts: { revoke?: boolean; yes?: boolean; json?: boolean }) => {
      const started = Date.now();
      const revoke = opts.revoke === true;
      // Only revocation is gated: a plain uninstall is reversible in one
      // command, while revoking throws away grants a human had to sit through.
      if (revoke && opts.yes !== true) {
        if (opts.json === true || !process.stdin.isTTY) {
          process.stderr.write(
            "helpers uninstall --revoke revokes macOS permission grants and deletes helper state — pass --yes to confirm\n",
          );
          process.exitCode = ExitCode.Usage;
          return;
        }
        const readline = await import("node:readline/promises");
        const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
        const answer = await rl.question(
          "This uninstalls the helpers, revokes their macOS permission grants, and deletes " +
            "their local state (including the reader's read grant). Type 'revoke' to continue: ",
        );
        rl.close();
        if (answer.trim() !== "revoke") {
          process.stderr.write("not confirmed — nothing was changed\n");
          process.exitCode = ExitCode.Usage;
          return;
        }
      }
      const result = uninstallHelpers(revoke ? { revoke: true } : {});
      if (opts.json === true) {
        process.stdout.write(
          `${JSON.stringify(okEnvelope("helpers-uninstall", result, envelopeMeta(started)))}\n`,
        );
      } else {
        process.stdout.write(renderUninstall(result));
      }
      process.exitCode = result.warnings.length > 0 ? ExitCode.Environment : ExitCode.Ok;
    });
}
