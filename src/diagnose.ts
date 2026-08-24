/**
 * Environment/database/fingerprint health report — the library function
 * behind `things doctor` and the MCP doctor tool. Read-only: opens the DB,
 * observes the schema, checks the app bundle and the experimental canary.
 */
import { existsSync } from "node:fs";

import { type HelpersMode, loadConfig } from "./config.ts";
import { resolveScope } from "./read/scope.ts";
import { auditDir } from "./paths.ts";
import { readAuditRecords, scanAuditIntegrity } from "./write/undo.ts";
import { decodeRecurrenceRule } from "./model/recurrence.ts";
import { BASELINES } from "./db/baselines/index.ts";
import { openConnection, ThingsDbOpenError } from "./db/connection.ts";
import { createDeputyDbFacade } from "./deputy/db-facade.ts";
import { helpersStatus, type HelpersStatus } from "./deputy/install.ts";
import { type DeputyHello, EXPECTED_HELPERS_VERSION } from "./deputy/protocol.ts";
import {
  deputyDbPath,
  deputyRoutesDb,
  helpersRouting,
  type HelpersRouting,
} from "./deputy/routing.ts";
import {
  readAllowed,
  readCapability,
  uiCapability,
  writeCapability,
  type ReadCapability,
  type UiCapability,
  type WriteCapability,
} from "./capability.ts";
import { compareToBaseline, observeSchema } from "./db/fingerprint.ts";
import { locateThingsDb, ThingsDbNotFoundError } from "./db/locate.ts";
import {
  isThingsRunning,
  probeAutomation,
  type AutomationProbeDeps,
  type AutomationProbeStatus,
} from "./write/automation-probe.ts";
import {
  probeAccessibility,
  type AccessibilityProbeDeps,
  type AccessibilityProbeStatus,
} from "./write/accessibility-probe.ts";
import {
  allCertifications,
  UI_CERTIFICATION_PROFILE,
  type CertificationStatus,
} from "./write/vectors/ui-certification.ts";
import {
  readShortcutProxies,
  readUrlSchemeEnabled,
  type AvailabilityDeps,
  type ShortcutsState,
  type UrlSchemeState,
} from "./write/availability.ts";
import {
  createEnvironmentTracker,
  diffEnvironment,
  type EnvironmentChange,
  type EnvironmentTracker,
  type EnvironmentTuple,
} from "./write/environment.ts";
import { sdefDeclaresPrivateReorder } from "./write/experimental.ts";
import { computeSyncHealth, type SyncHealth, type SyncHealthDeps } from "./sync-health.ts";
import { ExitCode, PKG_VERSION, type EnvelopeMeta, type ErrorCode } from "./contracts.ts";

const THINGS_APP = "/Applications/Things3.app";

/** Decode every repeating template's rule blob; count the failures. */
function scanRecurrenceRules(db: {
  prepare(sql: string): { all(): unknown[] };
}): DiagnoseReport["recurrence"] {
  let rows: Array<{ uuid: string; rule: unknown }>;
  try {
    rows = db
      .prepare(
        "SELECT uuid, rt1_recurrenceRule AS rule FROM TMTask WHERE rt1_recurrenceRule IS NOT NULL",
      )
      .all() as Array<{ uuid: string; rule: unknown }>;
  } catch {
    return { templates: 0, undecodable: 0, detail: "repeat-rule column unavailable" };
  }
  let undecodable = 0;
  let firstError = "";
  for (const row of rows) {
    try {
      decodeRecurrenceRule(row.rule);
    } catch (err) {
      undecodable += 1;
      if (firstError === "") firstError = err instanceof Error ? err.message : String(err);
    }
  }
  return {
    templates: rows.length,
    undecodable,
    detail:
      undecodable === 0
        ? rows.length === 0
          ? "no repeating templates"
          : "every repeating template's rule decodes"
        : `${undecodable} rule(s) failed to decode (first: ${firstError}) — a Things update ` +
          "may have changed the repeat-rule format; occurrence projections for those " +
          "templates are unavailable",
  };
}

