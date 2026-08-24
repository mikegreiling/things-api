/**
 * The CNC template-mutation composites (CNC1, docs/lab/cnc1-template-mutations.md;
 * ruling 2026-08-24) — "Create Next Copy, then mutate the instance".
 *
 * Cells here are the SIMULATOR half of the campaign's certification: the ui
 * vector is a fake that models what `Items ▸ Repeat ▸ Create Next Copy` was
 * measured to do (mint an instance dated the cursor, advance the cursor, bump
 * the tally), so every routing decision, refusal and disclosure is exercised
 * without an `open` / osascript / System Events call ever firing.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AuditRecord } from "../../src/audit/schema.ts";
import type { ThingsApiConfig } from "../../src/config.ts";
import type { FingerprintStatus } from "../../src/db/fingerprint.ts";
import { runCancelWithDate, runCompleteWithDate } from "../../src/write/resolution-timestamps.ts";
import { runTemplateExceptionWrite } from "../../src/write/template-mutation.ts";
import type { MutationResult, WriteDeps } from "../../src/write/pipeline.ts";
import type {
  CompiledInvocation,
  VectorMatrix,
  WriteVector,
} from "../../src/write/vectors/types.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedTodo } from "../fixtures/seed.ts";

const NOW = new Date("2026-07-05T12:00:00Z");
const NOW_EPOCH = Math.floor(NOW.getTime() / 1000);

/** Every Sunday. Cursor 2026-07-12 ⇒ the following slots are 07-19, 07-26, … */
const WEEKLY_SUNDAY_XML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>fa</key><integer>1</integer>
  <key>fu</key><integer>256</integer>
  <key>of</key><array><dict><key>wd</key><integer>0</integer></dict></array>
  <key>rc</key><integer>0</integer>
  <key>rrv</key><integer>4</integer>
  <key>tp</key><integer>0</integer>
  <key>ts</key><integer>0</integer>
</dict>
</plist>`;

/** Repeat 2 days AFTER each completion — no calendar, so no cursor (CNC1 §5). */
const AFTER_COMPLETION_XML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>fa</key><integer>2</integer>
  <key>fu</key><integer>256</integer>
  <key>of</key><array/>
  <key>rc</key><integer>0</integer>
  <key>rrv</key><integer>4</integer>
  <key>tp</key><integer>1</integer>
  <key>ts</key><integer>0</integer>
</dict>
</plist>`;

let fixture: FixtureDb;
let auditRecords: AuditRecord[];
let lockSeq = 0;

beforeEach(() => {
  fixture = buildFixtureDb();
  auditRecords = [];
});
afterEach(() => fixture.close());

function config(): ThingsApiConfig {
  return {
    profile: "workstation",
    maxDisruption: 3,
    actor: "mike",
    auditEnabled: true,
    acceptedFingerprint: null,
    certifiedAppVersion: null,
    allowExperimental: false,
    bounceEnabled: true,
    bounceMaxItems: 30,
    autoLaunch: true,
    helpersMode: "false",
    ui: { enabled: true },
    host: "test-host",
  };
}

function deps(vectors: WriteVector[]): WriteDeps {
  return {
    db: fixture.db,
    vectors,
    config: config(),
    audit: { append: (r) => auditRecords.push(r) },
    fingerprint: (): FingerprintStatus => ({
      kind: "ok",
      observation: { databaseVersion: 27, tables: [], fingerprint: "sha256:test" },
    }),
    lockPath: join(tmpdir(), `things-api-cnc-lock-${process.pid}-${lockSeq++}`),
    isAppRunning: () => true,
    ensureRunning: async () => true,
    now: () => NOW,
    pkgVersion: "test",
  };
}

const UI_MATRIX: VectorMatrix = {
  "todo.create-next-copy": { support: "yes", disruption: 3, validation: "validated" },
};
const URL_MATRIX: VectorMatrix = {
  "todo.update": { support: "yes", disruption: 0, validation: "validated" },
  "todo.complete": { support: "yes", disruption: 0, validation: "validated" },
  "todo.cancel": { support: "yes", disruption: 0, validation: "validated" },
};

/**
 * The fake `Create Next Copy`, modelled on the measured delta (CNC1 §1.2): it
 * inserts an instance dated the template's CURSOR, advances the cursor one
 * period, and bumps the tally. Nothing else on the template moves.
 */
