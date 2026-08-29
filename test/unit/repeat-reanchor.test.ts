/**
 * The SERIES RE-ANCHOR — `reschedule-repeat <ref> --when <date>` with no
 * frequency/interval (REANCH1, docs/lab/reanch1-url-reanchor.md; re-verified by
 * REANCH2). One `things:///update?when=` dispatch that moves a repeating
 * template's next occurrence and keeps its rule.
 *
 * Every refusal here is a MEASURED app failure, not a policy: a date that is not
 * strictly future kills the process (REANCH1 §5), so does the same write on an
 * after-completion template (§4.2), and a multi-weekday rule comes back firing on
 * days the caller never chose (§7). The cells cover the split (which spelling
 * rides which vector and which gate), the guards, and the read-back.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { localToday } from "../../src/model/dates.ts";
import { COMMANDS } from "../../src/write/commands.ts";
import { evaluateGuards, type GuardBlock } from "../../src/write/guards.ts";
import {
  isRepeatReanchor,
  type Acknowledgements,
  type OperationKind,
  type OperationParamsMap,
} from "../../src/write/operations.ts";
import { assertRescheduleRule } from "../../src/write/repeat-rule.ts";
import { urlReanchorSupported } from "../../src/write/experimental.ts";
import { rescheduleParamsFromOpts } from "../../src/cli/commands/repeat-flags.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedProject, seedTodo } from "../fixtures/seed.ts";

const FUTURE = "2099-04-16"; // a Thursday, comfortably ahead of any test clock
const PAST = "2000-01-01";
const TOKEN = "tok_123";

const ruleXml = (fu: number, offsets: string, tp = 0, ts = 0) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>fa</key><integer>1</integer>
  <key>fu</key><integer>${fu}</integer>
  <key>of</key><array>${offsets}</array>
  <key>rc</key><integer>0</integer>
  <key>rrv</key><integer>4</integer>
  <key>tp</key><integer>${tp}</integer>
  <key>ts</key><integer>${ts}</integer>
</dict>
</plist>`;

const wd = (n: number) => `<dict><key>wd</key><integer>${n}</integer></dict>`;
const WEEKLY_SUNDAY = ruleXml(256, wd(0));
const WEEKLY_MON_WED_FRI = ruleXml(256, `${wd(1)}${wd(3)}${wd(5)}`);
const DAILY = ruleXml(16, `<dict><key>dy</key><integer>0</integer></dict>`);
const AFTER_COMPLETION = ruleXml(256, "", 1);

let fixture: FixtureDb;

beforeEach(() => {
  fixture = buildFixtureDb();
});
afterEach(() => {
  fixture.close();
});

function seedTemplate(
  ruleXmlText = WEEKLY_SUNDAY,
  extra: { paused?: boolean; cursor?: string | null } = {},
): string {
  return seedTodo(fixture.db, {
    title: "Water plants",
    recurrenceRuleXml: ruleXmlText,
    nextInstanceStartDate: extra.cursor === undefined ? "2026-07-12" : extra.cursor,
    instanceCreationStartDate: extra.cursor === undefined ? "2026-07-12" : extra.cursor,
    instanceCreationCount: 1,
    ...(extra.paused === true && { instanceCreationPaused: true }),
  });
}

function check<K extends OperationKind>(
  op: K,
  params: OperationParamsMap[K],
  acks: Acknowledgements = {},
): GuardBlock | null {
  const spec = COMMANDS[op];
  const pre = spec.preRead(fixture.db, params, new Date());
  return evaluateGuards(spec.hazards, {
    op,
    params: params as Record<string, unknown>,
    pre,
    acks,
  });
}

describe("the two spellings of reschedule-repeat", () => {
  it("a bare date is a re-anchor; a stated rule is not", () => {
    expect(isRepeatReanchor({ uuid: "T", next: FUTURE })).toBe(true);
    expect(isRepeatReanchor({ uuid: "T", frequency: "weekly", interval: 1, next: FUTURE })).toBe(
      false,
    );
    expect(isRepeatReanchor({ uuid: "T", frequency: "weekly", interval: 1 })).toBe(false);
  });

  it("validation accepts both shapes and refuses the halves", () => {
    expect(() => assertRescheduleRule({ next: FUTURE })).not.toThrow();
    expect(() => assertRescheduleRule({ frequency: "weekly", interval: 2 })).not.toThrow();
    // Half a rule.
    expect(() => assertRescheduleRule({ frequency: "weekly" })).toThrow(
      /frequency and an interval/,
    );
    expect(() => assertRescheduleRule({ interval: 2 })).toThrow(/frequency and an interval/);
    // Nothing at all.
    expect(() => assertRescheduleRule({})).toThrow(/nothing to change/);
    // A rule field WITHOUT a rule: refused, never silently dropped — the url
    // carries the date and nothing else.
    expect(() => assertRescheduleRule({ next: FUTURE, weekdays: ["monday"] })).toThrow(
      /--weekdays/,
    );
    expect(() => assertRescheduleRule({ next: FUTURE, deadline: true })).toThrow(/--deadline/);
    expect(() => assertRescheduleRule({ next: "16/04/2099" })).toThrow(/YYYY-MM-DD/);
  });

  it("the CLI mapper splits them, and refuses a rule flag with no rule", () => {
    expect(rescheduleParamsFromOpts("T", { when: FUTURE })).toEqual({
      kind: "ok",
      params: { uuid: "T", next: FUTURE },
    });
    expect(rescheduleParamsFromOpts("T", { frequency: "weekly", interval: "2" })).toEqual({
      kind: "ok",
      params: { uuid: "T", frequency: "weekly", interval: 2 },
    });
    const flagged = rescheduleParamsFromOpts("T", { when: FUTURE, weekdays: "monday" });
    expect(flagged.kind).toBe("error");
    if (flagged.kind === "error") expect(flagged.message).toContain("--weekdays");
    const half = rescheduleParamsFromOpts("T", { frequency: "weekly", when: FUTURE });
    expect(half.kind).toBe("error");
    if (half.kind === "error") expect(half.message).toContain("go together");
    const empty = rescheduleParamsFromOpts("T", {});
    expect(empty.kind).toBe("error");
    if (empty.kind === "error") expect(empty.message).toContain("nothing to change");
  });
});

describe("vector + gate routing", () => {
  it("a re-anchor plans onto the url scheme, a rule restatement onto the GUI", () => {
    const spec = COMMANDS["todo.reschedule-repeat"];
    expect(spec.vectorsFor?.({ uuid: "T", next: FUTURE })).toEqual(["url-scheme"]);
    expect(spec.vectorsFor?.({ uuid: "T", frequency: "daily", interval: 1 })).toEqual(["ui"]);
  });

  it("the re-anchor compiles to a BARE dated url — no deadline rides along", () => {
    // REANCH2 D6/E1/E3/E4: ANY deadline= in the same url voids the whole write
    // on a template, re-anchor included.
    const inv = COMMANDS["todo.reschedule-repeat"].compile(
      { uuid: "TMPL-1", next: FUTURE },
      "url-scheme",
      COMMANDS["todo.reschedule-repeat"].preRead(
        fixture.db,
        { uuid: "TMPL-1", next: FUTURE },
        new Date(),
      ),
      { token: TOKEN },
    );
    expect(inv.vector).toBe("url-scheme");
    expect(inv.payload).toBe(`things:///update?id=TMPL-1&when=${FUTURE}&auth-token=${TOKEN}`);
    expect(inv.payload).not.toContain("deadline");
    expect(inv.redactedPayload).toContain("auth-token=REDACTED");
  });

  it("a project re-anchor takes the project route (the to-do route no-ops on a project row)", () => {
    const inv = COMMANDS["project.reschedule-repeat"].compile(
      { uuid: "PROJ-1", next: FUTURE },
      "url-scheme",
      COMMANDS["project.reschedule-repeat"].preRead(
        fixture.db,
        { uuid: "PROJ-1", next: FUTURE },
        new Date(),
      ),
      { token: TOKEN },
    );
    expect(inv.payload).toContain("things:///update-project?id=PROJ-1");
  });

  it("the GUI-drive gate rides the SPELLING: the re-anchor needs no acknowledgement", () => {
    const uuid = seedTemplate();
    expect(check("todo.reschedule-repeat", { uuid, next: FUTURE })).toBeNull();
    expect(check("todo.reschedule-repeat", { uuid, frequency: "daily", interval: 1 })?.hazard).toBe(
      "H-UI-DRIVE",
    );
    expect(
      check(
        "todo.reschedule-repeat",
        { uuid, frequency: "daily", interval: 1 },
        { dangerouslyDriveGui: true },
      ),
    ).toBeNull();
  });

  it("the version gate reads the app version and fails CLOSED on an unknown one", () => {
    expect(urlReanchorSupported("3.23")).toBe(true);
    expect(urlReanchorSupported("3.23.1")).toBe(true);
    expect(urlReanchorSupported("4.0")).toBe(true);
    expect(urlReanchorSupported("3.22.14")).toBe(false);
    expect(urlReanchorSupported(null)).toBe(false);
    expect(urlReanchorSupported("unreadable")).toBe(false);
  });
});

describe("H-REPEAT-REANCHOR — the measured edges", () => {
  it("refuses a date that is not strictly after today (REANCH1 §5: it kills the app)", () => {
    const uuid = seedTemplate();
    // The guard's boundary is the DEVICE-LOCAL calendar day (pre.todayIso via
    // localToday) — deriving "today" in UTC made this flake on any host whose
    // local date trails UTC (fails every evening in the Americas).
    const today = localToday(new Date());
    expect(check("todo.reschedule-repeat", { uuid, next: today })?.hazard).toBe(
      "H-REPEAT-REANCHOR",
    );
    expect(check("todo.reschedule-repeat", { uuid, next: today })?.detail).toContain("today");
    expect(check("todo.reschedule-repeat", { uuid, next: PAST })?.detail).toContain("in the past");
  });

  it("refuses an after-completion series (REANCH1 §4.2, oddities §15)", () => {
    const uuid = seedTemplate(AFTER_COMPLETION, { cursor: null });
    const block = check("todo.reschedule-repeat", { uuid, next: FUTURE });
    expect(block?.hazard).toBe("H-REPEAT-REANCHOR");
    expect(block?.detail).toContain("AFTER each occurrence is completed");
  });

  it("refuses a MULTI-weekday rule (REANCH1 §7, oddities §16)", () => {
    const uuid = seedTemplate(WEEKLY_MON_WED_FRI);
    const block = check("todo.reschedule-repeat", { uuid, next: FUTURE });
    expect(block?.hazard).toBe("H-REPEAT-REANCHOR");
    expect(block?.detail).toContain("3 days of the week");
    expect(block?.remediation).toContain("--weekdays");
  });

  it("refuses a PAUSED series (unmeasured — fail closed)", () => {
    const uuid = seedTemplate(WEEKLY_SUNDAY, { paused: true, cursor: null });
    const block = check("todo.reschedule-repeat", { uuid, next: FUTURE });
    expect(block?.hazard).toBe("H-REPEAT-REANCHOR");
    expect(block?.remediation).toContain("resume-repeat");
  });

  it("refuses a NON-repeating target — the same url would silently re-schedule it", () => {
    const uuid = seedTodo(fixture.db, { title: "Plain", start: "active" });
    const block = check("todo.reschedule-repeat", { uuid, next: FUTURE });
    expect(block?.hazard).toBe("H-REPEAT-REANCHOR");
    expect(block?.remediation).toContain("--when");
  });

  it("lets a single-weekday fixed series through, to-do and project alike", () => {
    const todo = seedTemplate();
    expect(check("todo.reschedule-repeat", { uuid: todo, next: FUTURE })).toBeNull();
    const proj = seedProject(fixture.db, {
      title: "Weekly review",
      recurrenceRuleXml: WEEKLY_SUNDAY,
      nextInstanceStartDate: "2026-07-12",
      instanceCreationStartDate: "2026-07-12",
    });
    expect(check("project.reschedule-repeat", { uuid: proj, next: FUTURE })).toBeNull();
  });

  it("routes by row type: a to-do verb aimed at a project row is refused", () => {
    const proj = seedProject(fixture.db, {
      title: "Weekly review",
      recurrenceRuleXml: WEEKLY_SUNDAY,
      nextInstanceStartDate: "2026-07-12",
    });
    expect(check("todo.reschedule-repeat", { uuid: proj, next: FUTURE })?.hazard).toBe(
      "H-UNKNOWN-DESTINATION",
    );
  });
});

describe("the read-back (REANCH1 §8: BOTH cursors + the rule)", () => {
  it("asserts both cursor columns and the rule the target date implies", () => {
    const uuid = seedTemplate(DAILY);
    const spec = COMMANDS["todo.reschedule-repeat"];
    const params = { uuid, next: FUTURE };
    const pre = spec.preRead(fixture.db, params, new Date());
    const delta = spec.expectedDelta(pre, params, { nowEpoch: 0, todayIso: "2026-07-05" });
    expect(delta.mode).toBe("update");
    if (delta.mode !== "update") throw new Error("expected an update delta");
    const asserts = delta.assert ?? [];
    const fields = asserts.map((a) => a.field);
    expect(fields).toContain("repeating.nextOccurrence");
    expect(fields).toContain("repeating.spawnCursor");
    expect(fields).toContain("repeating.rule.unit");
    expect(fields).toContain("repeating.rule.interval");
    expect(fields).toContain("repeating.rule.type");
    // The rule is KEPT: a daily series stays daily at its interval.
    expect(asserts).toContainEqual({ field: "repeating.rule.unit", equals: "daily" });
    expect(asserts).toContainEqual({ field: "repeating.nextOccurrence", equals: FUTURE });
    expect(asserts).toContainEqual({ field: "repeating.spawnCursor", equals: FUTURE });
  });

  it("a WEEKLY series' expected anchor moves to the target date's weekday", () => {
    const uuid = seedTemplate(WEEKLY_SUNDAY);
    const spec = COMMANDS["todo.reschedule-repeat"];
    const params = { uuid, next: FUTURE }; // a Thursday
    const pre = spec.preRead(fixture.db, params, new Date());
    const delta = spec.expectedDelta(pre, params, { nowEpoch: 0, todayIso: "2026-07-05" });
    if (delta.mode !== "update") throw new Error("expected an update delta");
    // anchorKey is the canonical, order-insensitive rendering of the offsets —
    // Thursday is weekday 4, not the seeded Sunday 0.
    const anchor = (delta.assert ?? []).find((a) => a.field === "repeating.rule.anchorKey");
    expect(anchor).toBeDefined();
    expect(String(anchor?.equals)).toContain("w4");
  });
});