/** The helper pair's section of the report — see {@link DiagnoseReport.helpers}. */
export interface HelpersReport {
  /** Configured routing mode (`helpers-enabled`): auto | true | false. */
  mode: HelpersMode;
  /** What that mode RESOLVED to in this process (per-half, with reasons). */
  routing: HelpersRouting;
  /** Installation + liveness + signing + grant, both halves. */
  status: HelpersStatus;
  /** The installed bundle's version, null when nothing is installed. */
  installedVersion: string | null;
  /** The version this package's protocol/library was built against. */
  expectedVersion: string;
  /** Installed but not the expected version — the remedy is a rebuild + reinstall. */
  versionSkew: boolean;
  /** Either half left a socket behind that no longer answers a handshake. */
  hungSocket: boolean;
  /** One line naming the fix, or null when there is nothing to fix. */
  remedy: string | null;
  detail: string;
}

/** Test seam for the helpers section (see {@link DiagnoseOptions.helpers}). */
export interface HelpersReportDeps {
  status?: HelpersStatus;
  routing?: HelpersRouting;
}

/**
 * Does the deputy still owe macOS a consent it can only collect with a human
 * present? Reads the TCC standing its handshake carries (helpers v1.2.0+);
 * an older deputy reports nothing here, so nothing is claimed about it.
 */
function outstandingConsent(hello: DeputyHello | null): boolean {
  if (hello === null) return false;
  if (hello.axTrusted === false) return true;
  const automation = hello.automation;
  if (automation === undefined) return false;
  return automation.things !== "granted" || automation.systemEvents !== "granted";
}

function buildHelpersReport(configMode: HelpersMode, deps: HelpersReportDeps = {}): HelpersReport {
  // The routing resolution carries the mode it resolved (helpersRouting reads
  // the same config), so the section has ONE source for it.
  const routing = deps.routing ?? helpersRouting();
  const mode = routing.mode;
  const status = deps.status ?? helpersStatus(configMode);
  const installedVersion = status.installedVersion;
  const versionSkew = installedVersion !== null && installedVersion !== EXPECTED_HELPERS_VERSION;
  const hungSocket = status.deputy.hungSocket || status.reader.hungSocket;
  const remedy = versionSkew
    ? "rebuild the bundle (`bash scripts/build-helpers.sh`) and rerun `things helpers setup`"
    : hungSocket
      ? "`things helpers restart` — a socket is present but no handshake comes back"
      : !status.bundleInstalled
        ? mode === "false"
          ? null
          : "`things helpers setup` to move macOS permission grants onto the helpers"
        : status.reader.installed && status.reader.running && !status.reader.granted
          ? "`things helpers setup` once, at the machine, to give the reader durable read access"
          : status.bundleInstalled && !status.deputy.running
            ? "`things helpers setup` (re-registers both helpers with launchd and starts them)"
            : outstandingConsent(status.deputy.hello)
              ? "`things helpers setup` once, at the machine — one sitting settles every macOS permission the helpers still need"
              : null;
  const detail =
    mode === "false"
      ? "routing off — every primitive runs in this process (`things config set helpers-enabled auto` to use an installed helper)"
      : routing.automation && routing.files
        ? "both halves carrying traffic"
        : !status.bundleInstalled
          ? mode === "auto"
            ? "nothing installed — running direct, which is the normal state for a machine that has not onboarded the helpers"
            : "routing is set to true but nothing is installed — running direct"
          : `running direct for ${[
              ...(routing.automation ? [] : [`automation (${routing.deputyReason ?? "unknown"})`]),
              ...(routing.files ? [] : [`database reads (${routing.readerReason ?? "unknown"})`]),
            ].join(" and ")}`;
  return {
    mode,
    routing,
    status,
    installedVersion,
    expectedVersion: EXPECTED_HELPERS_VERSION,
    versionSkew,
    hungSocket,
    remedy,
    detail,
  };
}

