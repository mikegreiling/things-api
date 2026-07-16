import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAuditWriter } from "../../src/audit/log.ts";
import type { AuditRecord } from "../../src/audit/schema.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "things-api-audit-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A minimal, valid AuditRecord with caller-controllable fields. */
function makeRecord(over: Partial<AuditRecord> = {}): AuditRecord {
  return {
    v: 1,
    ts: "2026-07-16T12:00:00.000Z",
    actor: "cli",
    host: "test-host",
    op: "todo.update",
    uuid: "todo-1",
    vector: "url",
    disruption: 0,
    invocation: null,
    requested: {},
    pre: null,
    observed: null,
    result: "ok",
    verify: null,
    durationMs: 5,
    env: { pkg: "0.0.0", dbVersion: 26, fingerprint: "ok" },
    ...over,
  };
}

describe("createAuditWriter — structural token redaction", () => {
  it("emits no on-disk occurrence of the loaded auth token, redacting to REDACTED", () => {
    const token = "auth-tok-DEADBEEF-secret";
    const writer = createAuditWriter({ dir, secrets: [token], enabled: true });

    // Embed the token in several distinct string fields, including one that
    // carries it twice in a single value (the replacer must sweep all copies).
    writer.append(
      makeRecord({
        invocation: `things:///update?auth-token=${token}&title=x`,
        requested: {
          note: `leading ${token} and trailing ${token}`,
          nested: { deep: `x-${token}-y` },
        },
        actor: token,
      }),
    );

    const files = readdirSync(dir);
    expect(files).toEqual(["2026-07.jsonl"]);
    const raw = readFileSync(join(dir, "2026-07.jsonl"), "utf8");

    // The token appears NOWHERE on disk.
    expect(raw).not.toContain(token);

    // Every embedded occurrence became exactly "REDACTED".
    const parsed = JSON.parse(raw.trimEnd()) as AuditRecord;
    expect(parsed.invocation).toBe("things:///update?auth-token=REDACTED&title=x");
    expect(parsed.requested["note"]).toBe("leading REDACTED and trailing REDACTED");
    expect((parsed.requested["nested"] as { deep: string }).deep).toBe("x-REDACTED-y");
    expect(parsed.actor).toBe("REDACTED");
  });

  it("ignores empty-string secrets (no spurious redaction) and leaves clean records intact", () => {
    const writer = createAuditWriter({ dir, secrets: ["", "realtoken"], enabled: true });
    writer.append(makeRecord({ invocation: "things:///update?title=hello" }));
    const raw = readFileSync(join(dir, "2026-07.jsonl"), "utf8");
    const parsed = JSON.parse(raw.trimEnd()) as AuditRecord;
    expect(parsed.invocation).toBe("things:///update?title=hello");
    expect(raw).not.toContain("REDACTED");
  });
});

describe("createAuditWriter — enabled flag", () => {
  it("writes nothing (no file, no directory contents) when disabled", () => {
    const writer = createAuditWriter({ dir, secrets: ["x"], enabled: false });
    writer.append(makeRecord());
    writer.append(makeRecord({ ts: "2026-08-01T00:00:00.000Z" }));
    // mkdirSync is only reached inside the enabled branch, so the dir stays empty.
    expect(readdirSync(dir)).toEqual([]);
    expect(existsSync(join(dir, "2026-07.jsonl"))).toBe(false);
  });
});

describe("createAuditWriter — monthly file naming + JSONL append", () => {
  it("names files YYYY-MM.jsonl from the record ts and appends valid JSONL", () => {
    const writer = createAuditWriter({ dir, secrets: [], enabled: true });
    writer.append(makeRecord({ ts: "2026-07-01T09:00:00.000Z", uuid: "a" }));
    writer.append(makeRecord({ ts: "2026-07-31T23:59:59.000Z", uuid: "b" }));
    writer.append(makeRecord({ ts: "2026-08-02T10:00:00.000Z", uuid: "c" }));

    expect(readdirSync(dir).toSorted()).toEqual(["2026-07.jsonl", "2026-08.jsonl"]);

    const july = readFileSync(join(dir, "2026-07.jsonl"), "utf8");
    // Trailing newline on every record → final element is empty once split.
    const lines = july.split("\n");
    expect(lines.at(-1)).toBe("");
    const records = lines.slice(0, -1).map((l) => JSON.parse(l) as AuditRecord);
    expect(records.map((r) => r.uuid)).toEqual(["a", "b"]);

    const august = readFileSync(join(dir, "2026-08.jsonl"), "utf8");
    const augRecords = august
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as AuditRecord);
    expect(augRecords.map((r) => r.uuid)).toEqual(["c"]);
  });
});

describe("createAuditWriter — durable, tear-resistant appends (M5)", () => {
  it("the fsync/O_APPEND path writes parseable one-line-per-record JSONL", () => {
    const writer = createAuditWriter({ dir, secrets: [], enabled: true });
    // Several appends to the SAME monthly file, each a complete O_APPEND write.
    writer.append(makeRecord({ ts: "2026-07-10T09:00:00.000Z", uuid: "a", result: "intent" }));
    writer.append(makeRecord({ ts: "2026-07-10T09:00:00.000Z", uuid: "a", result: "ok" }));
    writer.append(makeRecord({ ts: "2026-07-11T09:00:00.000Z", uuid: "b" }));

    const raw = readFileSync(join(dir, "2026-07.jsonl"), "utf8");
    // Exactly one newline-terminated line per record, each independently valid.
    const lines = raw.split("\n");
    expect(lines.at(-1)).toBe(""); // trailing newline
    const records = lines.slice(0, -1).map((l) => JSON.parse(l) as AuditRecord);
    expect(records.map((r) => `${r.uuid}:${r.result}`)).toEqual(["a:intent", "a:ok", "b:ok"]);
  });

  it("round-trips a huge record (>1MB) as a single intact line", () => {
    const writer = createAuditWriter({ dir, secrets: [], enabled: true });
    const big = "x".repeat(1_500_000); // 1.5 MB, well over PIPE_BUF
    writer.append(makeRecord({ uuid: "big", requested: { blob: big } }));

    const raw = readFileSync(join(dir, "2026-07.jsonl"), "utf8");
    // One record, one trailing newline — no split/torn buffer.
    const lines = raw.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe("");
    const parsed = JSON.parse(lines[0] as string) as AuditRecord;
    expect(parsed.uuid).toBe("big");
    expect((parsed.requested["blob"] as string).length).toBe(big.length);
  });
});
