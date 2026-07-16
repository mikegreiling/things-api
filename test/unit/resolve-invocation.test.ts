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
      if (kw === "evening") {
        // The section sugar expands to a command PLUS its flag.
        expect(r.argv).toEqual(["today", "--evening"]);
        expect(r.canonical).toBe("things today --evening");
      } else {
        expect(r.argv, kw).toEqual([kw]);
        expect(r.canonical, kw).toBe(`things ${kw}`);
      }
    }
  });

  it("`evening` is a section sugar: `show evening` and bare `evening` → today --evening", () => {
    for (const argv of [["show", "evening"], ["evening"]]) {
      const r = resolve(argv);
      expect(r.form, argv.join(" ")).toBe("show-keyword");
      expect(r.argv, argv.join(" ")).toEqual(["today", "--evening"]);
      expect(r.canonical, argv.join(" ")).toBe("things today --evening");
      expect(r.ref, argv.join(" ")).toBe("evening");
    }
    // Case-insensitive, and trailing flags pass through after the expansion.
    expect(resolve(["Evening", "--json"]).argv).toEqual(["today", "--evening", "--json"]);
    expect(resolve(["show", "evening", "--limit", "5"]).argv).toEqual([
      "today",
      "--evening",
      "--limit",
      "5",
    ]);
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

  it("leading global flags are skipped: `--json <noun>` routes like `<noun> --json`", () => {
    const r = resolve(["--json", "Hobbies"]);
    expect(r.form).toBe("bare-noun");
    expect(r.argv).toEqual(["show", "--json", "Hobbies"]);
    expect(r.ref).toBe("Hobbies");
  });

  it("a value-taking leading flag skips its value too (never misread as the noun)", () => {
    const r = resolve(["--db", "/tmp/x.sqlite", "Hobbies"]);
    expect(r.form).toBe("bare-noun");
    expect(r.argv).toEqual(["show", "--db", "/tmp/x.sqlite", "Hobbies"]);
    expect(r.ref).toBe("Hobbies");
    // --db=<value> single-token form too.
    expect(resolve(["--db=/tmp/x.sqlite", "Hobbies"]).ref).toBe("Hobbies");
    // The flag's value alone is never a subject.
    expect(resolve(["--db", "/tmp/x.sqlite"]).form).toBe("canonical");
  });

  it("mixed leading flags find the noun; trailing flags still pass through", () => {
    const r = resolve(["--json", "--db", "/tmp/x.sqlite", "Hobbies", "--show-later"]);
    expect(r.form).toBe("bare-noun");
    expect(r.argv).toEqual(["show", "--json", "--db", "/tmp/x.sqlite", "Hobbies", "--show-later"]);
    expect(r.ref).toBe("Hobbies");
  });

  it("canary: a flags-only argv stays canonical and untouched", () => {
    for (const argv of [["--json"], ["--json", "--db", "/tmp/x.sqlite"], ["--help"]]) {
      const r = resolve(argv);
      expect(r.form, argv.join(" ")).toBe("canonical");
      expect(r.argv).toEqual(argv);
    }
  });

  it("an unknown leading flag keeps the plain fall-through (no guessing at values)", () => {
    const r = resolve(["--verbose", "Hobbies"]);
    expect(r.form).toBe("canonical");
    expect(r.argv).toEqual(["--verbose", "Hobbies"]);
  });

  it("a registered command reached through leading flags stays untouched", () => {
    const r = resolve(["--json", "inbox"]);
    expect(r.form).toBe("canonical");
    expect(r.argv).toEqual(["--json", "inbox"]);
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

describe("namespace implied-show — `things <type> <subject>`", () => {
  it("omits the show verb inside area/project/todo, canonical known at resolve time", () => {
    const r = resolve(["area", "hobbies"]);
    expect(r.form).toBe("namespace-show");
    expect(r.argv).toEqual(["area", "show", "hobbies"]);
    expect(r.canonical).toBe("things area show hobbies");
    expect(r.ref).toBe("hobbies");

    expect(resolve(["project", "Firmware"]).argv).toEqual(["project", "show", "Firmware"]);
    expect(resolve(["todo", "a1b2c3d4"]).argv).toEqual(["todo", "show", "a1b2c3d4"]);
  });

  it("quotes a multi-word subject in the canonical echo", () => {
    const r = resolve(["project", "Website redesign"]);
    expect(r.canonical).toBe('things project show "Website redesign"');
  });

  it("registered verbs always win over the sugar (reserved-word rule)", () => {
    for (const argv of [
      ["area", "show", "Hobbies"],
      ["area", "add", "New"],
      ["project", "complete", "x"],
      ["todo", "update", "x"],
    ]) {
      const r = resolve(argv);
      expect(r.form, argv.join(" ")).toBe("canonical");
      expect(r.argv).toEqual(argv);
    }
  });

  it("does not fire on config (a non-type group whose show takes no ref)", () => {
    const r = resolve(["config", "foo"]);
    expect(r.form).toBe("canonical");
    expect(r.argv).toEqual(["config", "foo"]);
  });

  it("a bare group name (no subject) or a flag stays canonical for commander", () => {
    expect(resolve(["area"]).form).toBe("canonical");
    expect(resolve(["area", "--json"]).form).toBe("canonical");
  });

  it("trailing flags pass through after the implied subject", () => {
    const r = resolve(["area", "hobbies", "--show-later", "--json"]);
    expect(r.argv).toEqual(["area", "show", "hobbies", "--show-later", "--json"]);
  });
});

describe("plural collection synonym — `things projects <ref>` / `things areas <ref>`", () => {
  it("a ref after the plural echoes the canonical SINGULAR show, argv keeps the ref", () => {
    const r = resolve(["projects", "Astro City"]);
    expect(r.form).toBe("namespace-show");
    expect(r.argv).toEqual(["projects", "Astro City"]);
    expect(r.canonical).toBe('things project show "Astro City"');
    expect(r.ref).toBe("Astro City");

    const a = resolve(["areas", "Hobbies"]);
    expect(a.canonical).toBe("things area show Hobbies");
    expect(a.argv).toEqual(["areas", "Hobbies"]);
  });

  it("forgives an explicit `show` verb, dropping it so one ref positional remains", () => {
    const r = resolve(["projects", "show", "Astro City"]);
    expect(r.form).toBe("namespace-show");
    expect(r.argv).toEqual(["projects", "Astro City"]);
    expect(r.canonical).toBe('things project show "Astro City"');

    expect(resolve(["areas", "show", "Hobbies"]).argv).toEqual(["areas", "Hobbies"]);
    expect(resolve(["areas", "show", "Hobbies"]).canonical).toBe("things area show Hobbies");
  });

  it("trailing flags pass through after the ref", () => {
    expect(resolve(["projects", "Astro City", "--show-later", "--json"]).argv).toEqual([
      "projects",
      "Astro City",
      "--show-later",
      "--json",
    ]);
    expect(resolve(["areas", "show", "Hobbies", "--all"]).argv).toEqual([
      "areas",
      "Hobbies",
      "--all",
    ]);
  });

  it("a bare plural (list form) or a flag-led one stays canonical — echo-free", () => {
    for (const argv of [["projects"], ["areas"], ["projects", "--json"], ["areas", "--all"]]) {
      const r = resolve(argv);
      expect(r.form, argv.join(" ")).toBe("canonical");
      expect(r.argv).toEqual(argv);
      expect(r.canonical).toBeNull();
    }
  });
});

describe("top-level mutation verbs → verb-hint (Part 3)", () => {
  it("a bare mutation verb is classified verb-hint, not show-sugar", () => {
    for (const verb of ["update", "add", "create", "delete", "complete", "cancel", "move"]) {
      const r = resolve([verb, "health"]);
      expect(r.form, verb).toBe("verb-hint");
      expect(r.ref, verb).toBe(verb);
      // argv is the original tokens, untouched — the handler re-parses them.
      expect(r.argv, verb).toEqual([verb, "health"]);
    }
  });

  it("a mutation verb with no ref is still verb-hint", () => {
    expect(resolve(["update"]).form).toBe("verb-hint");
    expect(resolve(["delete"]).form).toBe("verb-hint");
  });

  it("catalog-exposed verbs (not just the common set) are reserved too", () => {
    for (const verb of ["duplicate", "restore", "reopen", "rename", "archive", "make-repeating"]) {
      expect(resolve([verb, "x"]).form, verb).toBe("verb-hint");
    }
  });

  it("verb-hint fires through leading global flags", () => {
    const r = resolve(["--json", "update", "health"]);
    expect(r.form).toBe("verb-hint");
    expect(r.ref).toBe("update");
    expect(r.argv).toEqual(["--json", "update", "health"]);
  });

  it("registered top-level commands still win over the verb reservation", () => {
    // `tags` is the list view, not the write verb — precedence 1 keeps it.
    expect(resolve(["tags"]).form).toBe("canonical");
    expect(resolve(["today"]).form).toBe("canonical");
  });

  it("reserved-word trade-off: a bare noun that IS a verb can no longer be shown", () => {
    // An item literally named "update" is unreachable via bare `things update`
    // (it routes to the write hint); the full `things area show update` still
    // works — documented in docs/design/cli-grammar.md.
    expect(resolve(["update"]).form).toBe("verb-hint");
    expect(resolve(["area", "show", "update"]).form).toBe("canonical");
  });

  it("a non-verb bare noun still routes through show", () => {
    expect(resolve(["Hobbies"]).form).toBe("bare-noun");
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
