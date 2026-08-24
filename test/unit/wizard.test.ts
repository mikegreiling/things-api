/**
 * The ceremony wizard (docs/design/permissions-doctrine.md, Article V).
 *
 * Two behaviors carry the whole article: at a TTY the human is told what is
 * coming and gets to pace it; off a TTY nothing is printed and nothing blocks,
 * so an unattended run behaves exactly as strict mode always did. The tier
 * question's non-interactive answer is the caller's fallback, never a hang.
 */
import { describe, expect, it } from "vitest";

import { CeremonyStopped, createWizard, withDefaultInterrupts } from "../../src/wizard.ts";

function recorder(answers: (string | null)[] = []) {
  const said: string[] = [];
  let reads = 0;
  return {
    said,
    get reads() {
      return reads;
    },
    say: (line: string) => said.push(line),
    readLine: (): string | null => {
      // `null` is a real answer here — end of input — so it must survive the
      // lookup rather than being defaulted away.
      const answer = reads < answers.length ? (answers[reads] as string | null) : "";
      reads += 1;
      return answer;
    },
  };
}

describe("wizard mode (a TTY)", () => {
  it("prints the explainer and waits for the human before returning", () => {
    const io = recorder();
    const wizard = createWizard({ interactive: true, say: io.say, readLine: io.readLine });
    wizard.explain(["Next: something.", "  Click Allow."]);
    expect(io.said).toContain("Next: something.");
    expect(io.said.join("\n")).toContain("press Enter when you are ready");
    expect(io.reads, "the gate must actually block on a read").toBe(1);
  });

  it("asks the question and reads yes/no, with Enter meaning the default", () => {
    const yes = recorder(["y"]);
    expect(
      createWizard({ interactive: true, say: yes.say, readLine: yes.readLine }).ask(
        "Enable?",
        false,
      ),
    ).toBe(true);
    const bare = recorder([""]);
    expect(
      createWizard({ interactive: true, say: bare.say, readLine: bare.readLine }).ask(
        "Enable?",
        false,
      ),
    ).toBe(false);
    const no = recorder(["n"]);
    expect(
      createWizard({ interactive: true, say: no.say, readLine: no.readLine }).ask("Enable?", true),
    ).toBe(false);
    expect(bare.said.join("\n")).toContain("[y/N]");
  });

  it("offers a keyed choice, with Enter taking the default", () => {
    const enter = recorder([""]);
    expect(
      createWizard({ interactive: true, say: enter.say, readLine: enter.readLine }).choose(
        ["Two ways:"],
        ["f"],
      ),
    ).toBe("");
    const typed = recorder(["F"]);
    expect(
      createWizard({ interactive: true, say: typed.say, readLine: typed.readLine }).choose(
        ["Two ways:"],
        ["f"],
      ),
    ).toBe("f");
    // Anything unrecognized falls to the default, which is the safe answer.
    const junk = recorder(["zzz"]);
    expect(
      createWizard({ interactive: true, say: junk.say, readLine: junk.readLine }).choose(
        ["Two ways:"],
        ["f"],
      ),
    ).toBe("");
    expect(enter.said.join("\n")).toContain("press Enter, or type f then Enter");
  });
});

/**
 * The abort contract. MEASURED 2026-08-24 under a pty: with the CLI's
 * `process.once("SIGINT")` installed, a ^C during the gate's synchronous read
 * is queued for an event loop that the read itself is holding, so it never
 * arrives — Ctrl-C did nothing at all while the copy promised it would stop.
 */
/** A stand-in for the CLI's own SIGINT/SIGTERM handler. */
const listener = (): void => {};

describe("stopping a ceremony", () => {
  it("lifts the JS signal handlers while blocked, and restores them after", () => {
    process.on("SIGINT", listener);
    process.on("SIGTERM", listener);
    try {
      const during = withDefaultInterrupts(() => ({
        sigint: process.listenerCount("SIGINT"),
        sigterm: process.listenerCount("SIGTERM"),
      }));
      // Zero listeners means the KERNEL's default disposition is in force, so
      // ^C terminates the process even with the event loop held.
      expect(during).toEqual({ sigint: 0, sigterm: 0 });
      expect(process.listeners("SIGINT")).toContain(listener);
      expect(process.listeners("SIGTERM")).toContain(listener);
    } finally {
      process.removeListener("SIGINT", listener);
      process.removeListener("SIGTERM", listener);
    }
  });

  it("restores the handlers even when the gate throws", () => {
    process.on("SIGINT", listener);
    try {
      expect(() =>
        withDefaultInterrupts(() => {
          throw new Error("boom");
        }),
      ).toThrow("boom");
      expect(process.listeners("SIGINT")).toContain(listener);
    } finally {
      process.removeListener("SIGINT", listener);
    }
  });

  it("takes end of input as a stop, not as a bare Enter", () => {
    const io = recorder([null]);
    const wizard = createWizard({ interactive: true, say: io.say, readLine: io.readLine });
    expect(() => wizard.explain(["Next: something."])).toThrow(CeremonyStopped);
  });

  it("takes a ^C or ^D that arrives as DATA as a stop", () => {
    for (const byte of ["\u0003", "\u0004"]) {
      const io = recorder([byte]);
      const wizard = createWizard({ interactive: true, say: io.say, readLine: io.readLine });
      expect(() => wizard.choose(["Two ways:"], ["f"])).toThrow(CeremonyStopped);
    }
  });

  it("promises Ctrl-C only in the words that are now true", () => {
    const io = recorder([""]);
    const wizard = createWizard({ interactive: true, say: io.say, readLine: io.readLine });
    wizard.explain(["Next: something."]);
    wizard.choose(["Two ways:"], ["f"]);
    const said = io.said.join("\n");
    expect(said).toContain("Ctrl-C stops here, and rerunning resumes here");
    // The gate never puts the terminal in raw mode, so there is no terminal
    // state a stop could leave behind.
    expect(said).not.toMatch(/raw mode/i);
  });
});

describe("strict mode (no TTY)", () => {
  it("prints nothing and never blocks", () => {
    const io = recorder();
    const wizard = createWizard({ interactive: false, say: io.say, readLine: io.readLine });
    wizard.explain(["Next: something."]);
    expect(io.said).toEqual([]);
    expect(io.reads).toBe(0);
  });

  it("answers a question with the caller's fallback, silently", () => {
    const io = recorder();
    const wizard = createWizard({ interactive: false, say: io.say, readLine: io.readLine });
    expect(wizard.ask("Enable?", false)).toBe(false);
    expect(wizard.ask("Enable?", true)).toBe(true);
    expect(io.said).toEqual([]);
    expect(io.reads).toBe(0);
  });
});