export interface DiagnoseReport {
  /**
   * What this process is permitted to do, and on whose authority
   * (docs/design/permissions-doctrine.md, Article II). Detected prompt-free, so
   * asking `doctor` never costs a consent dialog — which matters most on
   * exactly the broken machine where someone runs it.
   */
  capability: {
    read: ReadCapability;
    write: WriteCapability;
    /** GUI-driving standing — helpers-only by Article IV. */
    ui: UiCapability;
  };
  db: {
    path: string;
    source: "option" | "env" | "container" | "deputy";
    otherCandidates: string[];
    databaseVersion: number | null;
  };
  fingerprint: {
    status: "ok" | "drift" | "user-accepted" | "unknown-version";
    value: string;
    expected: string | null;
    detail: string[];
    extraColumns: Record<string, string[]>;
  };
  app: {
    installed: boolean;
    /** Installed app version (CFBundleShortVersionString); null when unreadable. */
    version: string | null;
    /**
     * The app version the behavioral LAWS were last certified against
     * (config `certified-app-version`); null when never set.
     */
    certifiedVersion: string | null;
    /**
     * True when the installed version is known, a certified version is set, and
     * they differ — a PASSIVE signal that the behavioral laws
     * (docs/reference/assumption-register.md) may have moved with zero schema
     * delta. Non-blocking: writes stay enabled; doctor emits a notice pointing
     * at the drift suite. False when unset/unknown/matching.
     */
    behavioralDrift: boolean;
  };
  writes: {
    enabled: boolean;
    reason: string;
  };
  /**
   * The active container scope (from THINGS_API_SCOPE / the stored `scope` key),
   * so the jail is never silently on. `requested` is the raw ref (null when
   * unscoped); `resolved` names the container it pins to (null when the ref no
   * longer resolves — a fail-closed empty jail). The MCP `--scope` flag is
   * per-process and not visible here.
   */
  scope: {
    requested: string | null;
    source: "env" | "config" | null;
    resolved: { kind: "area" | "project"; uuid: string; title: string } | null;
    detail: string;
  };
  experimental: {
    /** config allowExperimental (opt-in for private-surface capabilities). */
    enabled: boolean;
    /** sdef canary: the private reorder command is still declared. */
    sdefDeclaresReorder: boolean;
    reason: string;
  };
  environment: {
    /** The identity tuple macOS consent grants key on (docs/setup.md, hardening). */
    current: EnvironmentTuple;
    /** Tuple recorded at the last verified mutation; null before the first one. */
    lastVerifiedWrite: EnvironmentTuple | null;
    /** Non-empty = re-consent risk: something changed since the last verified write. */
    changes: EnvironmentChange[];
  };
  automation: {
    status: AutomationProbeStatus | "not-probed";
    detail: string;
  };
  /**
   * The Accessibility GUI ("ui") vector's health: whether it is enabled on
   * this machine, whether the app is running, the Accessibility grant + recipe
   * canary (opt-in, --probe-accessibility, mirroring the Automation probe so a
   * diagnostic never triggers a surprise TCC prompt), and per-op certification.
   */
  ui: {
    /** config.ui.enabled — the first of the vector's two keys. */
    enabled: boolean;
    appRunning: boolean;
    accessibility: {
      status: AccessibilityProbeStatus | "not-probed";
      detail: string;
    };
    /** Manifest profile ("provisional" until a real-hardware sitting lands). */
    certificationProfile: string;
    /** Per-op certification: recipes ship uncertified until certified on hardware. */
    certification: { op: string; status: CertificationStatus }[];
    reason: string;
  };
  availability: {
    /** On-disk 'Enable Things URLs' state (group-container plist; Phase 21b). */
    urlScheme: UrlSchemeState;
    /** Which proxy shortcuts are installed (the Shortcuts surface's prerequisites). */
    shortcuts: ShortcutsState;
  };
  /**
   * Repeat-rule format canary: every repeating template's rule blob is
   * decoded; a non-zero undecodable count is the early-warning sign that a
   * Things update changed the repeat-rule format (the most schema-coupled
   * read path).
   */
  recurrence: {
    templates: number;
    undecodable: number;
    detail: string;
  };
  /**
   * Local-history integrity: writes that were STARTED but whose result was
   * never recorded (M3). Each mutation records its intent before touching the
   * app and its outcome after; an intent with no recorded outcome means the
   * process died mid-write, so a change may have been applied without being
   * saved to the local history. A non-zero count is advisory, not a failure.
   */
  audit: {
    orphanedIntents: number;
    newestOrphanIntent: string | null;
  };
  /**
   * The optional helper pair (docs/design/agent-daemon.md §3b–§3c): what
   * routing is configured to do, what it actually resolved to in THIS process,
   * and each half's installation/liveness/signing/grant state. Prompt-free —
   * every field comes from the same probes `things helpers status` runs, so
   * doctor never triggers a consent dialog of its own.
   */
  helpers: HelpersReport;
  /**
   * Freshness + sync-liveness proxies for long-running headless operation
   * (docs/lab/headless-research.md SYNC1 + SYNC2): app-running, WAL write
   * activity, last local edit, last foreground, and — only when a Things Cloud
   * account is attached — the sync engine's last-attempt timestamp.
   */
  syncHealth: SyncHealth;
}