function cncVector(templateUuid: () => string, cursorAdvanceDays = 7) {
  const state = { calls: 0, mintedUuids: [] as string[] };
  const vector: WriteVector = {
    id: "ui",
    matrix: UI_MATRIX,
    async execute() {
      state.calls += 1;
      const t = templateUuid();
      const row = fixture.db
        .prepare("SELECT title, rt1_nextInstanceStartDate AS next FROM TMTask WHERE uuid = ?")
        .get(t) as { title: string; next: number | null };
      const cursorIso = decode(row.next);
      const uuid = seedTodo(fixture.db, {
        title: row.title,
        repeatingTemplate: t,
        ...(cursorIso !== null && { startDate: cursorIso }),
        creationDate: NOW_EPOCH,
      });
      state.mintedUuids.push(uuid);
      if (cursorIso !== null) {
        const nextIso = addDays(cursorIso, cursorAdvanceDays);
        fixture.db
          .prepare(
            "UPDATE TMTask SET rt1_nextInstanceStartDate = ?, " +
              "rt1_instanceCreationCount = rt1_instanceCreationCount + 1 WHERE uuid = ?",
          )
          .run(encode(nextIso), t);
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  return { vector, state };
}

function urlVector(): { vector: WriteVector; payloads: string[] } {
  const payloads: string[] = [];
  return {
    payloads,
    vector: {
      id: "url-scheme",
      matrix: URL_MATRIX,
      async execute(inv: CompiledInvocation) {
        payloads.push(inv.payload);
        applyUrl(inv.payload);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  };
}

/** Apply the handful of url-scheme effects these cells exercise. */
function applyUrl(payload: string): void {
  const url = new URL(payload);
  const p = url.searchParams;
  const uuid = p.get("id");
  if (uuid === null) return;
  if (p.get("completed") === "true") {
    fixture.db
      .prepare("UPDATE TMTask SET status = 3, stopDate = ? WHERE uuid = ?")
      .run(NOW_EPOCH, uuid);
  }
  if (p.get("canceled") === "true") {
    fixture.db
      .prepare("UPDATE TMTask SET status = 2, stopDate = ? WHERE uuid = ?")
      .run(NOW_EPOCH, uuid);
  }
  const when = p.get("when");
  if (when === "someday") {
    fixture.db
      .prepare("UPDATE TMTask SET start = 2, startDate = NULL, startBucket = 0 WHERE uuid = ?")
      .run(uuid);
  }
  if (when === "anytime") {
    fixture.db
      .prepare("UPDATE TMTask SET start = 1, startDate = NULL, startBucket = 0 WHERE uuid = ?")
      .run(uuid);
  }
  if (when !== null && /^\d{4}-\d{2}-\d{2}$/.test(when)) {
    fixture.db
      .prepare(
        "UPDATE TMTask SET startDate = ?, start = 2, todayIndexReferenceDate = ? WHERE uuid = ?",
      )
      .run(encode(when), encode(when), uuid);
  }
  const deadline = p.get("deadline");
  if (deadline !== null && /^\d{4}-\d{2}-\d{2}$/.test(deadline)) {
    fixture.db.prepare("UPDATE TMTask SET deadline = ? WHERE uuid = ?").run(encode(deadline), uuid);
  }
}

function encode(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return (y << 16) | (m << 12) | (d << 7);
}
function decode(packed: number | null): string | null {
  if (packed === null || packed === 0) return null;
  const y = packed >> 16;
  const m = (packed >> 12) & 0xf;
  const d = (packed >> 7) & 0x1f;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
function addDays(iso: string, days: number): string {
  const t = new Date(`${iso}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

/** A weekly-Sunday series whose pending occurrence is 2026-07-12. */
function seedSeries(opts: { withOpenInstance?: boolean; ruleXml?: string } = {}): {
  template: string;
  instance: string | null;
} {
  const template = seedTodo(fixture.db, {
    title: "Water plants",
    recurrenceRuleXml: opts.ruleXml ?? WEEKLY_SUNDAY_XML,
    nextInstanceStartDate: opts.ruleXml === AFTER_COMPLETION_XML ? null : "2026-07-12",
    instanceCreationCount: 1,
  });
  const instance =
    opts.withOpenInstance === true
      ? seedTodo(fixture.db, {
          title: "Water plants",
          repeatingTemplate: template,
          startDate: "2026-07-05",
        })
      : null;
  return { template, instance };
}

function statusOf(uuid: string): number {
  return (
    fixture.db.prepare("SELECT status FROM TMTask WHERE uuid = ?").get(uuid) as {
      status: number;
    }
  ).status;
}
function warningsOf(r: MutationResult): string[] {
  return r.kind === "ok" ? (r.warnings ?? []) : [];
}

// ------------------------------------------------------------ status writes

describe("complete/cancel on a repeating to-do — the CNC composite", () => {
  it("resolves the OPEN materialized occurrence and never drives the app", async () => {
    const { template, instance } = seedSeries({ withOpenInstance: true });
    const cnc = cncVector(() => template);
    const url = urlVector();
    const result = await runCompleteWithDate(
      deps([url.vector, cnc.vector]),
      "todo",
      template,
      {},
      {},
    );

    expect(result.kind).toBe("ok");
    expect(cnc.state.calls, "no occurrence should be created when one is already open").toBe(0);
    expect(statusOf(instance as string)).toBe(3);
    expect(statusOf(template), "the series itself is never resolved").toBe(0);
    expect(warningsOf(result).join(" ")).toContain("2026-07-05 occurrence");
    expect(warningsOf(result).join(" ")).toContain("the next occurrence is 2026-07-12");
  });

  it("materializes the pending occurrence when the series has none open, and says so", async () => {
    const { template } = seedSeries();
    const cnc = cncVector(() => template);
    const url = urlVector();
    const result = await runCompleteWithDate(
      deps([url.vector, cnc.vector]),
      "todo",
      template,
      {},
      {},
    );

    expect(result.kind).toBe("ok");
    expect(cnc.state.calls).toBe(1);
    const minted = cnc.state.mintedUuids[0] as string;
    expect(statusOf(minted)).toBe(3);
    expect(statusOf(template)).toBe(0);
    const said = warningsOf(result).join(" ");
    expect(said).toContain("2026-07-12 occurrence");
    expect(said).toContain("created just now");
    expect(said).toContain("the next occurrence is 2026-07-19");
    expect(said, "the half-reversibility must be disclosed at op time").toContain("cannot remove");
  });

  it("cancel takes the same path and leaves the series running (CNC1 §6)", async () => {
    const { template } = seedSeries();
    const cnc = cncVector(() => template);
    const url = urlVector();
    const result = await runCancelWithDate(
      deps([url.vector, cnc.vector]),
      "todo",
      template,
      {},
      {},
    );

    expect(result.kind).toBe("ok");
    expect(statusOf(cnc.state.mintedUuids[0] as string)).toBe(2);
    expect(warningsOf(result).join(" ")).toContain("canceled the 2026-07-12 occurrence");
    expect(warningsOf(result).join(" ")).toContain("the next occurrence is 2026-07-19");
  });

  it("refuses an after-completion series with no unfinished occurrence (CNC1 §5)", async () => {
    const { template } = seedSeries({ ruleXml: AFTER_COMPLETION_XML });
    const cnc = cncVector(() => template);
    const result = await runCompleteWithDate(
      deps([urlVector().vector, cnc.vector]),
      "todo",
      template,
      {},
      {},
    );

    expect(result.kind).toBe("blocked");
    expect(cnc.state.calls, "nothing may be created for a rule with no upcoming occurrence").toBe(
      0,
    );
  });

  it("an after-completion series WITH an open occurrence resolves it normally", async () => {
    const { template, instance } = seedSeries({
      ruleXml: AFTER_COMPLETION_XML,
      withOpenInstance: true,
    });
    const cnc = cncVector(() => template);
    const result = await runCompleteWithDate(
      deps([urlVector().vector, cnc.vector]),
      "todo",
      template,
      {},
      {},
    );

    expect(result.kind).toBe("ok");
    expect(cnc.state.calls).toBe(0);
    expect(statusOf(instance as string)).toBe(3);
  });

  it("leaves an ORDINARY to-do on the ordinary path", async () => {
    const plain = seedTodo(fixture.db, { title: "Plain", startDate: "2026-07-05" });
    const cnc = cncVector(() => plain);
    const result = await runCompleteWithDate(
      deps([urlVector().vector, cnc.vector]),
      "todo",
      plain,
      {},
      {},
    );

    expect(result.kind).toBe("ok");
    expect(cnc.state.calls).toBe(0);
    expect(statusOf(plain)).toBe(3);
    expect(warningsOf(result).join(" ")).not.toContain("occurrence");
  });
});

// --------------------------------------------------------- exception writes

describe("update --exception on a repeating to-do", () => {
  it("materializes the pending occurrence and moves ONLY that row", async () => {
    const { template } = seedSeries();
    const cnc = cncVector(() => template);
    const url = urlVector();
    const result = await runTemplateExceptionWrite(
      deps([url.vector, cnc.vector]),
      template,
      { when: "2026-07-15" },
      {},
    );

    expect(result.kind).toBe("ok");
    expect(cnc.state.calls).toBe(1);
    const minted = cnc.state.mintedUuids[0] as string;
    const moved = fixture.db.prepare("SELECT startDate FROM TMTask WHERE uuid = ?").get(minted) as {
      startDate: number | null;
    };
    expect(decode(moved.startDate)).toBe("2026-07-15");
    const said = warningsOf(result).join(" ");
    expect(said).toContain("changed only the 2026-07-12 occurrence");
    expect(said).toContain("the series itself is unchanged");
    expect(said).toContain("the next occurrence is 2026-07-19");
  });

  it("REFUSES a day the series already lands on, before anything is driven (CNC1 §2)", async () => {
    const { template } = seedSeries();
    const cnc = cncVector(() => template);
    const url = urlVector();
    // 2026-07-19 is the weekly rule's own next slot after the consumed one.
    const result = await runTemplateExceptionWrite(
      deps([url.vector, cnc.vector]),
      template,
      { when: "2026-07-19" },
      {},
    );

    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") {
      expect(result.detail).toContain("2026-07-19");
      expect(result.detail).toContain("two copies");
      expect(result.remediation).toContain("reschedule-repeat");
    }
    expect(cnc.state.calls, "the refusal must precede the drive").toBe(0);
    expect(url.payloads).toHaveLength(0);
  });

  it("ALLOWS a day between the rule's own slots", async () => {
    const { template } = seedSeries();
    const cnc = cncVector(() => template);
    const result = await runTemplateExceptionWrite(
      deps([urlVector().vector, cnc.vector]),
      template,
      { when: "2026-07-16" },
      {},
    );
    expect(result.kind).toBe("ok");
  });

  it("ALLOWS the consumed slot's own day — that slot is the one being taken", async () => {
    const { template } = seedSeries();
    const cnc = cncVector(() => template);
    const result = await runTemplateExceptionWrite(
      deps([urlVector().vector, cnc.vector]),
      template,
      { when: "2026-07-12" },
      {},
    );
    expect(result.kind).toBe("ok");
  });

  it("refuses an after-completion series outright (CNC1 §5 / oddities §18)", async () => {
    const { template } = seedSeries({ ruleXml: AFTER_COMPLETION_XML });
    const cnc = cncVector(() => template);
    const result = await runTemplateExceptionWrite(
      deps([urlVector().vector, cnc.vector]),
      template,
      { when: "2026-07-15" },
      {},
    );

    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") expect(result.remediation).toContain("reschedule-repeat");
    expect(cnc.state.calls).toBe(0);
  });

  it("a non-dated schedule value cannot collide, so it is not refused", async () => {
    const { template } = seedSeries();
    const cnc = cncVector(() => template);
    const result = await runTemplateExceptionWrite(
      deps([urlVector().vector, cnc.vector]),
      template,
      { when: "someday" },
      {},
    );
    expect(result.kind).toBe("ok");
  });

  it("a deadline-only exception needs no collision check and lands on the occurrence", async () => {
    const { template } = seedSeries();
    const cnc = cncVector(() => template);
    const result = await runTemplateExceptionWrite(
      deps([urlVector().vector, cnc.vector]),
      template,
      { deadline: "2026-07-20" },
      {},
    );

    expect(result.kind).toBe("ok");
    const minted = cnc.state.mintedUuids[0] as string;
    const row = fixture.db.prepare("SELECT deadline FROM TMTask WHERE uuid = ?").get(minted) as {
      deadline: number | null;
    };
    expect(decode(row.deadline)).toBe("2026-07-20");
  });

  it("reports the created occurrence when the second write fails, so it is not orphaned silently", async () => {
    const { template } = seedSeries();
    const cnc = cncVector(() => template);
    const failing: WriteVector = {
      id: "url-scheme",
      matrix: URL_MATRIX,
      async execute() {
        return { exitCode: 1, stdout: "", stderr: "nope" };
      },
    };
    const result = await runTemplateExceptionWrite(
      deps([failing, cnc.vector]),
      template,
      { when: "2026-07-15" },
      {},
    );

    expect(result.kind).not.toBe("ok");
    expect(cnc.state.calls).toBe(1);
    if ("detail" in result && typeof result.detail === "string") {
      expect(result.detail).toContain("created but not changed");
      expect(result.detail).toContain(cnc.state.mintedUuids[0] as string);
    }
  });
});
