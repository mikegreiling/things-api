/**
 * Environment/database/fingerprint health report — the library function
 * behind `things doctor` and the MCP doctor tool. Read-only: opens the DB,
 * observes the schema, checks the app bundle and the experimental canary.
 */
import { existsSync } from "node:fs";

import { loadConfig } from "./config.ts";
import { auditDir } from "./paths.ts";
import { readAuditRecords, scanAuditIntegrity } from "./write/undo.ts";
import { decodeRecurrenceRule } from "./model/recurrence.ts";
import { BASELINES } from "./db/baselines/index.ts";
import { openConnection, ThingsDbOpenError } from "./db/connection.ts";
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
import { ExitCode, PKG_VERSION, type EnvelopeMeta } from "./contracts.ts";

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

export interface DiagnoseReport {
  db: {
    path: string;
    source: "option" | "env" | "container";
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
  };
  writes: {
    enabled: boolean;
    reason: string;
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
  /** Directory holding the audit JSONL files; defaults to the state dir. Test seam. */
  auditDir?: string;
}

export interface DiagnoseResult {
  report: DiagnoseReport | null;
  error: { code: string; message: string; remediation?: string } | null;
  exitCode: ExitCode;
  meta: Pick<EnvelopeMeta, "dbVersion" | "fingerprint">;
}

export function diagnose(dbPath?: string, options: DiagnoseOptions = {}): DiagnoseResult {
  let located: ReturnType<typeof locateThingsDb>;
  try {
    located = locateThingsDb(dbPath ? { dbPath } : undefined);
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
    conn = openConnection(located.path);
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
    const report: DiagnoseReport = {
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
      app: { installed: existsSync(THINGS_APP) },
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