export interface DiagnoseOptions {
  /**
   * Actively test Automation consent by querying Things once. Opt-in: on an
   * unauthorized machine the probe makes macOS show the consent prompt
   * (useful during onboarding, unwanted headless). Skipped when Things is
   * not running so a diagnostic never launches the app.
   */
  probeAutomation?: boolean;
  /**
   * Actively test Accessibility consent + the ui recipe canary by querying the
   * Things UI tree once. Opt-in for the same reason as probeAutomation: the
   * probe itself can make macOS show the Accessibility prompt.
   */
  probeAccessibility?: boolean;
  /** Test seams. */
  probeDeps?: AutomationProbeDeps;
  /** Test seam for the Accessibility probe. */
  accessibilityProbeDeps?: AccessibilityProbeDeps;
  environment?: EnvironmentTracker;
  availability?: AvailabilityDeps;
  /** Test seams for the sync-health section (clock, process check, WAL/plist readers). */
  syncHealth?: SyncHealthDeps;
  /**
   * Test seam for the helpers section. Without it the section probes the real
   * machine (launchd, sockets, codesign) — honest for a diagnostic, useless for
   * an assertion, since the host running the suite may have live helpers.
   */
  helpers?: HelpersReportDeps;
  /** Directory holding the audit JSONL files; defaults to the state dir. Test seam. */
  auditDir?: string;
}

export interface DiagnoseResult {
  report: DiagnoseReport | null;
  error: { code: ErrorCode; message: string; remediation?: string } | null;
  exitCode: ExitCode;
  meta: Pick<EnvelopeMeta, "dbVersion" | "fingerprint">;
}

/**
 * Which bundled Apple Shortcuts proxies are installed — a standalone
 * environment accessor that needs no database (the shortcuts probe is a pure
 * host check). The public capability behind `things setup`; the full
 * {@link diagnose} report carries the same state under `availability.shortcuts`.
 */
export function shortcutProxies(deps: AvailabilityDeps = {}): ShortcutsState {
  return readShortcutProxies(deps);
}

