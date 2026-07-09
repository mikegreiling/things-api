/**
 * ANSI styling for the human-readable CLI output. Colors engage only when
 * stdout is a TTY, so piped/captured output (agents, scripts, tests) stays
 * plain text with zero escape bytes. `NO_COLOR` (any value) always disables;
 * `FORCE_COLOR` (any value except "0") enables even when piped. Only the
 * base 16-color palette is used — terminals remap those per theme, so both
 * light and dark backgrounds stay readable.
 */
function colorEnabled(): boolean {
  if (process.env["NO_COLOR"] !== undefined) return false;
  const force = process.env["FORCE_COLOR"];
  if (force !== undefined) return force !== "0";
  return process.stdout.isTTY === true;
}

const ENABLED = colorEnabled();

const wrap = (open: number, close: number) => (s: string) =>
  ENABLED ? `\u001b[${open}m${s}\u001b[${close}m` : s;

export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const red = wrap(31, 39);
export const yellow = wrap(33, 39);
export const magenta = wrap(35, 39);
export const cyan = wrap(36, 39);
