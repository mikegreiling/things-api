/**
 * The help system (docs/design/cli-grammar.md, docs/design/surface-copy.md).
 *
 * Progressive disclosure for an agent with ZERO Things knowledge:
 *  - `things --help` / `things help` — a signpost INDEX: one line per command,
 *    grouped, under a hard line budget so it shows without scrolling.
 *  - `things help <topic>` — the guides that used to crowd the index (agent
 *    notes, filters, ids, output, writes).
 *  - `things <command> --help` — the per-command detail (commander's default).
 *
 * The index text lives here, not in each command's `.description()`: a command
 * description is a paragraph for `things <command> --help`; the index needs a
 * single ≤58-char behavioral line. A completeness test keeps the two in sync
 * (every registered top-level command appears in exactly one group).
 */
import type { Command } from "commander";

import { PKG_VERSION } from "../contracts.ts";
import { ExitCode } from "../contracts.ts";

/** One command's index line: its argument sketch and its ≤58-char descriptor. */
interface IndexEntry {
  /** Argument sketch shown after the name (`<ref>`, `[id]`, `<verb>`), or "". */
  args: string;
  /** Behavioral one-liner (≤58 chars) — what the command does, not how. */
  desc: string;
}

/** The index groups, in display order. Every top-level command lands in one. */
export const HELP_GROUPS: ReadonlyArray<{ title: string; commands: readonly string[] }> = [
  {
    title: "Views — the app's built-in lists",
    commands: ["inbox", "today", "upcoming", "anytime", "someday", "logbook", "trash"],
  },
  {
    title: "Browse & search",
    commands: ["show", "open", "search", "projects", "areas", "tags", "changes"],
  },
  {
    title: "Write — create and change items",
    commands: ["todo", "project", "area", "tag", "heading", "batch", "undo", "reorder"],
  },
  {
    title: "Setup & diagnostics",
    commands: ["config", "doctor", "capabilities", "setup", "mcp", "snapshot", "legend"],
  },
];

/**
 * The per-command index copy. Keyed by top-level command name. Kept ≤58 chars
 * and behavior-only (surface-copy.md); the completeness test asserts this map's
 * keys are exactly the registered top-level commands (minus `help`).
 */
export const INDEX: Readonly<Record<string, IndexEntry>> = {
  // Views
  inbox: { args: "", desc: "captured, still-unsorted to-dos" },
  today: { args: "", desc: "what's scheduled for today, plus This Evening" },
  upcoming: { args: "", desc: "future-scheduled items, in date order" },
  anytime: { args: "", desc: "all active items, grouped by area and project" },
  someday: { args: "", desc: "incubating items kept without a date" },
  logbook: { args: "", desc: "completed and canceled items, newest first" },
  trash: { args: "", desc: "trashed items (empty it with `trash empty`)" },
  // Browse & search
  show: { args: "<ref>", desc: "show a to-do, project, or area by id or name" },
  open: { args: "<ref>", desc: "reveal an item in the Things app on this Mac" },
  search: { args: "<query>", desc: "find items by words in their title or notes" },
  projects: { args: "[id]", desc: "list projects, or show one" },
  areas: { args: "[id]", desc: "list areas, or show one" },
  tags: { args: "", desc: "list the tag hierarchy" },
  changes: { args: "", desc: "items created or changed since a moment (--since)" },
  // Write
  todo: { args: "<verb>", desc: "add, edit, schedule, complete, move to-dos" },
  project: { args: "<verb>", desc: "add, edit, complete, move projects" },
  area: { args: "<verb>", desc: "add, rename, retag, reorder, delete areas" },
  tag: { args: "<verb>", desc: "add, rename, nest, delete tags" },
  heading: { args: "<verb>", desc: "add, rename, archive headings in a project" },
  batch: { args: "[file]", desc: "run many changes from a JSONL script" },
  undo: { args: "", desc: "reverse recent changes made through this tool" },
  reorder: { args: "<ids…>", desc: "reorder items within a list or container" },
  // Setup & diagnostics
  config: { args: "<verb>", desc: "show or set configuration keys" },
  doctor: { args: "", desc: "check environment health and pending setup" },
  capabilities: { args: "", desc: "what each write operation supports" },
  setup: { args: "<verb>", desc: "one-time setup (install the Shortcuts)" },
  mcp: { args: "", desc: "serve the Model Context Protocol server on stdio" },
  snapshot: { args: "", desc: "full normalized dump of every record" },
  legend: { args: "", desc: "the symbols and colors list output uses" },
};

