/**
 * The single command router (docs/design/cli-grammar.md). Takes raw user argv
 * (already stripped of the node/script prefix) and applies the precedence
 * chain — registered command/alias → view keyword → reference — returning a
 * normalized dispatch that `main.ts` feeds to commander. This replaces the
 * former `expandShorthand` argv hack, the per-command keyword rewrites, and
 * the hidden `--via-shorthand` marker.
 *
 * The resolver is argv-level and NEVER touches the database: it decides the
 * command SHAPE. Reference resolution (uuid prefix → share link → tiered name
 * match) happens later in `classifyShowTarget`, which needs the db. When a
 * form's canonical command is only knowable after that resolution (bare noun,
 * uuid/share-link routing), the `show`/`open` action fills `canonical` in via
 * `setInvocationCanonical`; the view-keyword rewrite knows it immediately.
 */
import type { Command } from "commander";

import { shellQuote } from "./shell-quote.ts";

/**
 * The type namespaces whose `show` verb takes a reference and may be omitted:
 * `things area Hobbies` → `things area show Hobbies`. Restricted to the three
 * TYPE groups — `config show` also exists but takes no reference, so `config`
 * is deliberately excluded. Registered subcommands (verbs) always win over
 * this sugar (the reserved-word rule).
 */
export const IMPLIED_SHOW_NAMESPACES = new Set(["area", "project", "todo"]);

/**
 * `show`'s keyword vocabulary: EVERY list-view command name, PLUS the section
 * sugars in {@link KEYWORD_EXPANSIONS}. `things show <kw>` (and the bare
 * `things <kw>`) dispatches to the identical `things <kw>` command — except the
 * expansion keywords, which route to a command PLUS flags. Wider than the app's
 * URL ids because `show` renders our own views — the plurals are real commands
 * too, and `evening` is the This-Evening slice of Today.
 */
export const SHOW_KEYWORDS = new Set([
  "inbox",
  "today",
  "anytime",
  "upcoming",
  "someday",
  "logbook",
  "trash",
  "projects",
  "areas",
  "tags",
  "evening",
]);

/**
 * SHOW_KEYWORDS that are NOT a same-named command but a section/filter sugar:
 * they expand to a real command PLUS flags. `evening` is the This-Evening
 * section of Today, so `things evening` / `things show evening` both normalize
 * to `things today --evening`.
 */
const KEYWORD_EXPANSIONS: Record<string, string[]> = {
  evening: ["today", "--evening"],
};

/**
 * Build the show-keyword dispatch for a view keyword: a plain keyword becomes
 * its own command; an expansion keyword becomes its command plus the fixed
 * flags. `rest` carries the user's trailing tokens through unchanged.
 */
function keywordDispatch(kw: string, rest: string[]): ResolvedInvocation {
  const expansion = KEYWORD_EXPANSIONS[kw] ?? [kw];
  return {
    form: "show-keyword",
    argv: [...expansion, ...rest],
    canonical: `things ${expansion.join(" ")}`,
    ref: kw,
  };
}

/**
 * `open`'s keyword vocabulary: ONLY the app's verified URL-scheme show ids.
 * `open`'s vocabulary belongs to the app (it hands the id straight to
 * `things:///show?id=<kw>`), so the plurals — which have no app list screen —
 * are deliberately excluded and rejected with a tailored error.
 */
export const OPEN_KEYWORDS = new Set([
  "inbox",
  "today",
  "anytime",
  "upcoming",
  "someday",
  "logbook",
  "trash",
]);

export type InvocationForm =
  /** A registered command/alias, or a flag-led/empty argv — nothing normalized. */
  | "canonical"
  /** `things <subject>` — the verb `show` was omitted. */
  | "bare-noun"
  /** `things <type> <subject>` — the `show` verb inside a type namespace was omitted. */
  | "namespace-show"
  /** `things show <ref>` — explicit loose router by reference. */
  | "loose-show"
  /** `things open <ref>` — explicit loose router by reference. */
  | "loose-open"
  /** `things show <view-keyword>` — rewritten to the `<view-keyword>` command. */
  | "show-keyword";

export interface ResolvedInvocation {
  form: InvocationForm;
  /** Normalized argv handed to commander (`from: "user"`). */
  argv: string[];
  /**
   * The canonical runnable command string, once known. Set at resolve time for
   * `show-keyword`; filled in by the `show` action after reference resolution
   * for the ref-routing forms; stays null for canonical invocations (and for
   * loose forms whose result is not a routing sugar worth echoing).
   */
  canonical: string | null;
  /** The subject/reference token (for the action to build the typed canonical). */
  ref: string | null;
}

let current: ResolvedInvocation | null = null;

/** The invocation the current process is running (null before `resolveInvocation`). */
export function getInvocation(): ResolvedInvocation | null {
  return current;
}

/**
 * Record the canonical command a ref-routing form resolved to, so the renderer
 * can echo it and stamp `meta.resolvedCommand`. No-op when the form is not a
 * routing sugar (canonical invocations echo nothing).
 */
export function setInvocationCanonical(canonical: string): void {
  if (current !== null) current.canonical = canonical;
}

/**
 * Classify raw user argv into a normalized dispatch and record it as the
 * current invocation. Idempotent per process; called once by `runCli` (and by
 * the in-process test harnesses) before commander parses.
 */
export function resolveInvocation(program: Command, args: string[]): ResolvedInvocation {
  current = classify(program, args);
  return current;
}

