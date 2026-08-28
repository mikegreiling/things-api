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
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
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
let auditDir: string;
let lockSeq = 0;

beforeEach(() => {
  fixture = buildFixtureDb();
  auditRecords = [];
  // A REAL trail directory: the `opId` lookback reads the change history off
  // disk, so the in-memory array alone cannot exercise it.
  auditDir = mkdtempSync(join(tmpdir(), "things-api-cnc-audit-"));
});
afterEach(() => {
  fixture.close();
  rmSync(auditDir, { recursive: true, force: true });
});

/** Append a record to the on-disk trail the way the real writer does. */
function writeTrail(record: AuditRecord): void {
  appendFileSync(join(auditDir, "2026-07.jsonl"), `${JSON.stringify(record)}\n`);
}

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

/**
 * A poller whose clock JUMPS instead of sleeping, so the fixed 2s recovery
 * re-verify a watchdog abort triggers costs nothing here. Deadline arithmetic is
 * unchanged — only the passage of time is faked.
 */
function fastPoller(): WriteDeps["poller"] {
  let clock = 0;
  return { now: () => (clock += 500), sleep: async () => {} };
}

function deps(vectors: WriteVector[], poller?: WriteDeps["poller"]): WriteDeps {
  return {
    db: fixture.db,
    vectors,
    ...(poller !== undefined && { poller }),
    config: config(),
    audit: {
      append: (r) => {
        auditRecords.push(r);
        writeTrail(r);
      },
    },
    auditDirPath: auditDir,
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

/**
 * A weekly-Sunday series whose pending occurrence is 2026-07-12.
 *
 * `cursor` overrides the derived one. It matters for after-completion rules,
 * which CNCAC1 measured in BOTH states: NULL while the current occurrence is
 * still unfinished, and a real derived date the moment it is resolved — the
 * second being the shape whose projection Upcoming renders and the GUI checks
 * off, and the one the shipped composite must therefore handle.
 */
function seedSeries(
  opts: { withOpenInstance?: boolean; ruleXml?: string; cursor?: string | null } = {},
): {
  template: string;
  instance: string | null;
} {
  const derived = opts.ruleXml === AFTER_COMPLETION_XML ? null : "2026-07-12";
  const template = seedTodo(fixture.db, {
    title: "Water plants",
    recurrenceRuleXml: opts.ruleXml ?? WEEKLY_SUNDAY_XML,
    nextInstanceStartDate: opts.cursor === undefined ? derived : opts.cursor,
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
/**
 * The occurrence disclosures a template-target composite carries. They are
 * NOTES (#632): each states what was written and when the series comes back —
 * matter-of-fact, never a call to action.
 */
function notesOf(r: MutationResult): string[] {
  return r.kind === "ok" ? (r.notes ?? []) : [];
}

/** Both tiers, for an assertion that something is said NOWHERE. */
function saidOf(r: MutationResult): string[] {
  return r.kind === "ok" ? [...(r.warnings ?? []), ...(r.notes ?? [])] : [];
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
    expect(notesOf(result).join(" ")).toContain("2026-07-05 occurrence");
    expect(notesOf(result).join(" ")).toContain("the next occurrence is 2026-07-12");
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
    const said = notesOf(result).join(" ");
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
    expect(notesOf(result).join(" ")).toContain("canceled the 2026-07-12 occurrence");
    expect(notesOf(result).join(" ")).toContain("the next occurrence is 2026-07-19");
  });

  it("refuses a series with NO CURSOR — there is nothing to bring forward (CNCAC1 §6)", async () => {
    // The refusal is keyed on the missing cursor, not on the rule kind: it is
    // exactly the state in which `Create Next Copy` duplicates the current
    // occurrence instead of materializing a pending one (oddities §18).
    const { template } = seedSeries({ ruleXml: AFTER_COMPLETION_XML, cursor: null });
    const cnc = cncVector(() => template);
    const result = await runCompleteWithDate(
      deps([urlVector().vector, cnc.vector]),
      "todo",
      template,
      {},
      {},
    );

    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") expect(result.detail).toContain("no upcoming occurrence");
    expect(cnc.state.calls, "nothing may be created for a rule with no upcoming occurrence").toBe(
      0,
    );
  });

  it("an AFTER-COMPLETION series with a derived cursor is resolved, not refused (CNCAC1 §4)", async () => {
    // The shape the maintainer hit live: the current copy is done, so the app
    // has anchored the series and derived a real next date, and Upcoming draws
    // a projection the GUI checks off. CNCAC1 measured CNC + the status write
    // reproducing that gesture, with no duplicate.
    const { template } = seedSeries({ ruleXml: AFTER_COMPLETION_XML, cursor: "2026-07-12" });
    const cnc = cncVector(() => template);
    const result = await runCompleteWithDate(
      deps([urlVector().vector, cnc.vector]),
      "todo",
      template,
      {},
      {},
    );

    expect(result.kind).toBe("ok");
    expect(cnc.state.calls).toBe(1);
    expect(statusOf(cnc.state.mintedUuids[0] as string)).toBe(3);
    expect(notesOf(result).join(" ")).toContain("checked off the 2026-07-12 occurrence");
    expect(
      notesOf(result).join(" "),
      "an after-completion series restarts its interval from the completion",
    ).toContain("restarted the interval from today");
  });

  it("names RESUME as the remedy when the cursor is missing because the series is paused", async () => {
    const template = seedTodo(fixture.db, {
      title: "Water plants",
      recurrenceRuleXml: WEEKLY_SUNDAY_XML,
      nextInstanceStartDate: null,
      instanceCreationPaused: true,
      instanceCreationCount: 1,
    });
    const cnc = cncVector(() => template);
    const result = await runCompleteWithDate(
      deps([urlVector().vector, cnc.vector]),
      "todo",
      template,
      {},
      {},
    );

    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") {
      expect(result.detail).toContain("paused");
      expect(result.remediation).toContain("resume-repeat");
    }
    expect(cnc.state.calls).toBe(0);
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
    expect(saidOf(result).join(" ")).not.toContain("occurrence");
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
    const said = notesOf(result).join(" ");
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

  it("refuses a CURSOR-LESS series outright (CNC1 §5 / CNCAC1 §6 / oddities §18)", async () => {
    const { template } = seedSeries({ ruleXml: AFTER_COMPLETION_XML, cursor: null });
    const cnc = cncVector(() => template);
    const result = await runTemplateExceptionWrite(
      deps([urlVector().vector, cnc.vector]),
      template,
      { when: "2026-07-15" },
      {},
    );

    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") expect(result.detail).toContain("no upcoming occurrence");
    expect(cnc.state.calls).toBe(0);
  });

  it("an after-completion series with a cursor takes an exception — no slot can collide", async () => {
    // CNCAC1 §7: an after-completion rule owns exactly ONE future date, the
    // cursor this mint consumes, so the live-slot check has nothing to check and
    // must not degrade into the undecodable-rule refusal.
    const { template } = seedSeries({ ruleXml: AFTER_COMPLETION_XML, cursor: "2026-07-12" });
    const cnc = cncVector(() => template);
    const result = await runTemplateExceptionWrite(
      deps([urlVector().vector, cnc.vector]),
      template,
      { when: "2026-07-15" },
      {},
    );

    expect(result.kind).toBe("ok");
    expect(cnc.state.calls).toBe(1);
    expect(notesOf(result).join(" ")).toContain("changed only the 2026-07-12 occurrence");
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

// --------------------------------------------- what the result NAMES (#578)

/** The composite's single summary record, or undefined when it wrote none. */
/**
 * The composite's summary RESULT. A keyed composite also writes a summary-layer
 * `intent` first (#639), which is a marker rather than a result — so the record
 * the one-record-per-key discipline is about is the non-intent one.
 */
function summaryRecord(): AuditRecord | undefined {
  return auditRecords.find((r) => r.txn?.role === "summary" && r.result !== "intent");
}
/** The write-ahead in-flight marker a keyed composite writes before its first leg. */
function summaryIntent(): AuditRecord | undefined {
  return auditRecords.find((r) => r.txn?.role === "summary" && r.result === "intent");
}
function legRecords(): AuditRecord[] {
  return auditRecords.filter((r) => r.txn?.role === "leg");
}
function occurrenceOf(r: MutationResult) {
  return r.kind === "ok" ? r.occurrence : undefined;
}

describe("the composite names the occurrence it wrote", () => {
  it("resolving an already-open occurrence reports it as NOT minted", async () => {
    const { template, instance } = seedSeries({ withOpenInstance: true });
    const cnc = cncVector(() => template);
    const result = await runCompleteWithDate(
      deps([urlVector().vector, cnc.vector]),
      "todo",
      template,
      {},
      {},
    );

    expect(occurrenceOf(result)).toEqual({
      templateUuid: template,
      occurrenceUuid: instance,
      minted: false,
      date: "2026-07-05",
    });
    expect(result.kind === "ok" && result.uuid, "the result uuid IS the occurrence").toBe(instance);
  });

  it("a materialized occurrence is reported as minted, with the slot it consumed", async () => {
    const { template } = seedSeries();
    const cnc = cncVector(() => template);
    const result = await runCompleteWithDate(
      deps([urlVector().vector, cnc.vector]),
      "todo",
      template,
      {},
      {},
    );

    expect(occurrenceOf(result)).toEqual({
      templateUuid: template,
      occurrenceUuid: cnc.state.mintedUuids[0],
      minted: true,
      date: "2026-07-12",
    });
  });

  it("an exception names both uuids too (it always mints)", async () => {
    const { template } = seedSeries();
    const cnc = cncVector(() => template);
    const result = await runTemplateExceptionWrite(
      deps([urlVector().vector, cnc.vector]),
      template,
      { when: "2026-07-15" },
      {},
    );

    expect(occurrenceOf(result)).toEqual({
      templateUuid: template,
      occurrenceUuid: cnc.state.mintedUuids[0],
      minted: true,
      date: "2026-07-12",
    });
  });

  it("records ONE summary keyed by the op-id, carrying the occurrence — the legs carry neither", async () => {
    const { template } = seedSeries();
    const cnc = cncVector(() => template);
    const result = await runCompleteWithDate(
      deps([urlVector().vector, cnc.vector]),
      "todo",
      template,
      {},
      { opId: "check-off-1" },
    );

    const summary = summaryRecord();
    expect(summary, "a composite must leave one record standing for the whole verb").toBeDefined();
    expect(summary?.opId).toBe("check-off-1");
    expect(summary?.occurrence).toEqual(occurrenceOf(result));
    expect(summary?.uuid, "the summary is addressed to the occurrence").toBe(
      cnc.state.mintedUuids[0],
    );
    expect(
      auditRecords.filter((r) => r.txn?.role === "summary" && r.result !== "intent"),
    ).toHaveLength(1);
    // The in-flight marker precedes it and names the process that owned the verb,
    // which is what lets a concurrent same-key retry be refused instead of queued.
    expect(summaryIntent()?.opId).toBe("check-off-1");
    expect(summaryIntent()?.holder?.pid).toBe(process.pid);
    expect(
      legRecords().map((r) => r.opId),
      "the key identifies the composite, never a leg",
    ).toEqual(legRecords().map(() => undefined));
    expect(
      result.kind === "ok" && result.undoToken,
      "the summary is what `things undo` reaches",
    ).toBe(summary?.txn?.id);
  });
});

describe("a backdated status write on a series stays ONE undoable unit", () => {
  it("--completed-at nests its flip legs into the composite's transaction", async () => {
    // The status leg re-enters the resolution orchestrator, which is itself a
    // composite. Left alone it would open a second transaction and write a
    // second summary, and the OUTER summary — the one `undo` targets — would
    // find no legs of its own and report itself irreversible.
    const { template } = seedSeries();
    const cnc = cncVector(() => template);
    // The backdate leg is an AppleScript write; the fake applies what it was
    // measured to do (the completed row keeps the backdated stop date).
    const noonEpoch = Math.floor(new Date(2026, 6, 1, 12, 0, 0).getTime() / 1000);
    const as: WriteVector = {
      id: "applescript",
      matrix: { "todo.set-dates": { support: "yes", disruption: 0, validation: "validated" } },
      async execute() {
        fixture.db
          .prepare("UPDATE TMTask SET status = 3, stopDate = ? WHERE uuid = ?")
          .run(noonEpoch, cnc.state.mintedUuids[0] as string);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const result = await runCompleteWithDate(
      deps([urlVector().vector, as, cnc.vector]),
      "todo",
      template,
      { completedAt: "2026-07-01" },
      {},
    );

    expect(result.kind).toBe("ok");
    const summaries = auditRecords.filter((r) => r.txn?.role === "summary");
    expect(summaries, "exactly one record stands for the whole verb").toHaveLength(1);
    const txnId = summaries[0]?.txn?.id;
    expect(
      legRecords().every((r) => r.txn?.id === txnId),
      "every leg — the mint and both flips — belongs to that one transaction",
    ).toBe(true);
    expect(result.kind === "ok" && result.undoToken).toBe(txnId);
    expect(occurrenceOf(result)?.minted).toBe(true);
  });
});

// ------------------------------------------------- retry safety (--op-id)

describe("--op-id makes a retry safe (no second occurrence)", () => {
  it("a resubmitted key replays the first result and drives NOTHING", async () => {
    const { template } = seedSeries();
    const cnc = cncVector(() => template);
    const url = urlVector();
    const d = deps([url.vector, cnc.vector]);
    const first = await runCompleteWithDate(d, "todo", template, {}, { opId: "retry-me" });
    expect(first.kind).toBe("ok");
    const writesBefore = url.payloads.length;
    const recordsBefore = auditRecords.length;

    const second = await runCompleteWithDate(d, "todo", template, {}, { opId: "retry-me" });

    expect(second.kind).toBe("ok");
    expect(second.kind === "ok" && second.alreadyApplied).toBe(true);
    expect(occurrenceOf(second), "the replay answers with the SAME occurrence").toEqual(
      occurrenceOf(first),
    );
    expect(cnc.state.calls, "no second occurrence may be materialized").toBe(1);
    expect(url.payloads.length, "nothing may be dispatched on a replay").toBe(writesBefore);
    expect(auditRecords.length, "a replay records nothing").toBe(recordsBefore);
  });

  it("a DIFFERENT key is a new action — it takes the following occurrence", async () => {
    const { template } = seedSeries();
    const cnc = cncVector(() => template);
    const d = deps([urlVector().vector, cnc.vector]);
    await runCompleteWithDate(d, "todo", template, {}, { opId: "first-tick" });
    const second = await runCompleteWithDate(d, "todo", template, {}, { opId: "second-tick" });

    expect(second.kind === "ok" && second.alreadyApplied).toBeUndefined();
    expect(cnc.state.calls).toBe(2);
    expect(occurrenceOf(second)?.occurrenceUuid).toBe(cnc.state.mintedUuids[1]);
    expect(occurrenceOf(second)?.date, "the series moved on").toBe("2026-07-19");
  });

  it("an exception replays too — the series does not lose a second slot to a retry", async () => {
    const { template } = seedSeries();
    const cnc = cncVector(() => template);
    const d = deps([urlVector().vector, cnc.vector]);
    const first = await runTemplateExceptionWrite(
      d,
      template,
      { when: "2026-07-15" },
      {
        opId: "move-next",
      },
    );
    const second = await runTemplateExceptionWrite(
      d,
      template,
      { when: "2026-07-15" },
      {
        opId: "move-next",
      },
    );

    expect(second.kind === "ok" && second.alreadyApplied).toBe(true);
    expect(occurrenceOf(second)).toEqual(occurrenceOf(first));
    expect(cnc.state.calls).toBe(1);
  });

  /** A prior attempt under `opId` that dispatched and never confirmed. */
  function writeTimedOutRecord(
    opId: string,
    expected?: AuditRecord["expected"],
    uuid = "ghost-occurrence",
  ): void {
    writeTrail({
      v: 1,
      ts: NOW.toISOString(),
      actor: "mike",
      host: "test-host",
      op: "todo.complete",
      uuid,
      vector: "ui",
      disruption: 3,
      invocation: "todo.complete",
      requested: { uuid: "template" },
      txn: { id: "txn-ghost", role: "summary" },
      opId,
      ...(expected !== undefined && { expected }),
      pre: null,
      observed: null,
      result: "verify-failed:timeout",
      verify: null,
      durationMs: 1,
      env: { pkg: "test", dbVersion: 27, fingerprint: "ok" },
    });
  }

  it("a TIMED-OUT original with nothing recorded to check REFUSES — it does not mint a second occurrence", async () => {
    // The record says the write was dispatched and never confirmed, so what
    // landed is unknown. Re-running would take a SECOND occurrence out of the
    // series; replaying would claim one that may not exist. With no recorded
    // assertion to settle it, the honest answer is neither (phase 2).
    const { template } = seedSeries();
    const cnc = cncVector(() => template);
    writeTimedOutRecord("timed-out");

    const result = await runCompleteWithDate(
      deps([urlVector().vector, cnc.vector]),
      "todo",
      template,
      {},
      { opId: "timed-out" },
    );

    expect(result.kind).toBe("blocked");
    if (result.kind !== "blocked") throw new Error("unreachable");
    expect(result.reason).toBe("reconcile");
    expect(result.remediation).toContain("things op-result timed-out");
    expect(cnc.state.calls, "nothing was materialized").toBe(0);
  });

  it("a TIMED-OUT original whose change IS in place replays it", async () => {
    // The occurrence the earlier attempt was resolving reads back completed, so
    // the change is there: replay, and materialize nothing.
    const { template } = seedSeries();
    const ghost = seedTodo(fixture.db, { title: "Ghost occurrence", repeatingTemplate: template });
    fixture.db.prepare("UPDATE TMTask SET status = 3 WHERE uuid = ?").run(ghost);
    const cnc = cncVector(() => template);
    writeTimedOutRecord(
      "landed-late",
      { mode: "update", uuid: ghost, assert: [{ field: "status", equals: "completed" }] },
      ghost,
    );

    const result = await runCompleteWithDate(
      deps([urlVector().vector, cnc.vector]),
      "todo",
      template,
      {},
      { opId: "landed-late" },
    );

    expect(result.kind === "ok" && result.alreadyApplied).toBe(true);
    expect(result.kind === "ok" && result.uuid).toBe(ghost);
    expect(cnc.state.calls, "no second occurrence").toBe(0);
  });
});

// ------------------------------ the unconfirmed outcome writes its own record

/**
 * The residue #600 left: the reconcile machinery was live, but these composites
 * never CREATED a record for a timed-out run — so a keyed resubmission found
 * nothing and ran the whole verb again, minting a second occurrence. Each cell
 * here drives a real timeout through a leg, then resubmits the key.
 *
 * Two stall shapes, matching what the two legs can actually do:
 *  - the MINT is a GUI drive, so its ambiguous verdict is the watchdog abort
 *    (the CLI gave up first; a change committed at the last moment could still
 *    appear);
 *  - the status/update leg is an ordinary url-scheme write, so its ambiguous
 *    verdict is the pipeline's own: the row was touched, the asserted field
 *    never moved.
 */
describe("a composite that never confirmed records an ambiguous summary", () => {
  /** `Create Next Copy` killed by the GUI watchdog — nothing is minted. */
  function watchdogCnc(): { vector: WriteVector; state: { calls: number } } {
    const state = { calls: 0 };
    return {
      state,
      vector: {
        id: "ui",
        matrix: UI_MATRIX,
        async execute() {
          state.calls += 1;
          return {
            exitCode: 1,
            stdout: "",
            stderr: "budget blown",
            watchdog: {
              budgetMs: 90_000,
              elapsedMs: 91_000,
              lastStep: "choose Create Next Copy",
              clear: "dismissed" as const,
            },
          };
        },
      },
    };
  }

  /** A url-scheme write that TOUCHES the row without applying the change. */
  function stallingUrl(): { vector: WriteVector; payloads: string[] } {
    const payloads: string[] = [];
    return {
      payloads,
      vector: {
        id: "url-scheme",
        matrix: URL_MATRIX,
        async execute(inv: CompiledInvocation) {
          payloads.push(inv.payload);
          const uuid = new URL(inv.payload).searchParams.get("id");
          if (uuid !== null) {
            fixture.db
              .prepare("UPDATE TMTask SET userModificationDate = ? WHERE uuid = ?")
              .run(NOW_EPOCH + 9, uuid);
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
    };
  }

  const summaries = (): AuditRecord[] => auditRecords.filter((r) => r.txn?.role === "summary");
  const ambiguous = (): AuditRecord | undefined =>
    summaries().find((r) => r.result === "verify-failed:timeout");

  /** Seed the occurrence a landed-but-unconfirmed mint would have left. */
  function landedOccurrence(template: string, status: "open" | "completed"): string {
    return seedTodo(fixture.db, {
      title: "Water plants",
      repeatingTemplate: template,
      startDate: "2026-07-12",
      creationDate: NOW_EPOCH,
      ...(status === "completed" && { status, stopDate: NOW_EPOCH }),
    });
  }

  // ------------------------------------------------ complete/cancel: the mint

  it("an unconfirmed MINT records the probe it was making, extended to the status it promised", async () => {
    const { template } = seedSeries();
    const cnc = watchdogCnc();
    const result = await runCompleteWithDate(
      deps([stallingUrl().vector, cnc.vector], fastPoller()),
      "todo",
      template,
      {},
      { opId: "maybe-checked", verifyTimeoutMs: 0 },
    );

    expect(result.kind).toBe("verify-failed");
    expect(result.kind === "verify-failed" && result.reason).toBe("timeout");
    const record = ambiguous();
    expect(record?.opId).toBe("maybe-checked");
    expect(record?.observed, "an ambiguous summary observed nothing").toBeNull();
    // The occurrence's uuid is unknown at this point, so the oracle is the mint's
    // OWN time-bounded create probe — plus the status, because a resubmission
    // that stopped at "a copy exists" would report the series checked off when
    // only the copy had been made.
    expect(record?.expected).toMatchObject({
      mode: "create",
      probe: { title: "Water plants", type: "to-do" },
      assert: [
        { field: "repeating.templateUuid", equals: template },
        { field: "status", equals: "completed" },
      ],
    });
    const probe = (record?.expected as { probe?: { sinceEpoch: number } } | undefined)?.probe;
    expect(probe?.sinceEpoch, "an untime-bounded probe would read as unusable").toBeGreaterThan(0);
  });

  it("the occurrence landed AND was resolved after all → the retry replays, minting nothing", async () => {
    const { template } = seedSeries();
    await runCompleteWithDate(
      deps([stallingUrl().vector, watchdogCnc().vector], fastPoller()),
      "todo",
      template,
      {},
      { opId: "maybe-checked", verifyTimeoutMs: 0 },
    );
    const late = landedOccurrence(template, "completed");

    const cnc = cncVector(() => template);
    const retry = await runCompleteWithDate(
      deps([urlVector().vector, cnc.vector]),
      "todo",
      template,
      {},
      { opId: "maybe-checked" },
    );

    expect(retry.kind === "ok" && retry.alreadyApplied).toBe(true);
    expect(retry.kind === "ok" && retry.uuid, "the uuid comes from the re-read").toBe(late);
    expect(cnc.state.calls, "no second occurrence").toBe(0);
  });

  it("a BARE occurrence landed → the retry resolves that one, still minting nothing", async () => {
    // The dangerous middle case: the mint took but the status write never ran.
    // The oracle is unsatisfied, so the write runs — and the composite's
    // open-instance branch picks up the very occurrence the stalled call left.
    const { template } = seedSeries();
    await runCompleteWithDate(
      deps([stallingUrl().vector, watchdogCnc().vector], fastPoller()),
      "todo",
      template,
      {},
      { opId: "maybe-checked", verifyTimeoutMs: 0 },
    );
    const orphan = landedOccurrence(template, "open");

    const cnc = cncVector(() => template);
    const retry = await runCompleteWithDate(
      deps([urlVector().vector, cnc.vector]),
      "todo",
      template,
      {},
      { opId: "maybe-checked" },
    );

    expect(retry.kind).toBe("ok");
    expect(retry.kind === "ok" && retry.alreadyApplied, "it really ran").toBeUndefined();
    expect(cnc.state.calls, "the orphan is resolved, not duplicated").toBe(0);
    expect(statusOf(orphan)).toBe(3);
  });

  it("nothing landed → the retry runs the composite for real, exactly once", async () => {
    const { template } = seedSeries();
    await runCompleteWithDate(
      deps([stallingUrl().vector, watchdogCnc().vector], fastPoller()),
      "todo",
      template,
      {},
      { opId: "maybe-checked", verifyTimeoutMs: 0 },
    );

    const cnc = cncVector(() => template);
    const retry = await runCompleteWithDate(
      deps([urlVector().vector, cnc.vector]),
      "todo",
      template,
      {},
      { opId: "maybe-checked" },
    );

    expect(retry.kind).toBe("ok");
    expect(retry.kind === "ok" && retry.alreadyApplied).toBeUndefined();
    expect(cnc.state.calls).toBe(1);
    expect(statusOf(cnc.state.mintedUuids[0] as string)).toBe(3);
  });

  it("without a key nothing is recorded — there would be nothing to reconcile against", async () => {
    const { template } = seedSeries();
    await runCompleteWithDate(
      deps([stallingUrl().vector, watchdogCnc().vector], fastPoller()),
      "todo",
      template,
      {},
      { verifyTimeoutMs: 0 },
    );
    expect(summaries(), "the leg records already carry the failure").toHaveLength(0);
  });

  // ----------------------------------------- complete/cancel: the status leg

  it("an unconfirmed STATUS leg records the leg's own assertion against the occurrence", async () => {
    const { template, instance } = seedSeries({ withOpenInstance: true });
    const result = await runCancelWithDate(
      deps([stallingUrl().vector, cncVector(() => template).vector]),
      "todo",
      template,
      {},
      { opId: "maybe-canceled", verifyTimeoutMs: 0 },
    );

    expect(result.kind === "verify-failed" && result.reason).toBe("timeout");
    const record = ambiguous();
    expect(record?.opId).toBe("maybe-canceled");
    expect(record?.uuid, "the summary is addressed to the occurrence").toBe(instance);
    expect(record?.occurrence).toMatchObject({ occurrenceUuid: instance, minted: false });
    expect(record?.expected).toMatchObject({ uuid: instance });
    const asserted = (record?.expected as { assert?: unknown[] } | undefined)?.assert;
    expect(
      asserted?.length,
      "an assertion that names a field is what makes it reconcilable",
    ).toBeGreaterThan(0);
  });

  it("the status landed late → the retry replays it and dispatches nothing", async () => {
    const { template, instance } = seedSeries({ withOpenInstance: true });
    await runCancelWithDate(
      deps([stallingUrl().vector, cncVector(() => template).vector]),
      "todo",
      template,
      {},
      { opId: "maybe-canceled", verifyTimeoutMs: 0 },
    );
    fixture.db
      .prepare("UPDATE TMTask SET status = 2, stopDate = ? WHERE uuid = ?")
      .run(NOW_EPOCH, instance as string);

    const url = urlVector();
    const cnc = cncVector(() => template);
    const retry = await runCancelWithDate(
      deps([url.vector, cnc.vector]),
      "todo",
      template,
      {},
      { opId: "maybe-canceled" },
    );

    expect(retry.kind === "ok" && retry.alreadyApplied).toBe(true);
    expect(retry.kind === "ok" && retry.uuid).toBe(instance);
    expect(url.payloads, "nothing may be dispatched on a replay").toHaveLength(0);
    expect(cnc.state.calls).toBe(0);
  });

  // ----------------------------------------------------- update --exception

  it("an unconfirmed exception MINT records honestly, and the retry REFUSES rather than mint again", async () => {
    // This composite ALWAYS mints, so "not satisfied → run" would take a second
    // slot — and a mint that never confirmed is exactly the point at which the
    // patch is KNOWN not to have landed. Neither answer is available, so the
    // record names only the series (which this verb leaves byte-unchanged) and
    // the resubmission refuses.
    const { template } = seedSeries();
    const result = await runTemplateExceptionWrite(
      deps([stallingUrl().vector, watchdogCnc().vector], fastPoller()),
      template,
      { when: "2026-07-15" },
      { opId: "maybe-moved", verifyTimeoutMs: 0 },
    );

    expect(result.kind === "verify-failed" && result.reason).toBe("timeout");
    const record = ambiguous();
    expect(record?.opId).toBe("maybe-moved");
    expect(record?.expected).toEqual({ mode: "state", uuid: template, assert: [] });

    const cnc = cncVector(() => template);
    const retry = await runTemplateExceptionWrite(
      deps([urlVector().vector, cnc.vector]),
      template,
      { when: "2026-07-15" },
      { opId: "maybe-moved" },
    );

    expect(retry.kind).toBe("blocked");
    if (retry.kind !== "blocked") throw new Error("unreachable");
    expect(retry.reason).toBe("reconcile");
    expect(retry.detail).toContain("never confirmed");
    expect(retry.remediation).toContain("things op-result maybe-moved");
    expect(retry.remediation).toContain(template);
    expect(cnc.state.calls, "the refusal is what stops the blind re-mint").toBe(0);
  });

  it("an unconfirmed exception PATCH records the update leg's own assertion, and replays when it landed", async () => {
    // Here the slot is already spent and the occurrence is named, so the leg's
    // own assertion re-read against that row settles it.
    const { template } = seedSeries();
    const cnc = cncVector(() => template);
    const result = await runTemplateExceptionWrite(
      deps([stallingUrl().vector, cnc.vector]),
      template,
      { when: "2026-07-15" },
      { opId: "maybe-moved", verifyTimeoutMs: 0 },
    );

    expect(result.kind === "verify-failed" && result.reason).toBe("timeout");
    const minted = cnc.state.mintedUuids[0] as string;
    const record = ambiguous();
    expect(record?.uuid).toBe(minted);
    expect(record?.occurrence).toMatchObject({ occurrenceUuid: minted, minted: true });
    expect(record?.expected).toMatchObject({ uuid: minted });

    // The move landed late.
    fixture.db
      .prepare(
        "UPDATE TMTask SET startDate = ?, start = 2, todayIndexReferenceDate = ? WHERE uuid = ?",
      )
      .run(encode("2026-07-15"), encode("2026-07-15"), minted);

    const second = cncVector(() => template);
    const retry = await runTemplateExceptionWrite(
      deps([urlVector().vector, second.vector]),
      template,
      { when: "2026-07-15" },
      { opId: "maybe-moved" },
    );

    expect(retry.kind === "ok" && retry.alreadyApplied).toBe(true);
    expect(retry.kind === "ok" && retry.uuid).toBe(minted);
    expect(second.state.calls, "the series does not lose a second slot").toBe(0);
  });

  // --------------------------------------------------- the flip-dance itself

  it("a timed-out flip-dance leg records the sequence's own final assertion, and reconciles", async () => {
    const plain = seedTodo(fixture.db, { title: "Plain", startDate: "2026-07-05" });
    const result = await runCompleteWithDate(
      deps([stallingUrl().vector]),
      "todo",
      plain,
      { completedAt: "2026-07-01" },
      { opId: "maybe-backdated", verifyTimeoutMs: 0 },
    );

    expect(result.kind === "verify-failed" && result.reason).toBe("timeout");
    const record = ambiguous();
    expect(record?.opId).toBe("maybe-backdated");
    expect(record?.uuid).toBe(plain);
    expect(record?.expected).toEqual({
      mode: "state",
      uuid: plain,
      assert: [
        { field: "status", equals: "completed" },
        { field: "stoppedDate", equals: "2026-07-01" },
      ],
    });

    // The dance landed after all.
    const noonEpoch = Math.floor(new Date(2026, 6, 1, 12, 0, 0).getTime() / 1000);
    fixture.db
      .prepare("UPDATE TMTask SET status = 3, stopDate = ? WHERE uuid = ?")
      .run(noonEpoch, plain);

    const second = stallingUrl();
    const retry = await runCompleteWithDate(
      deps([second.vector]),
      "todo",
      plain,
      { completedAt: "2026-07-01" },
      { opId: "maybe-backdated" },
    );

    expect(retry.kind === "ok" && retry.alreadyApplied).toBe(true);
    expect(second.payloads, "the dance is not walked a second time").toHaveLength(0);
  });
});
