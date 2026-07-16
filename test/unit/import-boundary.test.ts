/**
 * The air-gap boundary enforcement (docs/design/architecture.md, Consumer
 * boundary). The CLI and MCP server are pure CONSUMERS of the library: every
 * relative import that leaves a surface's own directory tree MUST resolve to
 * exactly src/index.ts — the one public entry point. This statically scans the
 * two surfaces and fails, naming file:line and the offending specifier, the
 * moment any file reaches past the barrel into a library internal.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");
const INDEX = join(SRC, "index.ts");
const SURFACES = [join(SRC, "cli"), join(SRC, "mcp")];

/** Every .ts file under a directory tree (recursive). */
function tsFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** The relative import/export specifiers in a file, with 1-based line numbers. */
function relativeSpecifiers(file: string): { line: number; spec: string }[] {
  const found: { line: number; spec: string }[] = [];
  // `from "..."` covers both `import … from` and `export … from`; the second
  // pattern catches dynamic `import("...")`. Only relative specifiers matter.
  const patterns = [/\bfrom\s+["'](\.[^"']+)["']/g, /\bimport\s*\(\s*["'](\.[^"']+)["']/g];
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((text, i) => {
      for (const re of patterns) {
        for (const m of text.matchAll(re)) {
          if (m[1] !== undefined) found.push({ line: i + 1, spec: m[1] });
        }
      }
    });
  return found;
}

describe("consumer boundary (air gap): CLI + MCP import only through src/index.ts", () => {
  for (const surface of SURFACES) {
    for (const file of tsFiles(surface)) {
      const rel = file.slice(SRC.length + 1);
      it(`${rel} reaches library internals only via src/index.ts`, () => {
        const violations: string[] = [];
        for (const { line, spec } of relativeSpecifiers(file)) {
          const target = resolve(dirname(file), spec);
          // Intra-surface imports (a sibling file within the same surface tree)
          // are allowed; anything that leaves the tree must be src/index.ts.
          const insideSurface = target === surface || target.startsWith(surface + sep);
          if (insideSurface) continue;
          if (target === INDEX) continue;
          violations.push(
            `${rel}:${line} imports "${spec}" (resolves to ${target.slice(SRC.length + 1)})`,
          );
        }
        expect(violations, violations.join("\n")).toEqual([]);
      });
    }
  }
});
