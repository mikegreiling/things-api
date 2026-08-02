/**
 * The did-you-mean fallback for an unresolved show / bare-noun subject
 * (docs/design/cli-grammar.md). When reference resolution exhausts every tier,
 * a show-style command throws a {@link DidYouMeanError} carrying a lite
 * title-search result instead of a bare not-found; the read driver renders it
 * as an exit-2 error line, standard candidate rows, and a `things search`
 * suggestion, and — under `--json` — stamps the candidates onto
 * `error.details.candidates` so an agent can self-correct.
 */
import {
  candidateRef,
  deadNameMatchHint,
  localToday,
  REF_PREFIX_LEN,
  type CandidateRef,
  type LiteCandidate,
  type LiteSearchResult,
  type ListItem,
} from "../index.ts";
import { renderZone } from "./clock.ts";
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
 * The error message plus the honest dead-row hint: when the name matched ZERO
 * LIVE rows but DOES match trashed / logbook rows, name them (with counts and
 * where to look) so the caller is not left thinking the item vanished. Shared by
 * the human render and the `--json` envelope so both carry the same message.
 */
export function didYouMeanMessage(err: DidYouMeanError): string {
  return `${err.message}${deadNameMatchHint(err.result.deadMatches ?? {})}`;
}

/**
 * Human render: the error line, then one row per candidate (areas/projects as
 * container rows, to-dos with their dim `(container)` context), a `… n more`
 * tail when the match set was capped, and always the closing search
 * suggestion. All muted — this is a diagnostic block, not a result set.
 */
export function renderDidYouMean(err: DidYouMeanError): string[] {
  const { candidates, total } = err.result;
  const lines = [`error: ${didYouMeanMessage(err)}`];
  if (candidates.length > 0) {
    lines.push("", dim("did you mean:"));
    const tasks = candidates.filter(
      (c): c is Extract<LiteCandidate, { kind: "task" }> => c.kind === "task",
    );
    const w = uuidDisplayWidth(tasks.map((c) => c.task));
    // Duplicate-titled project/to-do candidates get a `· started <date>` tail so
    // a human can tell recurring twins apart (TTY only — the JSON candidate
    // payload is unchanged). Count titles among the task candidates only.
    const titleCounts = new Map<string, number>();
    for (const c of tasks) titleCounts.set(c.task.title, (titleCounts.get(c.task.title) ?? 0) + 1);
    for (const c of candidates) {
      if (c.kind === "area") {
        // Fused ref form `Title [8charPrefix]` (dim bracket) — pastes back as a
        // decorated ref that resolves to this area.
        lines.push(
          `  ${areaMark()} ${c.area.title} ${dim(`[${c.area.uuid.slice(0, REF_PREFIX_LEN)}]`)}`,
        );
      } else {
        const started =
          (titleCounts.get(c.task.title) ?? 0) > 1
            ? ` ${dim(`· started ${localToday(c.task.created, renderZone())}`)}`
            : "";
        lines.push(`  ${formatItem(c.task as ListItem, w)}${started}`);
      }
    }
    if (total > candidates.length) {
      lines.push(dim(`  … ${total - candidates.length} more — \`${searchSuggestion(err.query)}\``));
    }
  }
  lines.push("", dim(`or try: \`${searchSuggestion(err.query)}\``));
  return lines;
}

/**
 * The additive `--json` payload: each candidate projected to the ONE fixed
 * {@link CandidateRef} disambiguation shape (never the raw internal entity — see
 * {@link candidateRef}). The list is already capped by the lite search.
 */
export function candidatesJson(err: DidYouMeanError): CandidateRef[] {
  return err.result.candidates.map((c) =>
    c.kind === "area" ? candidateRef("area", c.area) : candidateRef(c.task.type, c.task),
  );
}
