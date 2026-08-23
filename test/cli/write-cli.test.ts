/**
 * CLI write-command tests: dry-run plans, blocked paths, and capabilities —
 * none of these ever execute a vector, so they run safely anywhere.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildProgram } from "../../src/cli/main.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedArea, seedProject, seedTag, seedTodo } from "../fixtures/seed.ts";

let fixture: FixtureDb;
let stateDir: string;
let stdout: string[];
let stderr: string[];
const envBackup: Record<string, string | undefined> = {};

beforeEach(() => {
  fixture = buildFixtureDb();
  stateDir = mkdtempSync(join(tmpdir(), "things-api-cli-test-"));
  for (const key of ["THINGS_DB", "THINGS_API_STATE_DIR", "THINGS_API_CONFIG_DIR"]) {
    envBackup[key] = process.env[key];
  }
  process.env["THINGS_DB"] = fixture.path;
  process.env["THINGS_API_STATE_DIR"] = stateDir;
  process.env["THINGS_API_CONFIG_DIR"] = join(stateDir, "config");
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
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

async function run(argv: string[]): Promise<void> {
  const program = buildProgram();
  program.exitOverride();
  await program.parseAsync(["node", "things", ...argv]);
}

function envelope(): Record<string, unknown> {
  const line = stdout.join("").trim().split("\n").at(-1) ?? "";
  return JSON.parse(line) as Record<string, unknown>;
}

describe("dry-run plans", () => {
  it("todo add --dry-run emits a mutation-plan envelope with the compiled URL", async () => {
    await run(["todo", "add", "Buy milk", "--when", "today", "--dry-run", "--json"]);
    const env = envelope();
    expect(env["ok"]).toBe(true);
    expect(env["kind"]).toBe("mutation-plan");
    const plan = env["data"] as Record<string, unknown>;
    expect(plan["vector"]).toBe("url-scheme");
    expect(String(plan["invocation"])).toContain("things:///add?title=Buy%20milk&when=today");
    expect(process.exitCode).toBe(0);
  });

  it("todo delete --dry-run plans the applescript vector", async () => {
    const uuid = seedTodo(fixture.db, { title: "victim" });
    await run(["todo", "delete", uuid, "--dry-run", "--json"]);
    const env = envelope();
    expect(env["kind"]).toBe("mutation-plan");
    const plan = env["data"] as Record<string, unknown>;
    expect(plan["vector"]).toBe("applescript");
    expect(String(plan["invocation"])).toContain(`delete to do id "${uuid}"`);
  });

  it("project move --to-area --dry-run plans the membership + area placement (spec §4)", async () => {
    const area = seedArea(fixture.db, "Work");
    const proj = seedProject(fixture.db, { title: "Mover" });
    await run(["project", "move", proj, "--to-area", "Work", "--dry-run", "--json"]);
    const env = envelope();
    expect(env["kind"]).toBe("move-plan");
    const plan = env["data"] as Record<string, unknown>;
    expect(String(plan["membership"])).toContain("membership leg");
    expect(String(plan["placement"])).toContain("area");
    expect(String(plan["placement"])).toContain(area);
  });

  it("project duplicate --dry-run plans the URL duplicate (E17)", async () => {
    const proj = seedProject(fixture.db, { title: "Copyable" });
    await run(["project", "duplicate", proj, "--dry-run", "--json"]);
    const env = envelope();
    expect(env["kind"]).toBe("mutation-plan");
    const plan = env["data"] as Record<string, unknown>;
    expect(plan["vector"]).toBe("url-scheme");
    expect(String(plan["invocation"])).toContain("duplicate=true");
  });

  it("todo clone --dry-run discloses the leg sequence", async () => {
    const uuid = seedTodo(fixture.db, { title: "Cloneable" });
    await run(["todo", "clone", uuid, "--dry-run", "--json"]);
    const env = envelope();
    expect(env["kind"]).toBe("mutation-plan");
    const plan = env["data"] as Record<string, unknown>;
    expect(plan["op"]).toBe("todo.clone");
    expect(String(plan["invocation"])).toContain("todo.add");
    expect(process.exitCode).toBe(0);
  });

  it("todo clone of a repeating template needs the GUI-drive ack (re-promote)", async () => {
    // A template is cloned as a NEW repeating series (clone content → re-promote
    // with the source's rule), which drives the app — so it blocks without the
    // ack. A decodable FIXED weekly rule (tp=0) so it reaches the drive gate.
    const FIXED_WEEKLY_XML =
      `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>` +
      `<key>fa</key><integer>1</integer><key>fu</key><integer>256</integer>` +
      `<key>of</key><array><dict><key>wd</key><integer>0</integer></dict></array>` +
      `<key>rc</key><integer>0</integer><key>rrv</key><integer>4</integer>` +
      `<key>tp</key><integer>0</integer><key>ts</key><integer>0</integer></dict></plist>`;
    const uuid = seedTodo(fixture.db, { title: "Weekly", recurrenceRuleXml: FIXED_WEEKLY_XML });
    await run(["todo", "clone", uuid, "--json"]);
    const env = envelope();
    expect(env["ok"]).toBe(false);
    const err = env["error"] as Record<string, unknown>;
    expect(String(err["code"])).toContain("H-UI-DRIVE");
    expect(String(err["remediation"])).toContain("dangerously-drive-gui");
  });

  it("project clone --dry-run discloses the json-import + terminal legs", async () => {
    const proj = seedProject(fixture.db, { title: "Cloneable project" });
    seedTodo(fixture.db, { title: "child", project: proj });
    await run(["project", "clone", proj, "--dry-run", "--json"]);
    const env = envelope();
    expect(env["kind"]).toBe("mutation-plan");
    const plan = env["data"] as Record<string, unknown>;
    expect(plan["op"]).toBe("project.clone");
    expect(String(plan["invocation"])).toContain("project.add");
  });

  it("todo restore --dry-run plans move-to-Inbox for a trashed to-do (E15)", async () => {
    const uuid = seedTodo(fixture.db, { title: "trashed", trashed: true });
    await run(["todo", "restore", uuid, "--dry-run", "--json"]);
    const env = envelope();
    expect(env["kind"]).toBe("mutation-plan");
    const plan = env["data"] as Record<string, unknown>;
    expect(String(plan["invocation"])).toContain(`move to do id "${uuid}" to list "Inbox"`);
  });

  it("project add-heading --dry-run plans the create-heading proxy on the shortcuts vector", async () => {
    const proj = seedProject(fixture.db, { title: "Dest" });
    await run(["project", "add-heading", "Dest", "Phase 2", "--dry-run", "--json"]);
    const env = envelope();
    expect(env["kind"]).toBe("mutation-plan");
    const plan = env["data"] as Record<string, unknown>;
    expect(plan["vector"]).toBe("shortcuts");
    expect(String(plan["invocation"])).toContain("things-proxy-create-heading");
    expect(String(plan["invocation"])).toContain(proj);
  });

  it("todo clear-reminder --dry-run plans the set-detail proxy (Reminder Time = '')", async () => {
    const uuid = seedTodo(fixture.db, {
      title: "dated",
      startDate: "2026-07-20",
      reminder: "09:30",
    });
    await run(["todo", "clear-reminder", uuid, "--dry-run", "--json"]);
    const env = envelope();
    expect(env["kind"]).toBe("mutation-plan");
    const plan = env["data"] as Record<string, unknown>;
    expect(plan["vector"]).toBe("shortcuts");
    expect(String(plan["invocation"])).toContain("things-proxy-set-detail");
    expect(String(plan["invocation"])).toContain("Reminder Time");
  });

  // §9n write-side: a bare `when=` re-schedule auto-preserves the current
  // reminder — but ONLY if it is still LIVE. A STALE reminder byte (startDate
  // strictly past) is presentation-dead in the GUI, so preserving it would
  // RESURRECT a reminder the user believes gone. Far-past/far-future startDates
  // keep the assertion clock-independent (no THINGS_NOW needed).
  it("project update --when evening does NOT resurrect a STALE reminder (§9n)", async () => {
    const proj = seedProject(fixture.db, {
      title: "stale-reminder-proj",
      startDate: "2020-01-01", // strictly past → reminder is presentation-dead
      evening: true,
      reminder: "18:00",
    });
    await run(["project", "update", proj, "--when", "evening", "--dry-run", "--json"]);
    const plan = envelope()["data"] as Record<string, unknown>;
    const inv = String(plan["invocation"]);
    expect(inv).toContain("when=evening"); // the re-schedule still happens
    expect(inv).not.toContain("%40"); // ...but with NO @HH:MM reminder token
    expect(inv).not.toContain("18");
    // The expected delta agrees: the reminder is asserted null (cleared), not 18:00.
    const delta = plan["expectedDelta"] as { assert?: Array<Record<string, unknown>> };
    const rem = delta.assert?.find((a) => a["field"] === "reminder");
    expect(rem?.["equals"]).toBeNull();
  });

  it("project update --when evening DOES auto-preserve a LIVE reminder", async () => {
    const proj = seedProject(fixture.db, {
      title: "live-reminder-proj",
      startDate: "2999-01-01", // future → the reminder is a live upcoming reminder
      reminder: "18:00",
    });
    await run(["project", "update", proj, "--when", "evening", "--dry-run", "--json"]);
    const plan = envelope()["data"] as Record<string, unknown>;
    const inv = String(plan["invocation"]);
    expect(inv).toContain("when=evening%4018%3A00"); // evening@18:00, preserved
    const delta = plan["expectedDelta"] as { assert?: Array<Record<string, unknown>> };
    const rem = delta.assert?.find((a) => a["field"] === "reminder");
    expect(rem?.["equals"]).toBe("18:00");
  });
});

describe("bulk todo add: variadic / --stdin / --id-only", () => {
  it("variadic add compiles one todo.add leg per title, in order, with the shared flag on each (dry-run)", async () => {
    await run([
      "todo",
      "add",
      "First",
      "Second",
      "Third",
      "--when",
      "today",
      "--dry-run",
      "--json",
    ]);
    const parsed = stdout
      .join("")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    // three per-line dry-run plans + one summary line
    expect(parsed.slice(0, 3).map((r) => r.outcome)).toEqual(["dry-run", "dry-run", "dry-run"]);
    const invs = parsed.slice(0, 3).map((r) => String(r.plan.invocation));
    expect(invs[0]).toContain("title=First");
    expect(invs[1]).toContain("title=Second");
    expect(invs[2]).toContain("title=Third");
    // the shared --when flag is applied to EACH title
    for (const inv of invs) expect(inv).toContain("when=today");
    const summary = parsed[3].summary;
    expect(summary.total).toBe(3);
    // a dry-run mints nothing, so there is no undo token
    expect(summary.undoToken).toBeUndefined();
    expect(process.exitCode).toBe(0);
  });

  it("a single title keeps the single mutation-plan envelope (not a batch stream)", async () => {
    await run(["todo", "add", "Solo", "--dry-run", "--json"]);
    const out = stdout.join("").trim().split("\n");
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0] ?? "{}")["kind"]).toBe("mutation-plan");
  });

  it("--stdin is mutually exclusive with positional titles (usage error, exit 2)", async () => {
    await run(["todo", "add", "X", "--stdin"]);
    expect(process.exitCode).toBe(2);
    expect(stderr.join("")).toContain("--stdin is mutually exclusive");
  });

  it("--id-only and --json are mutually exclusive (usage error, exit 2)", async () => {
    await run(["todo", "add", "X", "--id-only", "--json"]);
    expect(process.exitCode).toBe(2);
    // --json routes the usage error to a JSON envelope on stdout.
    expect(stdout.join("") + stderr.join("")).toContain("mutually exclusive");
  });

  it("no titles fails closed (usage error, exit 2)", async () => {
    await run(["todo", "add"]);
    expect(process.exitCode).toBe(2);
    expect(stderr.join("")).toContain("provide at least one title");
  });

  it("--id-only suppresses all chrome — a single dry-run prints nothing", async () => {
    await run(["todo", "add", "Solo", "--id-only", "--dry-run"]);
    expect(stdout.join("")).toBe("");
    expect(process.exitCode).toBe(0);
  });
});

describe("blocked paths (exit 4, nothing executed)", () => {
  it("trash empty without --dangerously-permanent", async () => {
    await run(["trash", "empty", "--json"]);
    const env = envelope();
    expect(env["ok"]).toBe(false);
    expect((env["error"] as Record<string, unknown>)["code"]).toBe("blocked:H-PERMANENT-DELETE");
    expect(process.exitCode).toBe(4);
  });

  it("todo update on a repeating template", async () => {
    const uuid = seedTodo(fixture.db, { title: "tmpl", recurrenceRule: true });
    await run(["todo", "update", uuid, "--when", "today", "--json"]);
    const env = envelope();
    expect((env["error"] as Record<string, unknown>)["code"]).toBe("blocked:H-REPEAT-SCHEDULE");
    expect(process.exitCode).toBe(4);
  });

  it("todo restore on a non-trashed target", async () => {
    const uuid = seedTodo(fixture.db, { title: "live" });
    await run(["todo", "restore", uuid, "--json"]);
    const env = envelope();
    const error = env["error"] as Record<string, unknown>;
    expect(error["code"]).toBe("blocked:H-UNKNOWN-DESTINATION");
    expect(String(error["message"])).toContain("not in the Trash");
    expect(process.exitCode).toBe(4);
  });

  it("project add-heading into an unknown project is rejected (unresolved ref, usage)", async () => {
    await run(["project", "add-heading", "ghost-project", "New Phase", "--json"]);
    const env = envelope();
    // The project ref is resolved at the consumer boundary (like every other
    // project verb), so an unknown project is a not-found resolution error.
    expect((env["error"] as Record<string, unknown>)["code"]).toBe("not-found");
    expect(process.exitCode).toBe(2);
  });

  it("todo clear-reminder on a to-do with no reminder is rejected", async () => {
    const uuid = seedTodo(fixture.db, { title: "no reminder", startDate: "2026-07-20" });
    await run(["todo", "clear-reminder", uuid, "--json"]);
    const env = envelope();
    expect((env["error"] as Record<string, unknown>)["code"]).toBe("blocked:H-NO-REMINDER");
    expect(process.exitCode).toBe(4);
  });

  it("unknown tag fails fast with remediation", async () => {
    const uuid = seedTodo(fixture.db, { title: "x" });
    seedTag(fixture.db, "real");
    await run(["todo", "tags", uuid, "--set", "real,ghost", "--json"]);
    const env = envelope();
    const error = env["error"] as Record<string, unknown>;
    expect(error["code"]).toBe("blocked:H-UNKNOWN-TAG");
    expect(String(error["remediation"])).toContain("things tag add");
    expect(process.exitCode).toBe(4);
  });
});

describe("project write targets accept names (Part 1)", () => {
  it("resolves a project by unique name (dry-run compiles with the real uuid)", async () => {
    const proj = seedProject(fixture.db, { title: "Firmware" });
    await run(["project", "update", "Firmware", "--title", "Renamed", "--dry-run", "--json"]);
    const env = envelope();
    expect(env["kind"]).toBe("mutation-plan");
    expect(String((env["data"] as Record<string, unknown>)["invocation"])).toContain(proj);
  });

  it("dash/case-forgiving name resolution (mirrors the read side)", async () => {
    const proj = seedProject(fixture.db, { title: "Restore Astro City Cabinet" });
    await run([
      "project",
      "update",
      "restore-astro-city-cabinet",
      "--title",
      "X",
      "--dry-run",
      "--json",
    ]);
    const env = envelope();
    expect(String((env["data"] as Record<string, unknown>)["invocation"])).toContain(proj);
  });

  it("a uuid still resolves unchanged", async () => {
    const proj = seedProject(fixture.db, { title: "ByUuid" });
    await run(["project", "update", proj, "--title", "X", "--dry-run", "--json"]);
    const env = envelope();
    expect(env["kind"]).toBe("mutation-plan");
    expect(String((env["data"] as Record<string, unknown>)["invocation"])).toContain(proj);
  });

  it("an unknown project name is refused, naming the accepted forms", async () => {
    await run(["project", "update", "Ghostproject", "--title", "X", "--json"]);
    const env = envelope();
    expect(env["ok"]).toBe(false);
    expect(String((env["error"] as Record<string, unknown>)["message"])).toContain(
      'no project matching "Ghostproject" — tried uuid, partial-uuid, and name',
    );
  });

  it("a duplicated project name is refused fail-closed, listing candidates with area context", async () => {
    const work = seedArea(fixture.db, "Work");
    const p1 = seedProject(fixture.db, { title: "Dup", area: work });
    const p2 = seedProject(fixture.db, { title: "Dup" });
    await run(["project", "update", "Dup", "--title", "X", "--json"]);
    const env = envelope();
    const message = String((env["error"] as Record<string, unknown>)["message"]);
    expect(message).toContain('"Dup" matches 2 projects');
    expect(message).toContain(p1.slice(0, 8));
    expect(message).toContain(p2.slice(0, 8));
    expect(message).toContain("(in Work)");
  });

  it("an ambiguous name caps candidates at 8 and states the total in the message", async () => {
    for (let i = 0; i < 12; i++) seedProject(fixture.db, { title: "Many" });
    await run(["project", "update", "Many", "--title", "X", "--json"]);
    const env = envelope();
    const err = env["error"] as Record<string, unknown>;
    expect(String(err["message"])).toContain("matches 12 projects"); // total stated
    expect(String(err["message"])).toContain("… 4 more"); // 12 − 8
    expect((err["detail"] as { candidates: unknown[] }).candidates).toHaveLength(8); // capped
  });

  it("live-scoped pool: a trashed same-named project is NOT a resolution candidate", async () => {
    seedProject(fixture.db, { title: "Twin" });
    seedProject(fixture.db, { title: "Twin" });
    const dead = seedProject(fixture.db, { title: "Twin", trashed: true });
    await run(["project", "update", "Twin", "--title", "X", "--json"]);
    const env = envelope();
    const err = env["error"] as Record<string, unknown>;
    expect(err["code"]).toBe("ambiguous");
    const candidates = (err["detail"] as { candidates: { uuid: string }[] }).candidates;
    expect(candidates).toHaveLength(2); // the two LIVE twins only
    expect(candidates.map((c) => c.uuid)).not.toContain(dead); // the trashed row is omitted
  });

  it("zero live matches but a trashed row does → not-found with an honest `things trash` hint (no dead candidate)", async () => {
    seedProject(fixture.db, { title: "Ghosted", trashed: true });
    await run(["project", "update", "Ghosted", "--title", "X", "--json"]);
    const env = envelope();
    const err = env["error"] as Record<string, unknown>;
    expect(err["code"]).toBe("not-found");
    expect(String(err["message"])).toContain(
      "1 trashed item matches this name — see `things trash`",
    );
    expect((err["detail"] as { candidates: unknown[] }).candidates).toEqual([]); // no dangling dead ref
  });

  it("the trash-domain restore op DOES resolve/suggest trashed projects by name", async () => {
    seedProject(fixture.db, { title: "Dead", trashed: true });
    seedProject(fixture.db, { title: "Dead", trashed: true });
    await run(["project", "restore", "Dead", "--json"]);
    const env = envelope();
    const err = env["error"] as Record<string, unknown>;
    expect(err["code"]).toBe("ambiguous"); // restore SEES both trashed twins
    expect((err["detail"] as { candidates: unknown[] }).candidates).toHaveLength(2);
  });

  it("to-do write targets stay uuid-only (Part 2 entity noun)", async () => {
    await run(["todo", "update", "Buymilk", "--title", "X", "--json"]);
    const env = envelope();
    expect(String((env["error"] as Record<string, unknown>)["message"])).toContain(
      'no to-do matching uuid or partial-uuid "Buymilk"',
    );
  });

  it("project rename-heading resolves the heading selector within the project", async () => {
    seedProject(fixture.db, { title: "Proj" });
    await run(["project", "rename-heading", "Proj", "Ghost", "--to", "New Name", "--json"]);
    const env = envelope();
    // The heading selector (title or uuid) resolves inside the named project;
    // an unknown one is a not-found resolution error.
    expect(String((env["error"] as Record<string, unknown>)["message"])).toContain(
      "no heading matching",
    );
    expect(process.exitCode).toBe(2);
  });
});

describe("capabilities", () => {
  it("dumps the lab-validated matrix for one op", async () => {
    await run(["capabilities", "--op", "todo.delete", "--json"]);
    const env = envelope();
    expect(env["kind"]).toBe("capabilities");
    const data = (
      env["data"] as { items: { op: string; vectors: { vector: string; support: string }[] }[] }
    ).items;
    expect(data).toHaveLength(1);
    const entry = data[0];
    expect(entry?.op).toBe("todo.delete");
    expect(entry?.vectors.find((v) => v.vector === "url-scheme")?.support).toBe("no");
    expect(entry?.vectors.find((v) => v.vector === "applescript")?.support).toBe("yes");
  });
});

describe("batch (Phase 13)", () => {
  it("a torn JSON line refuses the WHOLE batch (static preflight), naming it; nothing else runs", async () => {
    const uuid = seedTodo(fixture.db, { title: "batch-target" });
    const batchFile = join(stateDir, "ops.jsonl");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      batchFile,
      [
        JSON.stringify({ op: "todo.update", params: { uuid, title: "renamed" } }),
        "not json at all {",
        JSON.stringify({ op: "trash.empty", params: {} }),
      ].join("\n"),
    );
    await run(["batch", batchFile, "--dry-run"]);
    const lines = stdout
      .join("")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(4); // 3 results + summary
    // The torn line is the invalid one (its JSON error is preserved); the other
    // two are reported not-run — the batch is refused before anything is planned.
    expect(lines[0].outcome).toBe("skipped");
    expect(lines[1].outcome).toBe("invalid");
    expect(lines[1].detail).toMatch(/not valid JSON/);
    expect(lines[2].outcome).toBe("skipped");
    expect(lines[3].summary).toEqual({ total: 3, ok: 0, failed: 1, skipped: 2 });
    expect(process.exitCode).toBe(3); // invalid/verify-failed
  });

  it("a batch of only unsupported ops exits 6 (Unsupported), not 3", async () => {
    // url-scheme cannot delete a to-do (matrix support "no"); forcing that
    // vector makes the op unsupported at planning time — nothing executes.
    const a = seedTodo(fixture.db, { title: "u1" });
    const b = seedTodo(fixture.db, { title: "u2" });
    const batchFile = join(stateDir, "unsupported.jsonl");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      batchFile,
      [
        JSON.stringify({
          op: "todo.delete",
          params: { uuid: a },
          options: { vector: "url-scheme" },
        }),
        JSON.stringify({
          op: "todo.delete",
          params: { uuid: b },
          options: { vector: "url-scheme" },
        }),
      ].join("\n"),
    );
    // --continue-on-error so BOTH unsupported ops are evaluated (the default
    // would stop after the first, reporting the second not-run).
    await run(["batch", batchFile, "--dry-run", "--continue-on-error"]);
    const lines = stdout
      .join("")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines[0].outcome).toBe("unsupported");
    expect(lines[1].outcome).toBe("unsupported");
    expect(lines[2].summary).toEqual({ total: 2, ok: 0, failed: 2, skipped: 0 });
    expect(process.exitCode).toBe(6);
  });

  it("mixed batch: blocked outranks unsupported (exit 4)", async () => {
    const a = seedTodo(fixture.db, { title: "u1" });
    const batchFile = join(stateDir, "mixed-blocked.jsonl");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      batchFile,
      [
        JSON.stringify({
          op: "todo.delete",
          params: { uuid: a },
          options: { vector: "url-scheme" },
        }), // unsupported
        JSON.stringify({ op: "trash.empty", params: {} }), // H-PERMANENT-DELETE -> blocked
      ].join("\n"),
    );
    // --continue-on-error so both runtime failures are evaluated for the exit rank.
    await run(["batch", batchFile, "--dry-run", "--continue-on-error"]);
    const lines = stdout
      .join("")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(new Set([lines[0].outcome, lines[1].outcome])).toEqual(
      new Set(["unsupported", "blocked"]),
    );
    expect(process.exitCode).toBe(4);
  });

  it("mixed batch: unsupported outranks verify-failed/invalid (exit 6)", async () => {
    const a = seedTodo(fixture.db, { title: "u1" });
    const b = seedTodo(fixture.db, { title: "u2" });
    const batchFile = join(stateDir, "mixed-unsupported.jsonl");
    const { writeFileSync } = await import("node:fs");
    // A RUNTIME invalid (exclusive notes/appendNotes throws per-line) — valid
    // JSON, so it passes the static preflight and streams as `invalid`.
    writeFileSync(
      batchFile,
      [
        JSON.stringify({
          op: "todo.delete",
          params: { uuid: a },
          options: { vector: "url-scheme" },
        }), // unsupported
        JSON.stringify({ op: "todo.update", params: { uuid: b, notes: "x", appendNotes: "y" } }), // invalid (exclusive)
      ].join("\n"),
    );
    // --continue-on-error so both failures are evaluated for the exit rank.
    await run(["batch", batchFile, "--dry-run", "--continue-on-error"]);
    const lines = stdout
      .join("")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines[0].outcome).toBe("unsupported");
    expect(lines[1].outcome).toBe("invalid");
    expect(process.exitCode).toBe(6);
  });

  it("stops on the first failure by DEFAULT, reporting the rest not-run + resume guidance", async () => {
    const uuid = seedTodo(fixture.db, { title: "ff" });
    const batchFile = join(stateDir, "ff.jsonl");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      batchFile,
      [
        JSON.stringify({ op: "trash.empty", params: {} }),
        JSON.stringify({ op: "todo.update", params: { uuid, title: "x" } }),
      ].join("\n"),
    );
    await run(["batch", batchFile]);
    const lines = stdout
      .join("")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines[0].outcome).toBe("blocked");
    expect(lines[1].outcome).toBe("skipped");
    // The trailing summary carries resume guidance (1 line did not run).
    const summary = lines.at(-1).summary;
    expect(summary.resumption.notRun).toBe(1);
  });

  it("--continue-on-error runs past a failed op (each reports its own outcome)", async () => {
    const batchFile = join(stateDir, "cont.jsonl");
    const { writeFileSync } = await import("node:fs");
    // Two guard-blocked ops (neither executes a vector): the DEFAULT would stop
    // after the first (second → skipped); --continue-on-error runs both.
    writeFileSync(
      batchFile,
      [
        JSON.stringify({ op: "trash.empty", params: {} }),
        JSON.stringify({ op: "trash.empty", params: {} }),
      ].join("\n"),
    );
    await run(["batch", batchFile, "--continue-on-error"]);
    const lines = stdout
      .join("")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines[0].outcome).toBe("blocked");
    expect(lines[1].outcome).toBe("blocked");
  });
});

describe("undo selection flags", () => {
  async function seedAudit(records: Record<string, unknown>[]): Promise<void> {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const dir = join(stateDir, "audit");
    mkdirSync(dir, { recursive: true });
    const base = {
      v: 1,
      ts: "2026-07-05T10:00:00.000Z",
      actor: "mike",
      host: "test-host",
      op: "todo.update",
      uuid: null,
      vector: "url-scheme",
      disruption: 0,
      invocation: "x",
      requested: {},
      pre: null,
      observed: null,
      result: "ok",
      verify: null,
      durationMs: 1,
      env: { pkg: "0.1.0", dbVersion: 26, fingerprint: "ok" },
    };
    writeFileSync(
      join(dir, "2026-07.jsonl"),
      records.map((r) => JSON.stringify({ ...base, ...r })).join("\n"),
    );
  }

  it("--txn and --last are mutually exclusive (usage error, exit 2)", async () => {
    await run(["undo", "--txn", "m-abc", "--last", "2"]);
    expect(process.exitCode).toBe(2);
    expect(stderr.join("")).toContain("--txn cannot be combined with --last or --by");
  });

  it("--txn with an unknown token is a loud usage error", async () => {
    await seedAudit([{ op: "todo.add", uuid: "A", actor: "mike" }]);
    await run(["undo", "--txn", "m-does-not-exist"]);
    expect(process.exitCode).toBe(2);
    expect(stderr.join("")).toContain("no undoable mutation has undo token");
  });

  it("CLI undo defaults to GLOBAL — dry-run picks the newest regardless of author", async () => {
    await seedAudit([
      { ts: "2026-07-05T09:00:00Z", op: "todo.add", uuid: "M1", actor: "mcp" },
      { ts: "2026-07-05T09:30:00Z", op: "todo.add", uuid: "H1", actor: "mike" },
    ]);
    await run(["undo", "--dry-run"]);
    const item = JSON.parse(stdout.join("").trim().split("\n")[0] ?? "{}");
    expect(item.plan.target.uuid).toBe("H1");
    expect(item.plan.target.actor).toBe("mike");
  });

  it("--by mcp narrows to the agent's record even when a human's is newer", async () => {
    await seedAudit([
      { ts: "2026-07-05T09:00:00Z", op: "todo.add", uuid: "M1", actor: "mcp" },
      { ts: "2026-07-05T09:30:00Z", op: "todo.add", uuid: "H1", actor: "mike" },
    ]);
    await run(["undo", "--by", "mcp", "--dry-run"]);
    const item = JSON.parse(stdout.join("").trim().split("\n")[0] ?? "{}");
    expect(item.plan.target.uuid).toBe("M1");
    expect(item.plan.target.actor).toBe("mcp");
  });
});

describe("update flag contradictions are refused, never silently resolved", () => {
  // The update vocabulary is built by the ONE registry both consumer surfaces
  // share (src/write/update-fields.ts, the #491 exhaustive-map doctrine). These
  // pin the CLI end of it — including the two pairs that used to be accepted and
  // then quietly overwritten, dropping the value the caller asked for.
  it("--deadline with --clear-deadline is a usage error (was: silently cleared)", async () => {
    const uuid = seedTodo(fixture.db, { title: "target" });
    await run(["todo", "update", uuid, "--deadline", "2026-09-01", "--clear-deadline"]);
    expect(process.exitCode).toBe(2);
    expect(stderr.join("")).toContain("pass at most one of --deadline / --clear-deadline");
  });

  it("--when <date>@<time> with --clear-reminder is a usage error (was: reminder dropped)", async () => {
    const uuid = seedTodo(fixture.db, { title: "target" });
    await run(["todo", "update", uuid, "--when", "today@09:00", "--clear-reminder"]);
    expect(process.exitCode).toBe(2);
    expect(stderr.join("")).toContain("carries an @time suffix");
  });

  it("project update refuses the same pairs (one vocabulary, one builder)", async () => {
    const uuid = seedProject(fixture.db, { title: "proj" });
    await run(["project", "update", uuid, "--deadline", "2026-09-01", "--clear-deadline"]);
    expect(process.exitCode).toBe(2);
    expect(stderr.join("")).toContain("pass at most one of --deadline / --clear-deadline");
  });

  it("project update splits the @time sugar exactly as the to-do verb does", async () => {
    const uuid = seedProject(fixture.db, { title: "proj" });
    await run(["project", "update", uuid, "--when", "2026-08-01@09:00", "--dry-run", "--json"]);
    const plan = envelope()["data"] as Record<string, unknown>;
    // The suffix became a real reminder token on the `when` value (%40 = @).
    expect(String(plan["invocation"])).toContain("when=2026-08-01%4009%3A00");
    expect(process.exitCode).toBe(0);
  });
});
