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
 *
 * ## Why a ceremony runs with the DEFAULT signal disposition
 *
 * MEASURED 2026-08-24 (macOS 24.6, node under a pty): a ceremony's gates and
 * bounded waits are SYNCHRONOUS — a blocking `read(2)` on /dev/tty, or
 * `Atomics.wait` between polls — so they hold the event loop for their whole
 * duration. The CLI installs `process.once("SIGINT", …)` at startup
 * (../cli/interrupt.ts), and a registered JS listener replaces the kernel's
 * default disposition with a libuv watcher that can only run a handler ON the
 * event loop. With the loop held, the signal is queued and never dispatched,
 * libuv restarts the EINTR'd read, and — because the line discipline keeps
 * ISIG on, so ^C is consumed as a signal and never arrives as a byte — Ctrl-C
 * is swallowed COMPLETELY: no handler, no exit, no input. Reproduced both at a
 * gate and inside a poll; without the listener the same ^C kills node at once.
 *
 * The fix is {@link withDefaultInterrupts}: for the span of the ceremony the JS
 * listeners are lifted, so the kernel terminates the process on ^C exactly as
 * the copy promises, at the conventional 130. Deliberately NOT fixed by putting
 * the terminal in raw mode to read ^C as `\x03`: raw mode is what would disable
 * ISIG and *cause* this class of bug, and it leaves a terminal to restore on
 * every exit path — including the ones a signal never lets us reach. The gate
 * stays in canonical mode, so there is no terminal state to restore, and a
 * `\x03`/`\x04` that does arrive as data (a harness feeding the gate, or
 * Ctrl-D) is treated as a stop.
 */
import { closeSync, openSync, readSync } from "node:fs";

/** The controlling terminal, so a piped stdout/stdin cannot swallow the gate. */
const TTY_DEVICE = "/dev/tty";

/** Signals whose default disposition a ceremony restores while it blocks. */
const CEREMONY_SIGNALS = ["SIGINT", "SIGTERM"] as const;

/**
 * The human stopped the ceremony — Ctrl-D at a gate, a `\x03`/`\x04` arriving
 * as data, or a closed terminal. Every leg is resumable, so this is a clean
 * stop and not a failure: the CLI prints the stopped line and exits nonzero.
 */
export class CeremonyStopped extends Error {
  constructor(why = "stopped at the keyboard") {
    super(`the setup ceremony was ${why}`);
    this.name = "CeremonyStopped";
  }
}

/**
 * Run a ceremony's synchronous span with the process's DEFAULT SIGINT/SIGTERM
 * disposition, so Ctrl-C really does stop it (see the module note above).
 *
 * The lifted listeners are restored on the way out. A `once` listener comes
 * back as a plain one — the CLI's handler exits the process, so it cannot fire
 * twice, and a ceremony that returns normally never reaches it at all.
 */
export function withDefaultInterrupts<T>(run: () => T): T {
  const lifted = CEREMONY_SIGNALS.map((signal) => {
    const listeners = process.listeners(signal) as NodeJS.SignalsListener[];
    for (const listener of listeners) process.removeListener(signal, listener);
    return { signal, listeners };
  });
  try {
    return run();
  } finally {
    for (const { signal, listeners } of lifted) {
      for (const listener of listeners) process.on(signal, listener);
    }
  }
}

export interface WizardDeps {
  /**
   * Is a human sitting here? Default: stdin AND stderr are both terminals —
   * stdin because the gate has to be answerable, stderr because the explainers
   * have to be visible even when stdout is a pipe carrying `--json`.
   */
  interactive?: boolean;
  /** Where explainers and questions are printed. Default: stderr. */
  say?: (line: string) => void;
  /**
   * Read one line from the human. Default: one line off /dev/tty. `null` means
   * end of input — Ctrl-D, or a terminal that went away — and stops the
   * ceremony rather than reading as a bare Enter.
   */
  readLine?: () => string | null;
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
  /**
   * Offer a leg's alternatives: `lines` describes them, Enter takes the first
   * one, and typing any of `keys` takes that one. Returns the chosen key, or
   * `""` for Enter — which is also strict mode's silent answer, so the default
   * has to be the choice an absent human would want.
   */
  choose(lines: string[], keys: string[]): string;
}

function readLineDefault(): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(TTY_DEVICE, "r");
    const buffer = Buffer.alloc(256);
    const read = readSync(fd, buffer, 0, buffer.length, null);
    // A zero-byte read is EOF, not an empty answer.
    return read === 0 ? null : buffer.toString("utf8", 0, read).trim();
  } catch {
    // No controlling terminal after all (a ceremony started under a harness
    // that reported isTTY and then detached). Nobody can answer, so stop.
    return null;
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
  /**
   * One gate: block for the human, with the default signal disposition in
   * force so Ctrl-C stops the ceremony. Throws {@link CeremonyStopped} on end
   * of input, or on a `\x03`/`\x04` that reached us as data.
   */
  const gate = (): string => {
    const answer = withDefaultInterrupts(readLine);
    if (answer === null) throw new CeremonyStopped("stopped — no more input");
    if (answer.includes("\u0003") || answer.includes("\u0004")) throw new CeremonyStopped();
    return answer.trim();
  };
  return {
    interactive,
    explain(lines: string[]): void {
      if (!interactive) return;
      say("");
      for (const line of lines) say(line);
      say("  press Enter when you are ready — Ctrl-C stops here, and rerunning resumes here");
      gate();
    },
    ask(question: string, fallback: boolean): boolean {
      if (!interactive) return fallback;
      say("");
      say(`${question} [${fallback ? "Y/n" : "y/N"}]`);
      const answer = gate().toLowerCase();
      if (answer === "") return fallback;
      return answer.startsWith("y");
    },
    choose(lines: string[], keys: string[]): string {
      if (!interactive) return "";
      say("");
      for (const line of lines) say(line);
      say(
        `  press Enter, or type ${keys.join(" / ")} then Enter — Ctrl-C stops here, and rerunning resumes here`,
      );
      const answer = gate().toLowerCase();
      return keys.find((key) => answer.startsWith(key)) ?? "";
    },
  };
}