/** Resolve the width to reflow help to: THINGS_WIDTH, else the TTY, else 100. */
export function helpWidth(): number {
  const raw = process.env["THINGS_WIDTH"];
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) return n;
  }
  const cols = process.stdout.columns;
  if (typeof cols === "number" && cols > 0) return cols;
  return 100;
}

/** Wrap `text` to `width`, continuation lines indented to `hang`. */
function wrap(text: string, width: number, hang: number): string[] {
  const room = Math.max(24, width);
  const out: string[] = [];
  let cur = "";
  for (const word of text.split(" ")) {
    const candidate = cur === "" ? word : `${cur} ${word}`;
    if (candidate.length <= room || cur === "") cur = candidate;
    else {
      out.push(cur);
      cur = " ".repeat(hang) + word;
    }
  }
  if (cur !== "") out.push(cur);
  return out;
}

/**
 * Lay out one index row: the (already padded) `head` column followed by the
 * descriptor, wrapping the DESCRIPTOR only (so the head's alignment padding is
 * never collapsed) with continuation lines hanging at the head column width.
 */
function layoutRow(head: string, desc: string, width: number, col: number): string[] {
  const first = head + desc;
  if (first.length <= Math.max(24, width)) return [first];
  const wrapped = wrap(desc, width - col, 0);
  return wrapped.map((chunk, i) => (i === 0 ? head + chunk : " ".repeat(col) + chunk));
}

/**
 * Render the top-level signpost index. Pure and width-parameterized so the
 * contract test can assert its line budget at a fixed width. Returns the body
 * WITHOUT a trailing newline.
 */
export function renderTopLevelHelp(program: Command, width: number): string {
  void program;
  const lines: string[] = [];
  lines.push("things — a programmatic interface to Things 3 (Cultured Code).");
  lines.push("Usage: things <command> [arguments] [options]");
  lines.push("");

  // One shared name column across every group, so descriptors align.
  const headOf = (name: string): string => {
    const e = INDEX[name];
    const args = e !== undefined && e.args !== "" ? ` ${e.args}` : "";
    return `  ${name}${args}`;
  };
  let col = 0;
  for (const g of HELP_GROUPS) for (const name of g.commands) {
    col = Math.max(col, headOf(name).length);
  }
  col += 2;

  for (const g of HELP_GROUPS) {
    lines.push(`${g.title}`);
    for (const name of g.commands) {
      const e = INDEX[name];
      if (e === undefined) continue;
      const head = headOf(name).padEnd(col);
      lines.push(...layoutRow(head, e.desc, width, col));
    }
    lines.push("");
  }

  lines.push("Global options (accepted by most commands)");
  lines.push(`${"  --json".padEnd(col)}emit a versioned JSON envelope on stdout`);
  lines.push(`${"  --db <path>".padEnd(col)}read from an explicit database path`);
  lines.push(`${"  -h, --help".padEnd(col)}help for things, or for any <command>`);
  lines.push(`${"  -V, --version".padEnd(col)}print the version (${PKG_VERSION})`);
  lines.push("");

  lines.push("Run `things <command> --help` for the behavior and options of any command.");
  lines.push("Guides: `things help <topic>` — agent, filters, ids, output, writes.");
  lines.push("New to Things? Start with `things help agent`.");
  return lines.join("\n");
}

// ── Topics ───────────────────────────────────────────────────────────────────

/**
 * The AGENT NOTES, verbatim from the former top-level epilog. Authored one
 * bullet per entry; reflowed to the terminal by {@link renderAgentTopic}.
 */