export function diagnose(dbPath?: string, options: DiagnoseOptions = {}): DiagnoseResult {
  // The capability verdict comes FIRST and prompt-free (permissions doctrine,
  // Articles I–III). Doctor is the command people run when access is broken, so
  // it must be able to say "you hold nothing, here is how to fix it" without
  // itself opening the container and raising the dialog it is diagnosing.
  const capability = {
    read: readCapability(dbPath !== undefined ? { dbPath } : {}),
    write: writeCapability(),
    ui: uiCapability(),
  };
  if (!readAllowed(capability.read)) {
    return {
      report: null,
      error: {
        code: "environment",
        message: `the Things database cannot be read: ${capability.read.detail}`,
        remediation: capability.read.remediation.join("; "),
      },
      exitCode: ExitCode.Environment,
      meta: { dbVersion: null, fingerprint: "unknown" },
    };
  }
  // Mirror openThings: deputy-brokered database access for the default
  // container db, local open for explicit paths (src/deputy/routing.ts).
  const routedDbPath = deputyRoutesDb(dbPath !== undefined ? { dbPath } : undefined)
    ? deputyDbPath()
    : null;
  let located: ReturnType<typeof locateThingsDb>;
  try {
    located =
      routedDbPath !== null
        ? { path: routedDbPath, source: "deputy", otherCandidates: [] }
        : locateThingsDb(dbPath ? { dbPath } : undefined);
  } catch (err) {
    if (err instanceof ThingsDbNotFoundError) {
      return {
        report: null,
        error: {
          code: "environment",
          message: err.message,
          remediation: "Install Things 3 and launch it once, or set THINGS_DB.",
        },
        exitCode: ExitCode.Environment,
        meta: { dbVersion: null, fingerprint: "unknown" },
      };
    }
    throw err;
  }

  let conn: ReturnType<typeof openConnection>;
  try {
    conn =
      routedDbPath !== null
        ? { db: createDeputyDbFacade(), path: routedDbPath, close() {} }
        : openConnection(located.path);
  } catch (err) {
    if (err instanceof ThingsDbOpenError) {
      return {
        report: null,
        error: {
          code: "environment",
          message: err.message,
          remediation: "Launch Things once so the WAL sidecars exist, then retry.",
        },
        exitCode: ExitCode.Environment,
        meta: { dbVersion: null, fingerprint: "unknown" },
      };
    }
    throw err;
  }

  try {
    const observation = observeSchema(conn.db);
    const status = compareToBaseline(observation, BASELINES);
    // The pipeline honors a user-accepted drifted fingerprint (loud escape
    // hatch, design §6) — doctor must report what will actually happen.
    const config = loadConfig();
    const accepted =
      status.kind === "drift" && config.acceptedFingerprint === observation.fingerprint;
    const fingerprintStatus = accepted
      ? "user-accepted"
      : status.kind === "ok"
        ? "ok"
        : status.kind === "drift"
          ? "drift"
          : "unknown-version";
    const writesEnabled = status.kind === "ok" || accepted;
    const sdefCanary = sdefDeclaresPrivateReorder();
    const tracker = options.environment ?? createEnvironmentTracker(PKG_VERSION);
    const currentEnv = tracker.capture();
    const recordedEnv = tracker.load();
    const extraColumns: Record<string, string[]> = {};
    for (const t of observation.tables) {
      if (t.extraColumns.length > 0) extraColumns[t.table] = t.extraColumns;
    }
    // Resolve the ambient scope (env / stored) for the report — the MCP flag is
    // per-process and not visible here. A stored ref that no longer resolves is
    // a fail-closed empty jail (reads empty, writes refused), reported as such.
    const scopeReport: DiagnoseReport["scope"] = (() => {
      if (config.scope == null) {
        return { requested: null, source: null, resolved: null, detail: "unscoped" };
      }
      try {
        const s = resolveScope(conn.db, config.scope.ref, config.scope.source);
        return {
          requested: config.scope.ref,
          source: config.scope.source,
          resolved: { kind: s.kind, uuid: s.uuid, title: s.title },
          detail: `scoped to ${s.kind} "${s.title}" (source: ${config.scope.source})`,
        };
      } catch {
        return {
          requested: config.scope.ref,
          source: config.scope.source,
          resolved: null,
          detail:
            `scope "${config.scope.ref}" (source: ${config.scope.source}) resolves to no ` +
            "container — a fail-closed empty jail (reads empty, writes refused). Clear or fix it.",
        };
      }
    })();
    const report: DiagnoseReport = {
      capability,
      db: {
        path: located.path,
        source: located.source,
        otherCandidates: located.otherCandidates,
        databaseVersion: observation.databaseVersion,
      },
      fingerprint: {
        status: fingerprintStatus,
        value: observation.fingerprint,
        expected: status.kind === "drift" ? status.expected : null,
        detail: status.kind === "drift" ? status.detail : [],
        extraColumns,
      },
      app: {
        installed: existsSync(THINGS_APP),
        version: currentEnv.thingsVersion,
        certifiedVersion: config.certifiedAppVersion,
        behavioralDrift:
          currentEnv.thingsVersion !== null &&
          config.certifiedAppVersion !== null &&
          currentEnv.thingsVersion !== config.certifiedAppVersion,
      },
      writes: {
        enabled: writesEnabled,
        reason: accepted
          ? "DRIFTED fingerprint accepted by user config (accepted-fingerprint) — writes " +
            "enabled AT YOUR OWN RISK; every audit record carries fingerprint:user-accepted"
          : writesEnabled
            ? "schema fingerprint matches shipped baseline"
            : status.kind === "drift"
              ? "schema fingerprint deviates from baseline — writes disabled until revalidated"
              : "unknown databaseVersion — update things-api or revalidate",
      },
      scope: scopeReport,
      experimental: {
        enabled: config.allowExperimental,
        sdefDeclaresReorder: sdefCanary,
        reason: !config.allowExperimental
          ? "off — native reorder disabled (`things config set allow-experimental true` to opt in)"
          : sdefCanary
            ? "on — private reorder command still declared in the app sdef"
            : "on BUT the app sdef no longer declares the private reorder command (removed by " +
              "an update?) — native reorder is blocked by the canary",
      },
      environment: {
        current: currentEnv,
        lastVerifiedWrite: recordedEnv,
        changes: diffEnvironment(recordedEnv, currentEnv),
      },
      automation:
        options.probeAutomation === true
          ? probeAutomation(options.probeDeps)
          : {
              status: "not-probed",
              detail:
                "opt-in: pass --probe-automation to actively test Automation consent (may " +
                "show a one-time macOS prompt; skipped when Things is not running)",
            },
      ui: {
        enabled: config.ui.enabled,
        appRunning: isThingsRunning(),
        accessibility:
          options.probeAccessibility === true
            ? probeAccessibility(options.accessibilityProbeDeps)
            : {
                status: "not-probed",
                detail:
                  "opt-in: pass --probe-accessibility to test Accessibility consent + the recipe " +
                  "canary (may show a one-time macOS prompt; skipped when Things is not running)",
              },
        certificationProfile: UI_CERTIFICATION_PROFILE,
        certification: allCertifications().map(({ op, entry }) => ({
          op,
          status: entry.status,
        })),
        reason: config.ui.enabled
          ? "on — GUI-driven ops available (each still needs --dangerously-drive-gui and grants " +
            "Accessibility; recipes are uncertified until a real-hardware sitting)"
          : "off — GUI-driven ops unavailable (`things config set ui-enabled true` to opt in; " +
            "intended for a dedicated always-on Mac, see docs/setup.md)",
      },
      availability: {
        urlScheme: readUrlSchemeEnabled(options.availability),
        shortcuts: readShortcutProxies(options.availability),
      },
      recurrence: scanRecurrenceRules(conn.db),
      helpers: buildHelpersReport(config.helpersMode, options.helpers),
      syncHealth: computeSyncHealth(conn.db, located.path, options.syncHealth),
      audit: scanAuditIntegrity(readAuditRecords(options.auditDir ?? auditDir())),
    };
    return {
      report,
      error: null,
      exitCode: writesEnabled ? ExitCode.Ok : ExitCode.DriftBlocked,
      meta: {
        dbVersion: observation.databaseVersion,
        fingerprint: fingerprintStatus === "unknown-version" ? "unknown" : fingerprintStatus,
      },
    };
  } finally {
    conn.close();
  }
}
