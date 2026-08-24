/**
 * The ceremony wizard — Article V's mode-aware half
 * (docs/design/permissions-doctrine.md).
 *
 * Both setup ceremonies (`things setup` and `things helpers setup`) share this
 * machinery, because a human sitting at either one needs the same two things:
 * to be told what is about to appear on screen BEFORE it appears, and to be
 * allowed to get there at their own pace.
 *
 * At a TTY the ceremony is a WIZARD: each prompt-raising leg is preceded by one
 * plain-language explainer naming the dialog by its actual words and the button
 * to click, and then the ceremony waits for Enter. Off a TTY it is STRICT mode,
 * exactly as before: the upfront banner counts the dialogs, waits are bounded,
 * and an unanswered leg fails the run. The tier question is asked interactively
 * when nothing else decided it, and answered by the flag when it did.
 *
 * TTY-ness is the ONLY signal used, and it selects wizard-vs-strict *inside* a
 * ceremony only — never behavior anywhere else. There is deliberately no
 * env-based agent sniffing anywhere in the package (Article V): Article I makes
 * it unnecessary, because no ordinary command can raise a dialog for an agent
 * to hang on in the first place.
 */
import { closeSync, openSync, readSync } from "node:fs";

/** The controlling terminal, so a piped stdout/stdin cannot swallow the gate. */
const TTY_DEVICE = "/dev/tty";

export interface WizardDeps {
  /**
   * Is a human sitting here? Default: stdin AND stderr are both terminals —
   * stdin because the gate has to be answerable, stderr because the explainers
   * have to be visible even when stdout is a pipe carrying `--json`.
   */
  interactive?: boolean;
  /** Where explainers and questions are printed. Default: stderr. */
  say?: (line: string) => void;
  /** Read one line from the human. Default: one line off /dev/tty. */
  readLine?: () => string;
}

export interface Wizard {
  /** True when this run is a guided sitting rather than strict mode. */
  readonly interactive: boolean;
  /**
   * Explain a dialog that is about to be raised, then wait for the human to say
   * they are ready. A no-op in strict mode — there the upfront banner has
   * already counted the dialogs and nobody is here to pace them.
   */
  explain(lines: string[]): void;
  /**
   * Ask a yes/no question. `fallback` is the answer in strict mode (and the
   * answer a bare Enter gives), so a non-interactive run is never blocked on
   * one; the flag that decides it non-interactively is the caller's business.
   */
  ask(question: string, fallback: boolean): boolean;
}

function readLineDefault(): string {
  let fd: number | undefined;
  try {
    fd = openSync(TTY_DEVICE, "r");
    const buffer = Buffer.alloc(256);
    const read = readSync(fd, buffer, 0, buffer.length, null);
    return buffer.toString("utf8", 0, read).trim();
  } catch {
    // No controlling terminal after all (a ceremony started under a harness
    // that reported isTTY and then detached). Treat it as "no answer" rather
    // than hanging or throwing mid-ceremony.
    return "";
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Nothing here can change the answer we already have.
      }
    }
  }
}

function interactiveDefault(): boolean {
  return process.stdin.isTTY === true && process.stderr.isTTY === true;
}

/** Build the wizard for one ceremony run. Fully injectable for tests. */
export function createWizard(deps: WizardDeps = {}): Wizard {
  const interactive = deps.interactive ?? interactiveDefault();
  const say = deps.say ?? ((line: string) => process.stderr.write(`${line}\n`));
  const readLine = deps.readLine ?? readLineDefault;
  return {
    interactive,
    explain(lines: string[]): void {
      if (!interactive) return;
      say("");
      for (const line of lines) say(line);
      say("  press Enter when you are ready (Ctrl-C to stop — rerunning resumes here)");
      readLine();
    },
    ask(question: string, fallback: boolean): boolean {
      if (!interactive) return fallback;
      say("");
      say(`${question} [${fallback ? "Y/n" : "y/N"}]`);
      const answer = readLine().toLowerCase();
      if (answer === "") return fallback;
      return answer.startsWith("y");
    },
  };
}