/**
 * Skip over LEADING GLOBAL-STYLE FLAGS to find the token being classified, so
 * `things --json Hobbies` routes exactly like `things Hobbies --json`. Only
 * the global read options are recognized here — `--json` (boolean) and `--db`
 * (value-taking: its value is skipped too, never misread as the subject).
 * Any other leading flag returns null — an unknown flag keeps the plain
 * fall-through to commander (which reports it), rather than guessing whether
 * the next token is that flag's value or the subject.
 */
function indexPastLeadingFlags(args: string[]): number | null {
  let i = 0;
  while (i < args.length) {
    const tok = args[i] ?? "";
    if (!tok.startsWith("-")) return i;
    if (tok === "--json") {
      i += 1;
    } else if (tok === "--db") {
      i += 2; // skip the flag AND its value
    } else if (tok.startsWith("--db=")) {
      i += 1;
    } else {
      return null; // unknown leading flag — commander's to handle
    }
  }
  return i; // flags only, no subject (e.g. bare `things --json`)
}

/** The registered subcommand names + aliases of a command group (empty when the group is unknown). */
function subcommandsOf(program: Command, groupName: string): Set<string> {
  const group = program.commands.find(
    (c) => c.name() === groupName || c.aliases().includes(groupName),
  );
  const names = new Set<string>();
  if (group === undefined) return names;
  for (const sub of group.commands) {
    names.add(sub.name());
    for (const alias of sub.aliases()) names.add(alias);
  }
  return names;
}

function classify(program: Command, args: string[]): ResolvedInvocation {
  const at = indexPastLeadingFlags(args);
  const first = at === null ? undefined : args[at];
  // An empty, flags-only, or unknown-flag-led argv is commander's to handle
  // (help, --version, error).
  if (first === undefined) {
    return { form: "canonical", argv: args, canonical: null, ref: null };
  }

  const known = new Set<string>(["help"]);
  for (const c of program.commands) {
    known.add(c.name());
    for (const alias of c.aliases()) known.add(alias);
  }

  if (at !== 0) {
    // A registered command reached THROUGH leading flags stays untouched:
    // program-level flags before a command were an error before and stay one.
    if (known.has(first)) {
      return { form: "canonical", argv: args, canonical: null, ref: null };
    }
    // Precedence 3 through leading global flags: a bare-noun subject routes
    // through `show` with the flags left in place — commander accepts options
    // before arguments on the subcommand.
    return { form: "bare-noun", argv: ["show", ...args], canonical: null, ref: first };
  }

  // Precedence 1: a registered command/alias always wins (names are reserved).
  if (known.has(first)) {
    if (first === "show") {
      const second = args[1];
      // Precedence 2 (show): a view keyword routes to that view command (or,
      // for a section sugar like `evening`, to its command + flags).
      if (second !== undefined && SHOW_KEYWORDS.has(second.toLowerCase())) {
        return keywordDispatch(second.toLowerCase(), args.slice(2));
      }
      return { form: "loose-show", argv: args, canonical: null, ref: second ?? null };
    }
    if (first === "open") {
      // Precedence 2 (open) is handled in the action: keyword launching and the
      // plural-not-openable error both need the keyword sets, and open renders
      // no card to anchor an echo to.
      return { form: "loose-open", argv: args, canonical: null, ref: args[1] ?? null };
    }
    // Namespace implied-show: inside a TYPE group with a `show` verb, a first
    // token that is not one of the group's registered subcommands is a subject
    // with the verb omitted — `things area Hobbies` → `things area show
    // Hobbies`. Registered verbs win (reserved-word rule); a flag or an absent
    // token leaves the bare group command to commander (help / usage error).
    if (at === 0 && IMPLIED_SHOW_NAMESPACES.has(first)) {
      const second = args[1];
      if (
        second !== undefined &&
        !second.startsWith("-") &&
        !subcommandsOf(program, first).has(second)
      ) {
        return {
          form: "namespace-show",
          argv: [first, "show", ...args.slice(1)],
          canonical: `things ${first} show ${shellQuote(second)}`,
          ref: second,
        };
      }
    }

    // Plural collection synonym: `things projects <ref>` / `things areas <ref>`
    // show that one project/area — a true synonym of the singular `show` verb,
    // which the plural command delegates to. Like the namespace implied-show it
    // echoes the canonical SINGULAR command (`≡ things project show <ref>`) and
    // stamps meta.resolvedCommand. An explicit `show` verb is forgiven and
    // dropped here (`things projects show <ref>`), so the plural command still
    // sees a single ref positional. A bare `things projects` (or a flag-led one)
    // is the list form and stays canonical — echo-free.
    if (at === 0 && (first === "projects" || first === "areas")) {
      const singular = first === "projects" ? "project" : "area";
      const rest = args[1] === "show" ? args.slice(2) : args.slice(1);
      const subject = rest[0];
      if (subject !== undefined && !subject.startsWith("-")) {
        return {
          form: "namespace-show",
          argv: [first, ...rest],
          canonical: `things ${singular} show ${shellQuote(subject)}`,
          ref: subject,
        };
      }
    }
    return { form: "canonical", argv: args, canonical: null, ref: null };
  }

  // A view-keyword sugar that is NOT itself a registered command (the section
  // sugars, e.g. `evening`) still normalizes to its canonical command form —
  // exactly as `things show evening` would. Registered commands never reach
  // here (they were handled above), so this only fires for the expansions.
  if (SHOW_KEYWORDS.has(first.toLowerCase()) && !known.has(first.toLowerCase())) {
    return keywordDispatch(first.toLowerCase(), args.slice(1));
  }

  // Precedence 3: not a command — a bare-noun reference, routed through `show`.
  return { form: "bare-noun", argv: ["show", ...args], canonical: null, ref: first };
}
