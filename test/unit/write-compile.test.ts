import { describe, expect, it } from "vitest";
import { COMMANDS } from "../../src/write/commands.ts";
import { emptyPreState } from "../../src/write/pre-state.ts";
import { escapeAppleScript } from "../../src/write/vectors/applescript.ts";

const TOKEN = "sEcReT-token_123";

describe("URL compilation goldens", () => {
  it("todo.add: percent-encoding, tag list, checklist newlines, container + heading", () => {
    const pre = emptyPreState();
    pre.destProject = { resolved: { uuid: "PROJ-1", title: "My Project" }, matches: 1 };
    pre.destHeading = { resolved: { uuid: "HEAD-1", title: "Phase Å" }, matches: 1 };
    const inv = COMMANDS["todo.add"].compile(
      {
        title: "Fix the café ☕ & more",
        notes: "line1\nline2",
        when: "today",
        tags: ["prio", "high"],
        checklistItems: ["Alpha", "Bravo"],
        project: { title: "My Project" },
        heading: "Phase Å",
      },
      "url-scheme",
      pre,
      { token: TOKEN },
    );
    expect(inv.kind).toBe("open-url");
    expect(inv.payload).toContain("things:///add?");
    expect(inv.payload).toContain("title=Fix%20the%20caf%C3%A9%20%E2%98%95%20%26%20more");
    expect(inv.payload).toContain("notes=line1%0Aline2");
    expect(inv.payload).toContain("when=today");
    expect(inv.payload).toContain("tags=prio%2Chigh");
    expect(inv.payload).toContain("checklist-items=Alpha%0ABravo");
    expect(inv.payload).toContain("list-id=PROJ-1");
    expect(inv.payload).toContain("heading=Phase%20%C3%85");
    expect(inv.payload).toContain(`auth-token=${TOKEN}`);
    expect(inv.redactedPayload).toContain("auth-token=REDACTED");
    expect(inv.redactedPayload).not.toContain(TOKEN);
  });

  it("todo.update: token present in payload, never in redacted form", () => {
    const inv = COMMANDS["todo.update"].compile(
      { uuid: "ABC", title: "New" },
      "url-scheme",
      emptyPreState(),
      { token: TOKEN },
    );
    expect(inv.payload).toBe(`things:///update?id=ABC&title=New&auth-token=${TOKEN}`);
    expect(inv.redactedPayload).toBe("things:///update?id=ABC&title=New&auth-token=REDACTED");
  });

  it("project.complete compiles to update-project completed=true", () => {
    const inv = COMMANDS["project.complete"].compile(
      { uuid: "P1", children: "auto-complete" },
      "url-scheme",
      emptyPreState(),
      { token: TOKEN },
    );
    expect(inv.payload).toContain("things:///update-project?id=P1&completed=true");
  });

  it("no token → no auth-token parameter at all", () => {
    const inv = COMMANDS["todo.add"].compile({ title: "T" }, "url-scheme", emptyPreState(), {
      token: null,
    });
    expect(inv.payload).toBe("things:///add?title=T");
  });
});

describe("AppleScript compilation goldens", () => {
  it("escapes quotes and backslashes in string literals", () => {
    expect(escapeAppleScript('say "hi" \\ bye')).toBe('say \\"hi\\" \\\\ bye');
  });

  it("todo.delete targets by id", () => {
    const inv = COMMANDS["todo.delete"].compile({ uuid: "U-1" }, "applescript", emptyPreState(), {
      token: null,
    });
    expect(inv.payload).toBe('tell application "Things3" to delete to do id "U-1"');
  });

  it("tag.add with parent emits a two-statement tell block", () => {
    const pre = emptyPreState();
    pre.parentTag = { resolved: { uuid: "TAG-P", title: "prio" }, matches: 1 };
    const inv = COMMANDS["tag.add"].compile(
      { title: 'urgent "now"', parent: "prio" },
      "applescript",
      pre,
      {
        token: null,
      },
    );
    expect(inv.payload).toContain('make new tag with properties {name:"urgent \\"now\\""}');
    expect(inv.payload).toContain('set parent tag of tag "urgent \\"now\\"" to tag "prio"');
  });

  it("todo status setters use the validated status forms", () => {
    const inv = COMMANDS["todo.reopen"].compile({ uuid: "U-2" }, "applescript", emptyPreState(), {
      token: null,
    });
    expect(inv.payload).toBe('tell application "Things3" to set status of to do id "U-2" to open');
  });

  it("trash.empty compiles to the bare command", () => {
    const inv = COMMANDS["trash.empty"].compile({}, "applescript", emptyPreState(), {
      token: null,
    });
    expect(inv.payload).toBe('tell application "Things3" to empty trash');
  });

  it("URL-only operations refuse to compile for applescript and vice versa", () => {
    expect(() =>
      COMMANDS["todo.replace-checklist"].compile(
        { uuid: "X", items: ["a"] },
        "applescript",
        emptyPreState(),
        { token: null },
      ),
    ).toThrow(/cannot be compiled/);
    expect(() =>
      COMMANDS["area.add"].compile({ title: "A" }, "url-scheme", emptyPreState(), { token: null }),
    ).toThrow(/cannot be compiled/);
  });
});