const AGENT_NOTE_BULLETS: readonly string[] = [
  "Every command supports --json: a versioned envelope on stdout, logs on stderr.",
  "Uuid parameters accept unique PREFIXES (>= 6 chars); list output shows 8+-char prefixes, --json always carries full uuids. Ambiguous prefixes fail with the candidates listed.",
  'A Things share link (Share > Copy Link, "things:///show?id=<uuid>") is accepted anywhere a uuid or name is expected — it is stripped to the id.',
  "The word `show` may be omitted: `things <ref>` shows the referenced item whenever <ref> is not a command name (command names always win).",
  "Exit codes are stable: 0 ok, 2 usage, 3 verify-failed, 4 blocked, 5 drift-blocked, 6 unsupported, 7 environment.",
  "No command ever prompts interactively; operations with cascading or permanent effects require explicit flags documented in their --help.",
  "Discover the full operation catalog with: things capabilities --json",
  "Symbols & colors in list output: run `things legend` (add --json for the table).",
  "Every write supports --dry-run: preview the planned change and its expected effect without executing anything.",
  "Failures are loud: a change that does not take effect exits 3; refused changes exit 4 with machine-readable remediation.",
];

function renderAgentTopic(width: number): string {
  const room = Math.max(40, width);
  const out = ["AGENT NOTES — orientation for an agent driving this tool", ""];
  for (const bullet of AGENT_NOTE_BULLETS) {
    const wrapped = wrap(`- ${bullet}`, room, 2);
    out.push(...wrapped);
  }
  return out.join("\n");
}

/**
 * The static topic bodies. Authored to fit ~90 columns and stay ≤40 lines;
 * behavior-only (surface-copy.md) — the banned-vocabulary test scans them too.
 */
const STATIC_TOPICS: Readonly<Record<string, string>> = {
  filters: `FILTERS & BOUNDS — the optional flags a read view accepts

Content scope (which items qualify):
  --tag <ref>        items with this tag: direct, inherited, or on a descendant tag
  --exact-tag        with --tag: the named tag only, no hierarchy descendants
  --untagged         only items with no tag at all (the app's "No Tag" filter)
  --area <ref>       restrict to one area (logbook, search)
  --project <ref>    restrict to one project (logbook, search)
  --type <kind>      search only: todo | project

Volume caps (how many rows):
  --limit <n>        maximum rows before truncating (flat views; default 50)
  --area-limit <n>   per-area-block cap on the grouped views (anytime, someday, areas)
  --project-limit <n>  per-project-block cap (anytime, area show)
  --all              lift this view's own caps and bounds — but never pull in a
                     different class: logged and trashed items stay behind their
                     own flags (--show-logged, --trashed)

Range bounds (the time window — keyed to each view's own timeline):
  --since <when>     logbook = logged date · upcoming = scheduled date
  --until <when>     changes = modified date · inbox = created date
  Accepts \`2w\`/\`3m\`/\`1y\` back from today, or \`2024\`, \`2024-03\`, \`2024-03-05\`.

Defaults exist only for the bare invocation. Stating any explicit --limit or
--since/--until drops the remaining defaults of both classes; explicit values
always compose as an intersection. Content scopes and toggles never lift a
default. (\`things changes\` requires --since, so that required bound lifts nothing.)`,

  ids: `REFERENCES & IDS — how to point at an item

Every item has a uuid. List views print a short prefix; --json always carries the
full uuid. Anywhere a uuid or name is accepted you may pass:
  - a full uuid
  - a unique uuid PREFIX (>= 6 characters)
  - a things:/// share link (the app's Share > Copy Link) — stripped to its id
  - a unique NAME, for projects and areas (case-, space-, and dash-insensitive)
Ambiguous prefixes and names fail loudly and list the candidates.

Direct addressing — the word \`show\` may be omitted:
  things <ref>          show the referenced item (when <ref> is not a command name)
  things area <ref>     show that area      (the verb is implied inside a type)
  things project <ref>  show that project
Command names always win: \`things today\` is the view, never an item called
"today". Reach a same-named item by its uuid, or by the typed form
(\`things area show Anytime\`).

To-dos route only by uuid, prefix, or share link — never by title. A bare NAME
resolves against areas and projects only; on a tie, the area wins. When a name
does not resolve, the error offers close title matches you can copy.`,

  output: `OUTPUT — human tables vs. --json

Human output (the default): compact aligned tables and detail cards, fit to the
terminal width on a TTY. On a TTY a list view also prints a title header and, for
a rewritten shorthand, a dim \`≡ <canonical command>\` echo. Neither the header nor
the echo rides piped output or --json, so \`things inbox | grep\` stays clean.

  --json    A versioned envelope on stdout: { apiVersion, ok, kind, data, meta }.
            A failure becomes an error envelope (still exit-coded). Logs, warnings,
            and errors go to stderr, so stdout stays one clean JSON line. Full uuids
            always appear here. --json is byte-stable — it is never width-fitted.

Width: human tables fit the terminal on a TTY. Set THINGS_WIDTH=<cols> to force a
column width, or THINGS_WIDTH=0 to disable fitting. Piped output is never fitted,
so it stays stable for grep and diffs.

Symbols and colors used in the tables: \`things legend\` (or \`things legend --json\`).`,

  writes: `WRITES — the gating model, undo, and setup

Every write behaves the same way:
  - Success means the change happened; if it did not take effect the command exits
    non-zero with a machine-readable reason.
  - --dry-run previews the planned change and its expected effect; nothing runs.
  - No command prompts interactively. A change that cascades, is permanent, or
    disturbs the app requires an explicit flag, named for its consequence:
      --acknowledge-*           confirm a cascade or a reset (named per command)
      --children <policy>       decide what happens to a container's open to-dos
      --dangerously-permanent   accept a permanent, unrecoverable delete
      --allow-disruptive        permit a change that briefly steals window focus
      --allow-very-disruptive   permit a change that visibly drives the Things app
      --dangerously-drive-gui   for the few operations the app offers nowhere else

Undo — \`things undo\`:
  Reverse recent changes made through this tool, newest first; each undo applies
  the inverse change. --dry-run shows the plan. Irreversible changes (permanent
  deletes, unknown prior state) are reported, never guessed. Changes made directly
  in the Things app cannot be undone here.

Configuration that affects writes — \`things config set <key> <value>\`:
  actor               author name recorded on each change
  maxDisruption       ceiling for how disruptive a change may be
  ui-enabled          allow the GUI-driven operations
  allow-experimental  enable experimental strategies (e.g. native reorder)

Discover every operation and the flags it needs: \`things capabilities\`.
A few operations need the bundled Shortcuts: \`things setup shortcuts\`.`,
};

