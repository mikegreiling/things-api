/**
 * `things setup` — the direct-path onboarding ceremony (the library's
 * ./direct-setup.ts; docs/design/permissions-doctrine.md, Article V).
 *
 * One of the two commands allowed to raise a macOS consent dialog. It settles
 * read access, app control, and the bundled shortcuts for the CURRENT host app
 * in one sitting; `things helpers setup` is the other path, where the grants
 * attach to a signed helper instead.
 */
import type { Command } from "commander";

import {
  directSetup,
  ExitCode,
  okEnvelope,
  surveySetup,
  type DirectSetupResult,
  type EnvelopeMeta,
  type SetupStep,
} from "../../index.ts";

function meta(started: number): EnvelopeMeta {
  return { dbVersion: null, fingerprint: "unknown", elapsedMs: Date.now() - started };
}

/** The closing report: one row per grant, then the single next-step line. */
function renderSetup(result: DirectSetupResult): string {
  const width = Math.max(...result.steps.map((step: SetupStep) => step.label.length));
  const rows = result.steps.map(
    (step: SetupStep) =>
      `  ${step.label.padEnd(width)}  ${step.state}${step.state === "granted" ? "" : ` — ${step.detail}`}`,
  );
  return `\n${rows.join("\n")}\n\n${result.closing}\n`;
}

export function registerSetup(program: Command): void {
  program
    .command("setup")
    .description(
      "Settle everything this Mac needs to reach Things from the terminal, in one sitting: " +
        "read access to the Things data folder, permission to control the Things app, and " +
        "the bundled shortcuts that carry the operations no other route can perform. Steps " +
        "already satisfied are detected and skipped, so rerunning is safe and asks nothing. " +
        "Interactive: run this at the machine, not from an unattended session — it puts " +
        "macOS dialogs on screen and counts them upfront. Grants attach to the terminal or " +
        "harness you run it from; `things helpers setup` attaches them to a helper instead, " +
        "which survives updates to that app. Exits 0 when everything is in place; 7 while " +
        "anything is still outstanding or was refused.",
    )
    .option("--json", "emit versioned JSON envelope on stdout")
    .action((opts: { json?: boolean; dryRun?: boolean }) => {
      const started = Date.now();
      // Universal `--dry-run` (../dry-run.ts): the ceremony's whole purpose is
      // to raise dialogs and change grant state, so the flag reports what it
      // would ask for and asks nothing.
      if (opts.dryRun === true) {
        const survey = surveySetup();
        const lines = [
          `host app:    ${survey.host.name}`,
          `read access: ${survey.read.mode} — ${survey.read.detail}`,
          `app control: ${survey.write.mode} — ${survey.write.detail}`,
          `shortcuts:   ${
            survey.shortcutsMissing.length === 0
              ? "all installed"
              : `missing ${survey.shortcutsMissing.join(", ")}`
          }`,
          "",
          survey.outstanding.length === 0
            ? "dry run: everything is already in place — a real run would ask nothing"
            : `dry run: a real run would ask for ${survey.outstanding.join(", ")} — nothing was asked`,
        ];
        if (opts.json === true) {
          process.stdout.write(
            `${JSON.stringify(okEnvelope("setup", { dryRun: true, ...survey }, meta(started)))}\n`,
          );
        } else {
          process.stdout.write(`${lines.join("\n")}\n`);
        }
        process.exitCode = ExitCode.Ok;
        return;
      }
      // Under --json stdout belongs to the envelope alone; the human still
      // needs the running commentary, so progress goes to stderr instead.
      const progress = (line: string): void => {
        (opts.json === true ? process.stderr : process.stdout).write(`${line}\n`);
      };
      const result = directSetup({ progress });
      if (opts.json === true) {
        process.stdout.write(`${JSON.stringify(okEnvelope("setup", result, meta(started)))}\n`);
      } else {
        process.stdout.write(renderSetup(result));
      }
      // A setup that ends with anything outstanding is an UNFINISHED setup —
      // nonzero, so an agent driving this for an absent human sees it. Pending
      // is still human-pace and resumable; the closing line says where.
      process.exitCode = result.denied || result.pending ? ExitCode.Environment : ExitCode.Ok;
    });
}
