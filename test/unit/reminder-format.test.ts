/**
 * The TTY reminder chip is 12-hour `h:mmam/pm` (Mike's fixed preference — no
 * locale detection); the wire keeps the machine 24h `HH:MM` unchanged.
 */
import { describe, expect, it } from "vitest";

import { formatReminderTime } from "../../src/cli/glyphs.ts";

describe("formatReminderTime (12-hour TTY chip)", () => {
  it("maps 24h to h:mmam/pm with noon/midnight corners", () => {
    expect(formatReminderTime("00:00")).toBe("12:00am"); // midnight
    expect(formatReminderTime("09:00")).toBe("9:00am");
    expect(formatReminderTime("09:05")).toBe("9:05am");
    expect(formatReminderTime("11:59")).toBe("11:59am");
    expect(formatReminderTime("12:00")).toBe("12:00pm"); // noon
    expect(formatReminderTime("13:30")).toBe("1:30pm");
    expect(formatReminderTime("18:00")).toBe("6:00pm");
    expect(formatReminderTime("23:45")).toBe("11:45pm");
  });
});
