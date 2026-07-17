/**
 * The CLI's process-wide render clock, resolved once in `runCli` from the
 * environment (THINGS_TZ / THINGS_NOW) and read by the pure renderers and the
 * period parsers — the same module-state pattern the width fit uses
 * (./width.ts). It carries the consumer's `now` source and IANA zone so every
 * human date token (Today marker, ‹date› chips, period bounds) matches the
 * `meta.clock` the library reports. Unset (the default, and in unit tests that
 * import the renderers directly) it is the host clock — byte-identical output.
 */
let clockNow: (() => Date) | null = null;
let clockZone: string | undefined;

export function setRenderClock(clock: { now: () => Date; zone: string | undefined }): void {
  clockNow = clock.now;
  clockZone = clock.zone;
}

/** The render clock's instant (pinned THINGS_NOW when set, else real time); host time when unset. */
export function renderNow(): Date {
  return clockNow === null ? new Date() : clockNow();
}

/** The render clock's consumer zone, or undefined for the host zone. */
export function renderZone(): string | undefined {
  return clockZone;
}
