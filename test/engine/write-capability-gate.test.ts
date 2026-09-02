/**
 * The write gate (Articles I + II), the GUI gate (Article IV), and the
 * URL-scheme gate (Things' own authorization; URLEN1, #611) —
 * docs/design/permissions-doctrine.md.
 *
 * The AppleScript vector sends a real Apple Event, and on a machine macOS has
 * no consent record for, that event IS the dialog. So the pipeline establishes
 * app-control standing prompt-free BEFORE dispatch and refuses on anything
 * short of a grant. The property under test throughout: a refusal must reach
 * the caller with remediation and WITHOUT the vector ever executing.
 *
 * SAFETY: the vector is a fake and the capability verdict is injected — no
 * osascript runs, and nothing reads this host's real TCC state.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AuditRecord } from "../../src/audit/schema.ts";
import type { UiCapability, UrlSchemeCapability, WriteCapability } from "../../src/capability.ts";
import type { ThingsApiConfig } from "../../src/config.ts";
import type { FingerprintStatus } from "../../src/db/fingerprint.ts";
import { runMutation, type WriteDeps } from "../../src/write/pipeline.ts";
import type {
  CompiledInvocation,
  ExecuteResult,
  VectorMatrix,
  WriteVector,
} from "../../src/write/vectors/types.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedTodo } from "../fixtures/seed.ts";

const NOW = new Date("2026-07-05T12:00:00Z");

// `todo.delete` compiles for the AppleScript vector ALONE (src/write/commands.ts),
// so the vector under test is not a planner accident.
const MATRIX: VectorMatrix = {
  "todo.delete": { support: "yes", disruption: 0, validation: "validated" },
};

const CONFIG: ThingsApiConfig = {
  profile: "workstation",
  maxDisruption: 1,
  actor: "test-actor",
  auditEnabled: true,
  acceptedFingerprint: null,
  certifiedAppVersion: null,
  allowExperimental: false,
  experimentalAreaReorder: true,
  bounceEnabled: true,
  bounceMaxItems: 30,
  autoLaunch: true,
  helpersMode: "false",
  ui: { enabled: false },
  host: "test-host",
};

const HOST = { bundleId: "com.mitchellh.ghostty", name: "Ghostty" };

function capability(over: Partial<WriteCapability>): WriteCapability {
  return { mode: "direct-granted", detail: "granted", remediation: [], host: HOST, ...over };
}

let fixture: FixtureDb;
let auditRecords: AuditRecord[];
let lockSeq = 0;

beforeEach(() => {
  fixture = buildFixtureDb();
  auditRecords = [];
});
afterEach(() => {
  fixture.close();
});

/**
 * A stand-in for the AppleScript vector that APPLIES the delta to the fixture
 * (marks the row trashed) rather than only recording the call — otherwise the
 * pipeline's read-after-write verification waits for a change that never lands.
 */
