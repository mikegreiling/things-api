import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";

import {
  API_VERSION,
  errorEnvelope,
  ExitCode,
  okEnvelope,
  PKG_VERSION,
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
