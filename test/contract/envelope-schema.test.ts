/**
 * Three-way sync enforcement for the machine-readable envelope schema
 * (`schema/envelope.schema.json`, PR B of the contract canon). Two guards:
 *
 *   1. types ↔ schema — regenerate the schema in-process from `src/contracts.ts`
 *      (the SAME `generateEnvelopeSchema()` the `npm run schema:gen` CLI uses)
 *      and deep-equal it against the committed file. A drift here means the
 *      types moved but the committed schema was not regenerated → the message
 *      says to run `npm run schema:gen`.
 *
 *   2. schema ↔ runtime — compile the committed schema with ajv and validate a
 *      REPRESENTATIVE set of REAL emitted CLI envelopes against it (a flat list,
 *      today, anytime, an area card, a project card, a detail, a mutation ok,
 *      and an error envelope). Every failure surfaces the ajv error path.
 *
 * Together these close the loop: the types generate the schema, the schema
 * validates what the code actually emits. Reads run against a synthetic fixture
 * DB; the one mutation runs through the write SIMULATOR (`THINGS_SIM_WRITES=1`),
 * so no real app is ever touched.
 */
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import _Ajv from "ajv";
import type { ErrorObject, Options, ValidateFunction } from "ajv";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildProgram } from "../../src/cli/main.ts";
import { generateEnvelopeSchema } from "../../scripts/generate-schema.ts";

// ajv ships a CJS default export; under nodenext + verbatimModuleSyntax the
// bare default import is typed as the module namespace (not constructable), so
// pin it to a minimal constructor type for the one thing we use (`compile`).
type AjvCtor = new (opts?: Options) => { compile: (schema: unknown) => ValidateFunction };
const Ajv = _Ajv as unknown as AjvCtor;
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedArea, seedProject, seedTodo } from "../fixtures/seed.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const schemaPath = resolve(repoRoot, "schema/envelope.schema.json");

describe("envelope schema — types ↔ schema sync", () => {
  it("the committed schema matches a fresh in-process generation (else run npm run schema:gen)", () => {
    const committed = JSON.parse(readFileSync(schemaPath, "utf8"));
    const fresh = generateEnvelopeSchema();
    // Deep-equal on PARSED JSON — formatting (oxfmt) is not load-bearing here.
    expect(fresh, "schema/envelope.schema.json is stale — run `npm run schema:gen`").toEqual(
      committed,
    );
  });
});

/** Render ajv errors as `instancePath keyword: message` lines (the error PATH). */
function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map((e) => `  at ${e.instancePath || "<root>"} (${e.keyword}): ${e.message}`)
    .join("\n");
}

describe("envelope schema — schema ↔ runtime sync", () => {
  let fixture: FixtureDb;
  let stateDir: string;
  let stdout: string[];
  let validate: ValidateFunction;
  const envBackup: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    "THINGS_DB",
    "THINGS_SIM_WRITES",
    "THINGS_API_STATE_DIR",
    "THINGS_API_CONFIG_DIR",
  ];

  beforeEach(() => {
    // strict:false — the generated schema legitimately carries `description`
    // siblings next to `$ref` (draft-07 ignores them); allErrors so a failure
    // reports every offending path, not just the first.
    const ajv = new Ajv({ strict: false, allErrors: true });
    validate = ajv.compile(JSON.parse(readFileSync(schemaPath, "utf8")));

    // benchMarker satisfies the write-simulator fence (THINGS_SIM_WRITES).
    fixture = buildFixtureDb({ benchMarker: true });
    stateDir = mkdtempSync(join(tmpdir(), "things-api-schema-"));
    for (const key of ENV_KEYS) envBackup[key] = process.env[key];
    process.env["THINGS_DB"] = fixture.path;
    process.env["THINGS_SIM_WRITES"] = "1";
    process.env["THINGS_API_STATE_DIR"] = stateDir;
    process.env["THINGS_API_CONFIG_DIR"] = join(stateDir, "config");
    stdout = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fixture.close();
    rmSync(stateDir, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  /** Run the CLI in-process and return the parsed last-line envelope. */
  async function envelopeFor(argv: string[]): Promise<Record<string, unknown>> {
    stdout = [];
    const program = buildProgram();
    program.exitOverride();
    await program.parseAsync(["node", "things", ...argv]);
    const line = stdout.join("").trim().split("\n").at(-1) ?? "";
    return JSON.parse(line) as Record<string, unknown>;
  }

  /** Validate one envelope, failing with the ajv error PATH(s) on mismatch. */
  function expectValid(label: string, envelope: Record<string, unknown>): void {
    const ok = validate(envelope);
    if (!ok) {
      throw new Error(
        `${label} envelope (kind=${String(envelope["kind"])}) failed schema validation:\n${formatAjvErrors(
          validate.errors,
        )}`,
      );
    }
    expect(ok).toBe(true);
  }

  it("validates a representative set of real emitted envelopes", async () => {
    // Seed a synthetic library that exercises every read shape.
    const area = seedArea(fixture.db, "Workshop");
    const project = seedProject(fixture.db, { title: "Rewire the lab", area });
    seedTodo(fixture.db, { title: "inbox item", start: "inbox" });
    seedTodo(fixture.db, { title: "today item", startDate: "2020-01-01", todayIndex: 1 });
    seedTodo(fixture.db, { title: "anytime item", start: "active" });
    const detailUuid = seedTodo(fixture.db, { title: "detail item", project });

    // kind → the CLI invocation that emits it (R1/R2 wrappers + a mutation).
    const cases: [string, string[]][] = [
      ["flat-list (inbox)", ["inbox", "--json"]],
      ["today", ["today", "--json"]],
      ["anytime", ["anytime", "--json"]],
      ["area-view", ["area", "show", area, "--json"]],
      ["project-view", ["project", "show", project, "--json"]],
      ["detail", ["todo", "show", detailUuid, "--json"]],
      // mutation ok — runs through the write simulator.
      ["mutation-result", ["todo", "add", "a fresh task", "--json"]],
    ];

    const kinds = new Set<string>();
    for (const [label, argv] of cases) {
      const env = await envelopeFor(argv);
      expect(env["ok"], `${label} should be ok`).toBe(true);
      expectValid(label, env);
      kinds.add(String(env["kind"]));
    }

    // Error envelope — an unresolved `todo show` target yields {ok:false, error}.
    const err = await envelopeFor(["todo", "show", "no-such-uuid-42", "--json"]);
    expect(err["ok"]).toBe(false);
    expect(err["kind"]).toBe("error");
    expectValid("error", err);
    kinds.add("error");

    // Guard: we really did cover the R1/R2 wrappers + mutation + error.
    expect(kinds).toEqual(
      new Set([
        "inbox",
        "today",
        "anytime",
        "area-view",
        "project-view",
        "detail",
        "mutation-result",
        "error",
      ]),
    );
  });
});