function fakeAppleScriptVector(uuid: string): {
  vector: WriteVector;
  calls: CompiledInvocation[];
} {
  const calls: CompiledInvocation[] = [];
  return {
    calls,
    vector: {
      id: "applescript",
      matrix: MATRIX,
      // What actually arms the gate — the real vector sets this; fakes that
      // send nothing deliberately do not, so ordinary engine tests are not
      // subject to the developer's own TCC state.
      sendsAppleEvents: true,
      async execute(invocation): Promise<ExecuteResult> {
        calls.push(invocation);
        fixture.db.prepare("UPDATE TMTask SET trashed = 1 WHERE uuid = ?").run(uuid);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  };
}

function deps(vector: WriteVector, write: WriteCapability): WriteDeps {
  return {
    db: fixture.db,
    vectors: [vector],
    config: CONFIG,
    audit: { append: (r) => auditRecords.push(r) },
    fingerprint: (): FingerprintStatus => ({
      kind: "ok",
      observation: { databaseVersion: 26, tables: [], fingerprint: "sha256:test" },
    }),
    lockPath: join(tmpdir(), `things-api-writegate-lock-${process.pid}-${lockSeq++}`),
    isAppRunning: () => true,
    ensureRunning: async () => true,
    now: () => NOW,
    writeCapability: () => write,
  };
}

async function update(write: WriteCapability): Promise<{
  result: Awaited<ReturnType<typeof runMutation>>;
  calls: CompiledInvocation[];
}> {
  const uuid = seedTodo(fixture.db, { title: "a synthetic to-do" });
  const { vector, calls } = fakeAppleScriptVector(uuid);
  const result = await runMutation(deps(vector, write), "todo.delete", { uuid });
  return { result, calls };
}

describe("app control missing blocks BEFORE the app is touched", () => {
  it("an unknown standing refuses and points at the ceremony — never at a retry", async () => {
    const { result, calls } = await update(
      capability({
        mode: "direct-unknown",
        detail: "macOS has no app-control record for Ghostty (com.mitchellh.ghostty) yet",
        remediation: ["run `things setup` — it asks for app control once"],
      }),
    );
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") {
      expect(result.reason).toBe("environment");
      expect(result.detail).toContain("drives the Things app");
      expect(result.remediation).toContain("things setup");
    }
    expect(calls, "the Apple Event must never be sent on an unknown standing").toHaveLength(0);
  });

  it("a recorded refusal names the Settings toggle AND the tccutil re-arm", async () => {
    const { result, calls } = await update(
      capability({
        mode: "direct-denied",
        detail: "macOS records a refusal of app control for Ghostty",
        remediation: [
          "turn on Things3 for Ghostty under System Settings ▸ Privacy & Security ▸ Automation",
          "or re-arm the request with `tccutil reset AppleEvents com.mitchellh.ghostty`",
        ],
      }),
    );
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") {
      expect(result.remediation).toContain("System Settings");
      expect(result.remediation).toContain("tccutil reset AppleEvents");
    }
    expect(calls).toHaveLength(0);
  });

  /**
   * A CLOSED Things is liveness, not a missing grant (#617). The gate is the
   * caller with dispatch intent, so it asks for the verdict with the app
   * STARTED — which means a dormant machine resolves rather than refuses, and
   * the only way this refusal shape is reached is a wake that did not take.
   */
  describe("a dormant Things", () => {
    it("asks for the verdict with dispatch intent, so the wake happens before judging", async () => {
      const asked: (string | undefined)[] = [];
      const uuid = seedTodo(fixture.db, { title: "a synthetic to-do" });
      const { vector, calls } = fakeAppleScriptVector(uuid);
      const result = await runMutation(
        {
          ...deps(vector, capability({ mode: "deputy" })),
          writeCapability: (options) => {
            asked.push(options.purpose);
            return capability({ mode: "deputy" });
          },
        },
        "todo.delete",
        { uuid },
      );
      expect(asked).toEqual(["dispatch"]);
      expect(result.kind).not.toBe("blocked");
      expect(calls).toHaveLength(1);
    });

    it("obeys `auto-launch: false` — a survey verdict, so the app is never started", async () => {
      const asked: (string | undefined)[] = [];
      const uuid = seedTodo(fixture.db, { title: "a synthetic to-do" });
      const { vector } = fakeAppleScriptVector(uuid);
      await runMutation(
        {
          ...deps(vector, capability({ mode: "deputy" })),
          config: { ...CONFIG, autoLaunch: false },
          writeCapability: (options) => {
            asked.push(options.purpose);
            return capability({ mode: "deputy" });
          },
        },
        "todo.delete",
        { uuid },
      );
      expect(asked).toEqual(["survey"]);
    });

    it("a wake that did not take refuses on LIVENESS, with no permission steer", async () => {
      const { result, calls } = await update(
        capability({
          mode: "deputy-target-dormant",
          detail:
            "Things is not running and it did not come up within 10s of being started — " +
            "app control for it cannot be read while it is down",
          remediation: ["open Things, then rerun this command"],
        }),
      );
      expect(result.kind).toBe("blocked");
      if (result.kind === "blocked") {
        expect(result.reason).toBe("environment");
        expect(result.detail).toContain("Things is not running");
        expect(result.remediation).toContain("open Things");
        expect(result.remediation).not.toContain("things setup");
      }
      expect(calls, "nothing may be dispatched at a target that is down").toHaveLength(0);
    });
  });

  it("the refusal is recorded as an environment block, not a failed write", async () => {
    await update(capability({ mode: "direct-unknown", remediation: ["run `things setup`"] }));
    expect(auditRecords.length).toBeGreaterThan(0);
    expect(JSON.stringify(auditRecords)).toContain("environment");
  });
});

