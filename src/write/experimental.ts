/**
 * Canary for `experimental: true` capabilities: the private reorder command
 * is UNDOCUMENTED and can vanish in any Things update, so before every use
 * the pipeline re-checks that the app's sdef still declares it. A missing
 * declaration blocks the write loudly instead of dispatching a command the
 * app may now reject — or reinterpret.
 *
 * The sdef canary is a DECLARATION check, and Things 3.23 broke the command
 * without touching the declaration: it still parses, still exits 0, and now
 * changes nothing (docs/lab/gv4-323-campaign.md §3.1 — 14 o-suite reds plus
 * the e2e reorder steps, reproduced in isolation against a project scope).
 * Until the behavioral canary that would catch that class exists, a VERSION
 * gate stands in: on 3.23 and later the private command is treated as absent.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const PRIVATE_REORDER_COMMAND = "_private_experimental_ reorder to dos in";

const SDEF_NEEDLE = `command name="${PRIVATE_REORDER_COMMAND}"`;
const RESOURCES_DIR = "/Applications/Things3.app/Contents/Resources";

/**
 * True when the installed Things sdef still declares the private reorder
 * command (Things 3.22.11 ships it as Resources/Things.sdef — scan every
 * .sdef in the bundle so a rename alone doesn't false-negative).
 */
export function sdefDeclaresPrivateReorder(resourcesDir: string = RESOURCES_DIR): boolean {
  let entries: string[];
  try {
    entries = readdirSync(resourcesDir);
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".sdef")) continue;
    try {
      if (readFileSync(join(resourcesDir, entry), "utf8").includes(SDEF_NEEDLE)) return true;
    } catch {
      // unreadable sdef → keep scanning; all-fail means "not declared"
    }
  }
  return false;
}

/**
 * The first Things marketing version that accepts the private reorder command
 * and does nothing with it (GV4, docs/lab/gv4-323-campaign.md §3.1).
 */
export const PRIVATE_REORDER_NO_OP_FROM = "3.23";

/** The leading dotted-numeric run of a marketing version, or null when absent. */
function parseAppVersion(v: string | null): number[] | null {
  if (v === null) return null;
  const m = /^\d+(?:\.\d+)*/.exec(v.trim());
  if (m === null) return null;
  return m[0].split(".").map(Number);
}

/**
 * Compare two dotted marketing versions ("3.22.14", "3.23", "4.0"): -1 / 0 / +1
 * for a<b / a==b / a>b, or null when either is not a dotted-numeric stamp.
 * Missing trailing segments count as 0, so "3.23" == "3.23.0" < "3.23.1".
 */
export function compareAppVersions(a: string | null, b: string | null): number | null {
  const pa = parseAppVersion(a);
  const pb = parseAppVersion(b);
  if (pa === null || pb === null) return null;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * True when the installed Things is known to execute the private reorder
 * command as a silent no-op — i.e. its version is readable AND at least
 * {@link PRIVATE_REORDER_NO_OP_FROM}. An unknown or unparseable version is NOT
 * gated: the sdef canary and the `allow-experimental` gate remain the only
 * checks there, exactly as before.
 */
export function privateReorderIsNoOp(installedVersion: string | null): boolean {
  const cmp = compareAppVersions(installedVersion, PRIVATE_REORDER_NO_OP_FROM);
  return cmp !== null && cmp >= 0;
}

/**
 * The first Things version that accepts a dated `when=` on a repeating template
 * instead of dying on it — the series RE-ANCHOR (REANCH1 §6,
 * docs/lab/reanch1-url-reanchor.md). On 3.22.14 every dated spelling kills the
 * process with zero delta, five deaths for five arms; on 3.23 a strictly-future
 * date re-anchors the series cleanly. The capability appeared WITHOUT an
 * announcement, so it is version-gated rather than assumed.
 */
export const URL_REANCHOR_FROM = "3.23";

/**
 * True when the installed Things is known to carry the URL series re-anchor —
 * a readable version at least {@link URL_REANCHOR_FROM}. An UNKNOWN or
 * unparseable version reads false: this gate stands in front of a write that
 * KILLS the app on every older build, so it fails closed.
 */
export function urlReanchorSupported(installedVersion: string | null): boolean {
  const cmp = compareAppVersions(installedVersion, URL_REANCHOR_FROM);
  return cmp !== null && cmp >= 0;
}

/**
 * `area.reorder`'s opt-in gate — the MAINTAINER RULINGS of 2026-09-02 and
 * 2026-09-05.
 *
 * The sidebar-area order has exactly one transport: a synthesized drag through
 * the Accessibility API (P6/O13). Every other write in this package rides a
 * documented app surface; this one drives the window. #676 measured what that
 * costs on real hardware — a single 174-row sidebar read took 16–18s on the
 * maintainer's M1, against ~0.8s for the same shape in the lab — and one move
 * needs several of them (VOPAT2 PR 2 cut the census to the rows a prediction
 * names, which is where the current ~7.4s one-wall prediction comes from).
 *
 * THE 2026-09-05 REVISION. The first ruling ended "promoted inside five seconds
 * or REMOVED"; the second replaces that fork: *"anything fragile or overly time
 * consuming like this should be off by default, but not necessarily removed. In
 * a completely headless system, with minimal possibility of a user moving the
 * cursor around or re-focusing windows during the automation, this is perfectly
 * workable as long as we have some sort of mutex preventing any parallel
 * operations from occurring."* So the operation STAYS and this key stays default
 * OFF as a standing statement about the operation's class, not as a countdown:
 * it is for a host where nobody is using Things interactively. The mutex half is
 * not optional and is not this gate's job — the drive holds the composite
 * mutation lock end to end (see `withMutationLock`), so no other write from this
 * package can add, remove or re-rank a sidebar row between the census that plans
 * the drag and the gesture that lands it.
 *
 * This is deliberately NOT the `allow-experimental` key: that one gates the
 * app's private sdef reorder command, is documented as a private-vendor-surface
 * switch rather than a maturity switch, and defaults ON — so it would gate
 * nothing here. A one-operation key states one fact and defaults off.
 */
export const AREA_REORDER_CONFIG_KEY = "experimental-area-reorder";

/**
 * The ~5s wall-time bar of the 2026-09-02 ruling. Since 2026-09-05 it is a COST
 * REFERENCE, not a promotion trigger: the operation stays opt-in whatever it
 * measures, and the number is what the maintainer's own field measurement is
 * compared against.
 */
export const AREA_REORDER_LATENCY_BAR_MS = 5_000;

export interface ExperimentalOpBlock {
  detail: string;
  remediation: string;
}

/**
 * The refusal for an un-opted-in `area.reorder`, or null when the caller has
 * opted in. Behavior and side effects only, per docs/design/surface-copy.md.
 */
export function areaReorderBlock(experimentalAreaReorder: boolean): ExperimentalOpBlock | null {
  if (experimentalAreaReorder) return null;
  return {
    detail:
      "reordering sidebar areas drives the Things window through the Accessibility API — " +
      "it synthesizes a drag, reads the sidebar between gestures, and can collapse and " +
      "re-expand areas to clear a path. On a large sidebar a move takes several seconds, " +
      "or up to about a minute when the area travels far, and it can leave an area " +
      "collapsed if it stops part-way. It is off by default because it needs the app to " +
      "itself: it is meant for a host nobody is clicking in, and while it runs every other " +
      "change from this package waits for it",
    remediation:
      `run \`things config set ${AREA_REORDER_CONFIG_KEY} true\` to use it anyway — best on a host ` +
      "where nobody is working in Things at the same time — or drag the area in Things",
  };
}
