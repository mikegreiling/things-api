/**
 * The single helpers stderr channel: AT MOST ONE line per process, whichever
 * condition speaks first.
 *
 * Two producers share it — the routing layer (degradation caught at
 * activation, src/deputy/routing.ts) and the CLI's passive install/upgrade
 * check (src/cli/helpers-check.ts). One process can hit both (an installed but
 * stale helper that also fails to answer), and two stacked lines about the same
 * broken helper are noise, not information: the first one already names a
 * remedy that resolves the state.
 */
let noticed = false;

/** Emit one helpers notice on stderr; later calls this process are dropped. */
export function emitHelpersNotice(
  message: string,
  write: (s: string) => void = (s) => void process.stderr.write(s),
): void {
  if (noticed) return;
  noticed = true;
  write(`things-api helpers: ${message}\n`);
}

/** True once this process has spent its one notice. */
export function helpersNoticeSpent(): boolean {
  return noticed;
}

/** Test seam: forget that a notice was emitted. */
export function resetHelpersNoticeForTests(): void {
  noticed = false;
}