describe("the gate keys on what a vector DOES, not on its id", () => {
  // Regression: keying the gate on `id === "applescript"` made every engine
  // test that substitutes a fake under that id depend on the developer's own
  // TCC grants — green on a granted workstation, red on CI. The real vector
  // declares `sendsAppleEvents`; a fake that sends nothing does not.
  it("a fake vector under the applescript id is NOT gated on the host's grants", async () => {
    const uuid = seedTodo(fixture.db, { title: "a synthetic to-do" });
    const calls: CompiledInvocation[] = [];
    const silentFake: WriteVector = {
      id: "applescript",
      matrix: MATRIX,
      async execute(invocation): Promise<ExecuteResult> {
        calls.push(invocation);
        fixture.db.prepare("UPDATE TMTask SET trashed = 1 WHERE uuid = ?").run(uuid);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    // The verdict says "no app control" — and it must not matter, because this
    // vector never reaches the app.
    const result = await runMutation(
      deps(silentFake, capability({ mode: "direct-unknown", remediation: ["run `things setup`"] })),
      "todo.delete",
      { uuid },
    );
    expect(result.kind).not.toBe("blocked");
    expect(calls).toHaveLength(1);
  });
});

describe("app control present dispatches exactly as before", () => {
  it("a direct grant on the host app lets the write through", async () => {
    const { result, calls } = await update(capability({ mode: "direct-granted" }));
    expect(result.kind).not.toBe("blocked");
    expect(calls).toHaveLength(1);
  });

  it("an onboarded deputy lets the write through", async () => {
    const { result, calls } = await update(
      capability({ mode: "deputy", detail: "the deputy holds app control for Things" }),
    );
    expect(result.kind).not.toBe("blocked");
    expect(calls).toHaveLength(1);
  });

  // The lab's write-vector escape (docs/lab/harness.md §The lab escapes). A
  // guest shell has no bundle id, so without it every AppleScript-vector verb
  // — and every composite carrying an AppleScript leg — is unreachable in a
  // clone, which is what blocked the write-layer e2e smoke.
  it("the lab's write escape lets the write through", async () => {
    const { result, calls } = await update(
      capability({
        mode: "direct-escape",
        detail: "THINGS_API_WRITE_DIRECT=1 — Apple Events are sent directly under this process",
      }),
    );
    expect(result.kind).not.toBe("blocked");
    expect(calls).toHaveLength(1);
  });
});

/**
 * THE GUI GATE (docs/design/permissions-doctrine.md, Article IV). GUI-driving
 * is granted to the helper pair and to nothing else, so a vector that drives
 * the Things window must be refused prompt-free on any machine that does not
 * hold the tier — never allowed to make the first AX call and raise an
 * Accessibility prompt against whatever host app is running us.
 */
function uiVerdict(over: Partial<UiCapability>): UiCapability {
  return {
    mode: "helpers",
    detail: "the helpers hold Accessibility and app control for System Events",
    remediation: [],
    host: HOST,
    ...over,
  };
}

/** A fake that DECLARES it drives the GUI (what the real ui vector sets). */
function fakeGuiVector(uuid: string): { vector: WriteVector; calls: CompiledInvocation[] } {
  const calls: CompiledInvocation[] = [];
  return {
    calls,
    vector: {
      // Deliberately NOT the "ui" id: the gate keys on the DECLARATION, and
      // `todo.delete` has no ui-vector compilation, so this keeps the cell to
      // one moving part while proving the two are independent.
      id: "applescript",
      matrix: MATRIX,
      drivesGui: true,
      async execute(invocation): Promise<ExecuteResult> {
        calls.push(invocation);
        fixture.db.prepare("UPDATE TMTask SET trashed = 1 WHERE uuid = ?").run(uuid);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  };
}

async function drive(ui: UiCapability): Promise<{
  result: Awaited<ReturnType<typeof runMutation>>;
  calls: CompiledInvocation[];
}> {
  const uuid = seedTodo(fixture.db, { title: "a synthetic to-do" });
  const { vector, calls } = fakeGuiVector(uuid);
  const result = await runMutation(
    { ...deps(vector, capability({ mode: "direct-granted" })), uiCapability: () => ui },
    "todo.delete",
    { uuid },
  );
  return { result, calls };
}

describe("GUI-driving missing blocks BEFORE the Accessibility tree is touched", () => {
  it("ui.enabled false refuses, naming the config knob AND the helpers tier", async () => {
    const { result, calls } = await drive(
      uiVerdict({
        mode: "config-disabled",
        detail: "GUI-driving is switched off on this machine (`ui-enabled` is false)",
        remediation: [
          "run `things config set ui-enabled true` to opt in",
          "then run `things helpers setup --gui` to grant GUI-driving to the helpers",
        ],
      }),
    );
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") {
      expect(result.reason).toBe("environment");
      expect(result.detail).toContain("drives the Things window");
      expect(result.remediation).toContain("things config set ui-enabled true");
      expect(result.remediation).toContain("things helpers setup --gui");
    }
    expect(calls, "no AX call may be made without the tier").toHaveLength(0);
  });

  it("ui.enabled true but the tier ungranted names exactly what is missing", async () => {
    const { result, calls } = await drive(
      uiVerdict({
        mode: "tier-incomplete",
        detail:
          "the helpers are onboarded but the GUI-driving tier is incomplete — missing " +
          "Accessibility; automation → System Events (unknown)",
        remediation: ["run `things helpers setup --gui` to grant GUI-driving to the helpers"],
      }),
    );
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") {
      expect(result.detail).toContain("Accessibility");
      expect(result.detail).toContain("automation → System Events");
      expect(result.remediation).toContain("things helpers setup --gui");
    }
    expect(calls).toHaveLength(0);
  });

  it("no helper answering refuses without ever suggesting direct Accessibility", async () => {
    const { result } = await drive(
      uiVerdict({
        mode: "helpers-missing",
        detail:
          "GUI-driving is granted only to the helpers, and no helper is answering on this machine",
        remediation: ["run `things helpers setup --gui` to grant GUI-driving to the helpers"],
      }),
    );
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") {
      // Article IV: direct AX is unsupported, so it is never offered as a way out.
      expect(result.remediation).not.toContain("Privacy & Security ▸ Accessibility");
    }
  });

  it("an onboarded GUI tier dispatches", async () => {
    const { result, calls } = await drive(uiVerdict({}));
    expect(result.kind).not.toBe("blocked");
    expect(calls).toHaveLength(1);
  });

  it("the lab's documented escape dispatches", async () => {
    const { result, calls } = await drive(
      uiVerdict({ mode: "direct-escape", detail: "THINGS_API_UI_DIRECT=1" }),
    );
    expect(result.kind).not.toBe("blocked");
    expect(calls).toHaveLength(1);
  });

  it("a vector that does NOT declare drivesGui is never GUI-gated", async () => {
    // The same lesson as the AppleScript gate: keying on the id would make the
    // simulator and every fake-vector cell depend on the developer's own grants.
    const uuid = seedTodo(fixture.db, { title: "a synthetic to-do" });
    const calls: CompiledInvocation[] = [];
    const silentFake: WriteVector = {
      id: "applescript",
      matrix: MATRIX,
      async execute(invocation): Promise<ExecuteResult> {
        calls.push(invocation);
        fixture.db.prepare("UPDATE TMTask SET trashed = 1 WHERE uuid = ?").run(uuid);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const result = await runMutation(
      {
        ...deps(silentFake, capability({ mode: "direct-granted" })),
        uiCapability: () => uiVerdict({ mode: "config-disabled", remediation: ["nope"] }),
      },
      "todo.delete",
      { uuid },
    );
    expect(result.kind).not.toBe("blocked");
    expect(calls).toHaveLength(1);
  });
});

// ── The URL-scheme gate (URLEN1, #611) ───────────────────────────────────────
//
// Not a macOS consent class at all — `open -g things:///…` is a LaunchServices
// dispatch. The authorization is the APP's: Settings ▸ General ▸ "Enable Things
// URLs". MEASURED (URLEN1, golden-v4 / Things 3.23), and this is what makes a
// pre-dispatch gate necessary rather than merely tidy: when the setting is off,
// or has never been answered, Things puts a "Things URL Scheme" alert SHEET on
// its own window and PARKS the command behind it. `open` still exits 0, nothing
// changes, and the caller learns about it only when the verify window expires —
// which is exactly the `verify-failed:silent-noop` #611 reported. With nobody
// at the machine the sheets simply stack, one per dispatched command.

function urlVerdict(over: Partial<UrlSchemeCapability>): UrlSchemeCapability {
  return {
    mode: "enabled",
    detail: "Things ▸ Settings ▸ General ▸ Enable Things URLs is on",
    remediation: [],
    host: HOST,
    ...over,
  };
}

/** A fake that DECLARES it dispatches URLs (what the real url-scheme vector sets). */
function fakeUrlVector(uuid: string): { vector: WriteVector; calls: CompiledInvocation[] } {
  const calls: CompiledInvocation[] = [];
  return {
    calls,
    vector: {
      // As with the GUI cells: deliberately NOT the "url-scheme" id, because the
      // gate keys on the DECLARATION and `todo.delete` compiles for applescript.
      id: "applescript",
      matrix: MATRIX,
      dispatchesUrls: true,
      async execute(invocation): Promise<ExecuteResult> {
        calls.push(invocation);
        fixture.db.prepare("UPDATE TMTask SET trashed = 1 WHERE uuid = ?").run(uuid);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  };
}

async function dispatchUrl(urlScheme: UrlSchemeCapability): Promise<{
  result: Awaited<ReturnType<typeof runMutation>>;
  calls: CompiledInvocation[];
}> {
  const uuid = seedTodo(fixture.db, { title: "a synthetic to-do" });
  const { vector, calls } = fakeUrlVector(uuid);
  const result = await runMutation(
    {
      ...deps(vector, capability({ mode: "direct-granted" })),
      urlSchemeCapability: () => urlScheme,
    },
    "todo.delete",
    { uuid },
  );
  return { result, calls };
}

describe("'Enable Things URLs' off blocks BEFORE the URL is dispatched", () => {
  it("an explicitly disabled app refuses, naming the exact Settings path", async () => {
    const { result, calls } = await dispatchUrl(
      urlVerdict({
        mode: "disabled",
        detail:
          "Things ▸ Settings ▸ General ▸ Enable Things URLs is off — the app puts URL " +
          "commands in an alert on its own window and holds them there instead of running them",
        remediation: ["turn on Things ▸ Settings ▸ General ▸ Enable Things URLs, then retry"],
      }),
    );
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") {
      expect(result.reason).toBe("environment");
      expect(result.likelyCause).toBe("feature-disabled");
      expect(result.detail).toContain("delivered as a Things URL");
      expect(result.remediation).toContain("Enable Things URLs");
    }
    expect(calls, "no URL may be opened once the app has said no").toHaveLength(0);
  });

  it("never-asked refuses too — the whole point is to keep the app's OWN alert off an unattended screen", async () => {
    const { result, calls } = await dispatchUrl(
      urlVerdict({
        mode: "never-asked",
        detail: "nobody has answered Things' own 'Things URL Scheme' dialog on this machine",
        remediation: ["turn on Things ▸ Settings ▸ General ▸ Enable Things URLs, then retry"],
      }),
    );
    expect(result.kind).toBe("blocked");
    expect(calls).toHaveLength(0);
  });

  it("the refusal is audited as an environment block, not as a failed write", async () => {
    await dispatchUrl(urlVerdict({ mode: "disabled", remediation: ["turn it on"] }));
    expect(auditRecords.length).toBeGreaterThan(0);
    expect(JSON.stringify(auditRecords)).toContain("environment");
  });

  it("enabled dispatches normally", async () => {
    const { result, calls } = await dispatchUrl(urlVerdict({}));
    expect(result.kind).not.toBe("blocked");
    expect(calls).toHaveLength(1);
  });

  it("UNREADABLE dispatches — a state we cannot read is not a refusal", async () => {
    // The deliberate asymmetry with the app-control gate, where an unknown
    // standing IS refused: there, resolving the unknown means sending the Apple
    // Event that raises the dialog. Here, dispatching costs nothing on the
    // machines this verdict actually occurs on, and the verify plus its
    // likely-cause hint carry the failure if the app turns out to be off.
    const { result, calls } = await dispatchUrl(
      urlVerdict({ mode: "unreadable", detail: "the preferences file could not be read" }),
    );
    expect(result.kind).not.toBe("blocked");
    expect(calls).toHaveLength(1);
  });

  it("a vector that does NOT declare dispatchesUrls is never URL-gated", async () => {
    // Same lesson as its two siblings: the gate keys on the DECLARATION, so a
    // fake substituted into an engine test never inherits the state of the
    // developer's own Things install. (The id stays "applescript" here because
    // `todo.delete` has no url-scheme compilation at all — which is itself the
    // point: the id is not what arms the gate.)
    const uuid = seedTodo(fixture.db, { title: "a synthetic to-do" });
    const calls: CompiledInvocation[] = [];
    const silentFake: WriteVector = {
      id: "applescript",
      matrix: MATRIX,
      async execute(invocation): Promise<ExecuteResult> {
        calls.push(invocation);
        fixture.db.prepare("UPDATE TMTask SET trashed = 1 WHERE uuid = ?").run(uuid);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const result = await runMutation(
      {
        ...deps(silentFake, capability({ mode: "direct-granted" })),
        urlSchemeCapability: () => urlVerdict({ mode: "disabled", remediation: ["turn it on"] }),
      },
      "todo.delete",
      { uuid },
    );
    expect(result.kind).not.toBe("blocked");
    expect(calls).toHaveLength(1);
  });
});
