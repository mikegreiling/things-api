/**
 * The post-drive first-occurrence oracle (#508, extended by #625).
 *
 * A fixed series is normally read off the template's cursor
 * (`rt1_instanceCreationStartDate`). Two cases break that, both measured, both
 * false NEGATIVES — a correct series reported as a wrong-phase failure:
 *
 *   - #508: an AFTER-COMPLETION template is minted with no cursor at all, so
 *     the requested date lives on its materialized instance;
 *   - #625 (FGRD1 §8, golden-v4 / 3.23): when the requested first occurrence is
 *     TODAY, the app materializes it immediately and ADVANCES the cursor to the
 *     next slot — the cursor names next week while an instance sits on today.
 *
 * So the check accepts either oracle, and still refuses when NOTHING sits on
 * the requested day.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { encodePackedDate } from "../../src/model/dates.ts";
import { firstOccurrenceHonored } from "../../src/write/promote-clone.ts";
import type { WriteDeps } from "../../src/write/pipeline.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedTodo } from "../fixtures/seed.ts";

let fixture: FixtureDb;

beforeEach(() => {
  fixture = buildFixtureDb();
});
afterEach(() => fixture.close());

/** Only `db` is read by the oracle; the rest of WriteDeps is irrelevant here. */
const depsOf = (): WriteDeps => ({ db: fixture.db }) as unknown as WriteDeps;

/** A template row whose cursor points at `cursorIso` (or nowhere). */
function template(cursorIso: string | null): string {
  const uuid = seedTodo(fixture.db, { title: "Series", start: "active", recurrenceRule: true });
  if (cursorIso !== null) {
    fixture.db
      .prepare("UPDATE TMTask SET rt1_instanceCreationStartDate = ? WHERE uuid = ?")
      .run(encodePackedDate(cursorIso), uuid);
  }
  return uuid;
}

describe("firstOccurrenceHonored", () => {
  it("accepts the ordinary case: the cursor names the requested date", () => {
    const t = template("2026-07-12");
    const res = firstOccurrenceHonored(depsOf(), {
      templateUuid: t,
      instanceUuid: null,
      expectedIso: "2026-07-12",
      afterCompletion: false,
    });
    expect(res).toEqual({ honored: true, landed: "2026-07-12" });
  });

  it("accepts a SAME-DAY first occurrence: the cursor has moved on, an instance sits on the day", () => {
    const t = template("2026-07-12"); // advanced past today, as the app leaves it
    const instance = seedTodo(fixture.db, {
      title: "Series",
      start: "active",
      startDate: "2026-07-05",
    });
    const res = firstOccurrenceHonored(depsOf(), {
      templateUuid: t,
      instanceUuid: instance,
      expectedIso: "2026-07-05",
      afterCompletion: false,
    });
    expect(res.honored).toBe(true);
    // …and it still reports what the cursor said, for the disclosure.
    expect(res.landed).toBe("2026-07-12");
  });

  it("REFUSES when nothing sits on the requested day (a genuine wrong phase)", () => {
    const t = template("2026-07-12");
    const instance = seedTodo(fixture.db, {
      title: "Series",
      start: "active",
      startDate: "2026-07-12",
    });
    const res = firstOccurrenceHonored(depsOf(), {
      templateUuid: t,
      instanceUuid: instance,
      expectedIso: "2026-07-05",
      afterCompletion: false,
    });
    expect(res).toEqual({ honored: false, landed: "2026-07-12" });
  });

  it("REFUSES a fixed rule whose cursor is absent and which materialized nothing", () => {
    const res = firstOccurrenceHonored(depsOf(), {
      templateUuid: template(null),
      instanceUuid: null,
      expectedIso: "2026-07-05",
      afterCompletion: false,
    });
    expect(res).toEqual({ honored: false, landed: null });
  });

  it("skips an after-completion series with nothing materialized (#508: unverifiable, not wrong)", () => {
    const res = firstOccurrenceHonored(depsOf(), {
      templateUuid: template(null),
      instanceUuid: null,
      expectedIso: "2026-07-05",
      afterCompletion: true,
    });
    expect(res.honored).toBe(true);
  });

  it("verifies an after-completion series against its materialized instance", () => {
    const t = template(null);
    const instance = seedTodo(fixture.db, {
      title: "Series",
      start: "active",
      startDate: "2026-07-05",
    });
    expect(
      firstOccurrenceHonored(depsOf(), {
        templateUuid: t,
        instanceUuid: instance,
        expectedIso: "2026-07-05",
        afterCompletion: true,
      }).honored,
    ).toBe(true);
    expect(
      firstOccurrenceHonored(depsOf(), {
        templateUuid: t,
        instanceUuid: instance,
        expectedIso: "2026-08-01",
        afterCompletion: true,
      }).honored,
    ).toBe(false);
  });
});
