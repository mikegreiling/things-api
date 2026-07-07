/**
 * Environment/database/fingerprint health report — the library function
 * behind `things doctor` and the MCP doctor tool. Read-only: opens the DB,
 * observes the schema, checks the app bundle and the experimental canary.
 */
import { existsSync } from "node:fs";

import { loadConfig } from "./config.ts";
import { BASELINES } from "./db/baselines/index.ts";
import { openConnection, ThingsDbOpenError } from "./db/connection.ts";
import { compareToBaseline, observeSchema } from "./db/fingerprint.ts";
import { locateThingsDb, ThingsDbNotFoundError } from "./db/locate.ts";
import {
  probeAutomation,
  type AutomationProbeDeps,
  type AutomationProbeStatus,
} from "./write/automation-probe.ts";
import {
  createEnvironmentTracker,
  diffEnvironment,
  type EnvironmentChange,
  type EnvironmentTracker,
  type EnvironmentTuple,
} from "./write/environment.ts";
import { sdefDeclaresPrivateReorder } from "./write/experimental.ts";
import { ExitCode, PKG_VERSION, type EnvelopeMeta } from "./contracts.ts";

const THINGS_APP = "/Applications/Things3.app";

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
}

export interface DiagnoseOptions {
  /**
   * Actively test Automation consent by querying Things once. Opt-in: on an
   * unauthorized machine the probe makes macOS show the consent prompt
   * (useful during onboarding, unwanted headless). Skipped when Things is
   * not running so a diagnostic never launches the app.
   */
  probeAutomation?: boolean;
  /** Test seams. */
  probeDeps?: AutomationProbeDeps;
  environment?: EnvironmentTracker;
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
