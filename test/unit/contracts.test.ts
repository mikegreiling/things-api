import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";

import {
  aggregateExitCode,
  API_VERSION,
  blockedCode,
  errorEnvelope,
  ExitCode,
  okEnvelope,
  PKG_VERSION,
  verifyFailedCode,
} from "../../src/contracts.ts";

describe("exit-code contract", () => {
  it("never renumbers published codes", () => {
    expect(ExitCode).toEqual({
      Ok: 0,
      Unexpected: 1,
      Usage: 2,
      VerifyFailed: 3,
      Blocked: 4,
      DriftBlocked: 5,
      Unsupported: 6,
      Environment: 7,
    });
  });
});

describe("json envelope contract", () => {
  const meta = { dbVersion: 26, fingerprint: "ok", elapsedMs: 12 } as const;

  it("wraps success payloads with apiVersion and kind", () => {
    const env = okEnvelope("today", { today: [], evening: [] }, meta);
    expect(env).toEqual({
      apiVersion: API_VERSION,
      ok: true,
      kind: "today",
      data: { today: [], evening: [] },
      meta,
    });
  });

  it("wraps errors with stable code and remediation", () => {
    const env = errorEnvelope(
      {
        code: "drift-blocked",
        message: "schema fingerprint mismatch",
        remediation: "run `things doctor`",
      },
      meta,
    );
    expect(env.ok).toBe(false);
    expect(env.kind).toBe("error");
    expect(env.error.code).toBe("drift-blocked");
  });
});

describe("error-code builders", () => {
  it("blockedCode prefers the hazard id, falling back to the block reason", () => {
    expect(blockedCode({ hazard: "H-PERMANENT-DELETE", reason: "hazard" })).toBe(
      "blocked:H-PERMANENT-DELETE",
    );
    expect(blockedCode({ reason: "drift" })).toBe("blocked:drift");
    expect(blockedCode({ reason: "disruption-tier" })).toBe("blocked:disruption-tier");
    expect(blockedCode({ reason: "environment" })).toBe("blocked:environment");
  });

  it("verifyFailedCode namespaces the reason", () => {
    expect(verifyFailedCode({ reason: "timeout" })).toBe("verify-failed:timeout");
    expect(verifyFailedCode({ reason: "mismatch" })).toBe("verify-failed:mismatch");
    expect(verifyFailedCode({ reason: "silent-noop" })).toBe("verify-failed:silent-noop");
  });
});

describe("aggregate exit code", () => {
  it("is Ok for no failures", () => {
    expect(aggregateExitCode([])).toBe(ExitCode.Ok);
  });

  it("maps a lone failure kind to its exit code", () => {
    expect(aggregateExitCode([{ kind: "verify-failed", reason: "timeout" }])).toBe(
      ExitCode.VerifyFailed,
    );
    expect(aggregateExitCode([{ kind: "invalid" }])).toBe(ExitCode.VerifyFailed);
    expect(aggregateExitCode([{ kind: "unsupported" }])).toBe(ExitCode.Unsupported);
    expect(aggregateExitCode([{ kind: "blocked", reason: "hazard" }])).toBe(ExitCode.Blocked);
    expect(aggregateExitCode([{ kind: "blocked", reason: "drift" }])).toBe(ExitCode.DriftBlocked);
  });

  it("applies precedence drift > blocked > unsupported > verify-failed", () => {
    // The regression this guards: unsupported must outrank a plain
    // verify-failed/invalid (the batch path used to exit 3 here, not 6).
    expect(
      aggregateExitCode([{ kind: "verify-failed", reason: "mismatch" }, { kind: "unsupported" }]),
    ).toBe(ExitCode.Unsupported);
    expect(aggregateExitCode([{ kind: "invalid" }, { kind: "unsupported" }])).toBe(
      ExitCode.Unsupported,
    );
    // blocked outranks unsupported...
    expect(
      aggregateExitCode([{ kind: "unsupported" }, { kind: "blocked", reason: "hazard" }]),
    ).toBe(ExitCode.Blocked);
    // ...and a drift block outranks everything.
    expect(
      aggregateExitCode([
        { kind: "unsupported" },
        { kind: "blocked", reason: "hazard" },
        { kind: "blocked", reason: "drift" },
      ]),
    ).toBe(ExitCode.DriftBlocked);
  });
});

describe("version lockstep", () => {
  it("PKG_VERSION matches package.json", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as {
      version: string;
    };
    expect(PKG_VERSION).toBe(pkg.version);
  });
});