/** The valid topic names, in the order the "unknown topic" hint lists them. */
export const TOPIC_NAMES: readonly string[] = ["agent", "filters", "ids", "output", "writes"];

/** Render one topic to `width`, or null when `name` is not a topic. */
export function renderTopic(name: string, width: number): string | null {
  if (name === "agent") return renderAgentTopic(width);
  return STATIC_TOPICS[name] ?? null;
}

/**
 * Install the custom top-level help and the `help [topic]` command. Replaces
 * the root program's `helpInformation` with the signpost index (so both
 * `things --help` and the help command render it) and disables commander's
 * built-in help command in favor of one that also serves topics.
 */
export function registerHelp(program: Command): void {
  // Root-only override: subcommands keep commander's default per-command help.
  program.helpInformation = () => `${renderTopLevelHelp(program, helpWidth())}\n`;
  // Replace commander's built-in `help [command]` with our topic-aware one.
  program.helpCommand(false);
  program
    .command("help [command...]")
    .description("show this index, a guide (`things help <topic>`), or a command's help")
    .action((tokens: string[] = []) => {
      const width = helpWidth();
      if (tokens.length === 0) {
        program.outputHelp();
        return;
      }
      const first = (tokens[0] ?? "").toLowerCase();
      // A single topic token renders the guide.
      if (tokens.length === 1) {
        const topic = renderTopic(first, width);
        if (topic !== null) {
          process.stdout.write(`${topic}\n`);
          return;
        }
      }
      // Otherwise resolve a command path and defer to its own --help.
      let cmd: Command | undefined = program;
      for (const token of tokens) {
        cmd = cmd.commands.find(
          (c) => c.name() === token || c.aliases().includes(token),
        );
        if (cmd === undefined) break;
      }
      if (cmd !== undefined && cmd !== program) {
        cmd.outputHelp();
        return;
      }
      process.stderr.write(
        `error: no help topic or command "${tokens.join(" ")}" — ` +
          `topics: ${TOPIC_NAMES.join(", ")}; ` +
          "commands: `things --help`\n",
      );
      process.exitCode = ExitCode.Usage;
    });
}
