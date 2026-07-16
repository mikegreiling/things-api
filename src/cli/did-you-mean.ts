/**
 * The did-you-mean fallback for an unresolved show / bare-noun subject
 * (docs/design/cli-grammar.md). When reference resolution exhausts every tier,
 * a show-style command throws a {@link DidYouMeanError} carrying a lite
 * title-search result instead of a bare not-found; the read driver renders it
 * as an exit-2 error line, standard candidate rows, and a `things search`
 * suggestion, and — under `--json` — stamps the candidates onto
 * `error.details.candidates` so an agent can self-correct.
 */
import type { LiteCandidate, LiteSearchResult, ListItem } from "../index.ts";
import { dim } from "./style.ts";
import { areaMark } from "./glyphs.ts";
import { formatItem, uuidDisplayWidth } from "./render.ts";

/**
 * A resolution failure that carries did-you-mean candidates. Distinct from a
 * plain not-found so the driver can render the richer fallback (and set the
 * usage exit code) while every other error keeps its generic path.
 */
export class DidYouMeanError extends Error {
  readonly query: string;
  readonly result: LiteSearchResult;
  constructor(message: string, query: string, result: LiteSearchResult) {
    super(message);
    this.name = "DidYouMeanError";
    this.query = query;
    this.result = result;
  }
}

/** Single-quote a subject for the copy-pasteable `things search` suggestion. */
function searchSuggestion(query: string): string {
  return `things search '${query.replace(/'/g, "'\\''")}'`;
}

/**
 * Human render: the error line, then one row per candidate (areas/projects as
 * container rows, to-dos with their dim `(container)` context), a `… n more`
 * tail when the match set was capped, and always the closing search
 * suggestion. All muted — this is a diagnostic block, not a result set.
 */
export function renderDidYouMean(err: DidYouMeanError): string[] {
  const { candidates, total } = err.result;
  const lines = [`error: ${err.message}`];
  if (candidates.length > 0) {
    lines.push("", dim("did you mean:"));
    const tasks = candidates.filter(
      (c): c is Extract<LiteCandidate, { kind: "task" }> => c.kind === "task",
    );
    const w = uuidDisplayWidth(tasks.map((c) => c.task));
    for (const c of candidates) {
      if (c.kind === "area")
        lines.push(`  ${areaMark()} ${c.area.title} ${dim(`(${c.area.uuid})`)}`);
      else lines.push(`  ${formatItem(c.task as ListItem, w)}`);
    }
    if (total > candidates.length) {
      lines.push(dim(`  … ${total - candidates.length} more — \`${searchSuggestion(err.query)}\``));
    }
  }
  lines.push("", dim(`or try: \`${searchSuggestion(err.query)}\``));
  return lines;
}

/** The additive `--json` payload: the candidate entities, standard shapes. */
export function candidatesJson(err: DidYouMeanError): unknown[] {
  return err.result.candidates.map((c) => (c.kind === "area" ? c.area : c.task));
}
