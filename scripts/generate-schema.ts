#!/usr/bin/env node
/**
 * Generate the machine-readable envelope JSON Schema from the TypeScript
 * contract types, then format it — the canonical `generate → format` pipeline.
 *
 * Source of truth: the `WireEnvelope` union in `src/contracts.ts` (the ok
 * envelope | the error envelope). The schema is committed at
 * `schema/envelope.schema.json` and kept in three-way sync with the types and
 * the runtime by two tests (`test/contract/envelope-schema.test.ts`):
 *   1. types ↔ schema — re-runs THIS generation in-process and deep-equals the
 *      committed file (drift → "run npm run schema:gen").
 *   2. schema ↔ runtime — validates real emitted CLI envelopes against the file.
 *
 * Run via `npm run schema:gen`. This script must be deterministic: same types,
 * byte-identical schema (formatting is applied by oxfmt as the final step so the
 * committed file is fmt-stable and `fmt:check` never fights the generator).
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createGenerator, type Config, type Schema } from "ts-json-schema-generator";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outPath = resolve(repoRoot, "schema/envelope.schema.json");

/** The canonical generator config — shared verbatim by the sync test. */
export const generatorConfig: Config = {
  path: resolve(repoRoot, "src/contracts.ts"),
  tsconfig: resolve(repoRoot, "tsconfig.json"),
  type: "WireEnvelope",
  schemaId: "https://github.com/mikegreiling/things-api/schema/envelope.schema.json",
  // Interfaces are closed to unmodeled keys so schema drift is caught; the
  // command-specific `data` payload stays OPEN via its own index signature
  // (Record<string, unknown>), so this does not over-constrain real envelopes.
  additionalProperties: false,
  topRef: true,
  sortProps: true,
  encodeRefs: true,
};

/** Build the schema object (also used by the in-process sync test). */
export function generateEnvelopeSchema(): Schema {
  const schema = createGenerator(generatorConfig).createSchema(generatorConfig.type);
  // A human-facing title + description tying the schema back to the contract.
  schema.title = "things-api envelope";
  schema.description =
    "JSON Schema for the things-api --json response envelope (the discriminated " +
    "union of a success envelope and an error envelope), generated from the " +
    "WireEnvelope type in src/contracts.ts. See docs/contract.md (The " +
    "machine-readable schema). The envelope layer is modeled exactly; the " +
    "command-specific `data` payload is an open object (coverage boundary).";
  return schema;
}

function main(): void {
  const schema = generateEnvelopeSchema();
  writeFileSync(outPath, `${JSON.stringify(schema, null, 2)}\n`);
  // Final step: oxfmt owns the on-disk formatting so the committed schema is
  // fmt-stable (fmt:check is part of `npm run check`).
  execFileSync("npx", ["oxfmt", outPath], { cwd: repoRoot, stdio: "inherit" });
  process.stdout.write(`wrote ${outPath}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
