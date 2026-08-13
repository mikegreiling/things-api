/**
 * Universal `--preserve-modified` (src/cli/commands/writes.ts `addWriteFlags`):
 * the timeline-silent-mutation flag is available on virtually every mutating
 * command — the single-mutation write family, moves, and reorders. These lock
 * two invariants, mirroring the universal `--dry-run` completeness lock:
 *   (a) a COMPLETENESS lock walks the whole registered tree — every WRITE-family
 *       leaf (one declaring the `--vector` delivery flag, i.e. everything built
 *       through `addWriteFlags`) also declares `--preserve-modified`, so a future
 *       write command cannot silently regress the invariant;
 *   (b) NON-write leaves (reads, config, mcp, capabilities) and the composing
 *       meta-commands (`batch`, `undo`) do NOT declare it, and no namespace/root
 *       declares it either.
 * The behavior (capture → restore) is locked in test/engine/write-preserve-modified.test.ts.
 */
import { describe, expect, it } from "vitest";

import type { Command } from "commander";

import { buildProgram } from "../../src/cli/main.ts";

/** Every (path, command) pair in the tree. */
function everyCommand(root: Command): Array<[string[], Command]> {
  const out: Array<[string[], Command]> = [];
  const walk = (cmd: Command, path: string[]): void => {
    out.push([path, cmd]);
    for (const sub of cmd.commands) walk(sub, [...path, sub.name()]);
  };
  walk(root, []);
  return out;
}

const declares = (cmd: Command, long: string): boolean => cmd.options.some((o) => o.long === long);

describe("completeness lock: --preserve-modified reaches every write-family command", () => {
  it("every write-family leaf (declares --vector) also declares --preserve-modified", () => {
    const program = buildProgram();
    let writeLeaves = 0;
    for (const [path, cmd] of everyCommand(program)) {
      if (cmd.commands.length !== 0) continue; // leaves only
      if (!declares(cmd, "--vector")) continue; // write family only
      writeLeaves += 1;
      const label = `things ${path.join(" ")}`.trim();
      expect(
        declares(cmd, "--preserve-modified"),
        `write leaf \`${label}\` must accept --preserve-modified`,
      ).toBe(true);
    }
    // Sanity: the write family is non-trivial (guards against the walk finding nothing).
    expect(writeLeaves).toBeGreaterThan(20);
  });

  it("no non-write leaf or namespace declares --preserve-modified", () => {
    const program = buildProgram();
    for (const [path, cmd] of everyCommand(program)) {
      const isWriteLeaf = cmd.commands.length === 0 && declares(cmd, "--vector");
      if (isWriteLeaf) continue;
      const label = `things ${path.join(" ")}`.trim() || "things";
      expect(
        declares(cmd, "--preserve-modified"),
        `\`${label}\` must NOT declare --preserve-modified`,
      ).toBe(false);
    }
  });

  it("the meta-commands batch and undo do not carry --preserve-modified (per-op only)", () => {
    const program = buildProgram();
    for (const name of ["batch", "undo"]) {
      const cmd = program.commands.find((c) => c.name() === name);
      expect(cmd, `\`things ${name}\` should exist`).toBeDefined();
      expect(declares(cmd as Command, "--preserve-modified")).toBe(false);
    }
  });
});
