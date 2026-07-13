/**
 * The command router (src/cli/resolve-invocation.ts): the precedence chain
 * (registered command/alias → view keyword → reference), argv normalization
 * for every sugar form, and the invocation context that carries the canonical
 * command to the renderer. Pure classification — no database.
 */
import { describe, expect, it } from "vitest";

import { buildProgram } from "../../src/cli/main.ts";
import {
  getInvocation,
  OPEN_KEYWORDS,
  resolveInvocation,
  setInvocationCanonical,
  SHOW_KEYWORDS,
} from "../../src/cli/resolve-invocation.ts";

const program = buildProgram();
const resolve = (argv: string[]) => resolveInvocation(program, argv);

describe("precedence 1 — registered commands/aliases always win", () => {
  it("a registered command is canonical and passes through untouched", () => {
    for (const argv of [["inbox"], ["today", "--json"], ["areas"], ["tags"], ["projects"]]) {
      const r = resolve(argv);
      expect(r.form, argv.join(" ")).toBe("canonical");
      expect(r.argv).toEqual(argv);
      expect(r.canonical).toBeNull();
    }
  });

  it("typed type-verb commands are canonical (no normalization)", () => {
    const r = resolve(["area", "show", "Hobbies"]);
    expect(r.form).toBe("canonical");
    expect(r.argv).toEqual(["area", "show", "Hobbies"]);
    expect(r.canonical).toBeNull();
  });

  it("a flag-led or empty argv is left for commander", () => {
    expect(resolve(["--help"]).form).toBe("canonical");
    expect(resolve([]).form).toBe("canonical");
    expect(resolve(["--version"]).argv).toEqual(["--version"]);
  });
});

describe("precedence 2 — view keywords inside show", () => {
  it("every SHOW keyword dispatches to the identical command, canonical known", () => {
    for (const kw of SHOW_KEYWORDS) {
      const r = resolve(["show", kw]);
      expect(r.form, kw).toBe("show-keyword");
      expect(r.argv, kw).toEqual([kw]);
      expect(r.canonical, kw).toBe(`things ${kw}`);
    }
  });

  it("show keywords carry the view's own flags through", () => {
    const r = resolve(["show", "someday", "--area-limit", "5", "--json"]);
    expect(r.form).toBe("show-keyword");
    expect(r.argv).toEqual(["someday", "--area-limit", "5", "--json"]);
    expect(r.canonical).toBe("things someday");
  });

  it("the plural collection names are show keywords (projects/areas/tags)", () => {
    for (const kw of ["projects", "areas", "tags"]) {
      expect(SHOW_KEYWORDS.has(kw)).toBe(true);
      expect(resolve(["show", kw]).argv).toEqual([kw]);
    }
  });

  it("keyword matching is case-insensitive and normalizes to lower-case", () => {
    expect(resolve(["show", "Anytime"]).argv).toEqual(["anytime"]);
    expect(resolve(["show", "INBOX"]).canonical).toBe("things inbox");
  });

  it("the two vocabularies are deliberately asymmetric", () => {
    // open's vocabulary is only the app's URL-scheme ids; the plurals are not.
    expect([...OPEN_KEYWORDS]).toEqual(
      expect.arrayContaining([
        "inbox",
        "today",
        "anytime",
        "upcoming",
        "someday",
        "logbook",
        "trash",
      ]),
    );
    for (const plural of ["projects", "areas", "tags"])
      expect(OPEN_KEYWORDS.has(plural)).toBe(false);
  });
});

describe("precedence 3 — references", () => {
  it("a non-command bare noun routes through show, verb inserted", () => {
    const r = resolve(["Hobbies"]);
    expect(r.form).toBe("bare-noun");
    expect(r.argv).toEqual(["show", "Hobbies"]);
    expect(r.ref).toBe("Hobbies");
  });

  it("bare-noun flags pass through in order", () => {
    expect(resolve(["Hobbies", "--show-later", "--json"]).argv).toEqual([
      "show",
      "Hobbies",
      "--show-later",
      "--json",
    ]);
  });

  it("an explicit `show <ref>` is a loose-show, argv unchanged", () => {
    const r = resolve(["show", "Firmware"]);
    expect(r.form).toBe("loose-show");
    expect(r.argv).toEqual(["show", "Firmware"]);
    expect(r.ref).toBe("Firmware");
  });

  it("`open <ref>` is a loose-open (keyword handling deferred to the action)", () => {
    const r = resolve(["open", "Hobbies"]);
    expect(r.form).toBe("loose-open");
    expect(r.ref).toBe("Hobbies");
  });
});

describe("invocation context", () => {
  it("records the current invocation and lets the action fill in canonical", () => {
    resolve(["Hobbies"]);
    expect(getInvocation()?.form).toBe("bare-noun");
    expect(getInvocation()?.canonical).toBeNull();
    setInvocationCanonical('things area show "Hobbies"');
    expect(getInvocation()?.canonical).toBe('things area show "Hobbies"');
  });

  it("re-resolving replaces the context (no cross-invocation leakage)", () => {
    resolve(["Hobbies"]);
    setInvocationCanonical('things area show "Hobbies"');
    resolve(["inbox"]);
    expect(getInvocation()?.form).toBe("canonical");
    expect(getInvocation()?.canonical).toBeNull();
  });
});
