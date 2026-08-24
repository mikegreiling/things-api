/**
 * The ceremony wizard (docs/design/permissions-doctrine.md, Article V).
 *
 * Two behaviors carry the whole article: at a TTY the human is told what is
 * coming and gets to pace it; off a TTY nothing is printed and nothing blocks,
 * so an unattended run behaves exactly as strict mode always did. The tier
 * question's non-interactive answer is the caller's fallback, never a hang.
 */
import { describe, expect, it } from "vitest";

import { createWizard } from "../../src/wizard.ts";

function recorder(answers: string[] = []) {
  const said: string[] = [];
  let reads = 0;
  return {
    said,
    get reads() {
      return reads;
    },
    say: (line: string) => said.push(line),
    readLine: () => {
      const answer = answers[reads] ?? "";
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
