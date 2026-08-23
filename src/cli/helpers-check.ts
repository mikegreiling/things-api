/**
 * The passive helpers notice (docs/design/agent-daemon.md §3c) — the
 * skill-drift check's twin, with the same gating:
 *
 *  - HUMAN paths only — never when `--json` is present, never the `mcp` server,
 *    and never on `things helpers …` itself (that command reports this state in
 *    full, and its `install` IS the remedy).
 *  - One stderr line at most, shared with the routing layer's degradation
 *    notice through src/deputy/notice.ts (a process spends one notice, total).
 *  - Silent on ANY error — a nudge must never break a command.
 *  - Kill switch: `THINGS_API_NO_HELPERS_CHECK=1`.
 *
 * What it says is decided by the library (src/deputy/notices.ts): a stale
 * installed bundle asks for a rebuild + reinstall; a machine with no helpers at
 * all gets a throttled, once-a-fortnight introduction.
 */
import { computeHelpersNotice, emitHelpersNotice, markHelpersHintShown } from "../index.ts";

/** Per-process guard: the check runs at most once. */
let alreadyChecked = false;

/** Reset the once-guard (tests only). */
export function resetHelpersCheck(): void {
  alreadyChecked = false;
}

/** True when this invocation is a human path eligible for the notice. */
function isHumanPath(argv: string[]): boolean {
  if (argv.includes("--json")) return false; // machine consumer — stay silent
  const first = argv.find((a) => !a.startsWith("-"));
  return first !== "mcp" && first !== "helpers";
}

export function maybeEmitHelpersNotice(opts: {
  argv: string[];
  env?: NodeJS.ProcessEnv;
  now?: number;
  write?: (s: string) => void;
}): void {
  if (alreadyChecked) return;
  alreadyChecked = true;
  try {
    const env = opts.env ?? process.env;
    const kill = env["THINGS_API_NO_HELPERS_CHECK"];
    if (kill !== undefined && kill !== "" && kill !== "0") return;
    if (!isHumanPath(opts.argv)) return;
    const notice = computeHelpersNotice({ env, ...(opts.now !== undefined && { now: opts.now }) });
    if (notice === null) return;
    emitHelpersNotice(notice.text, opts.write);
    // Restart the throttle only for the suggestion — a real skew keeps saying
    // so on every command until the rebuild lands.
    if (notice.kind === "absent-hint") markHelpersHintShown(env, opts.now);
  } catch {
    // A passive nudge must never break a command — swallow everything.
  }
}
