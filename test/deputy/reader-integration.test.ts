/**
 * Live certification of the REAL sandboxed reader (deputy/reader). Gated like
 * the broker suite (darwin + THINGS_DEPUTY_LIVE=1 + swiftc) PLUS a signing
 * identity — amfid kills sandboxed code without a real certificate chain — and
 * skipped when a production reader already answers on this machine (spawning a
 * second instance would steal its socket).
 *
 * Asserts the sandbox-visible contract only: handshake (role/granted), the
 * fail-closed not-granted refusal, and verb gating. The GRANTED read path is
 * VM-certified end-to-end by SANDBOX1 (docs/lab/sandbox1-scoped-reader.md) —
 * it needs a one-time human panel, which no CI or unattended host can click.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DeputySyncBridge } from "../../src/deputy/bridge.ts";
import { readerSocketPath, readerTokenPath } from "../../src/deputy/protocol.ts";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const appBinary = join(repoRoot, "deputy/build/things-reader.app/Contents/MacOS/things-reader");

function hasSigningIdentity(): boolean {
  try {
    const out = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], {
      encoding: "utf8",
      timeout: 20_000,
    });
    return /Developer ID Application|Apple Development/.test(out);
  } catch {
    return false;
  }
}

// The reader's home is fixed by its bundle id — no env override reaches the
// sandbox. A production reader already serving there must not be disturbed.
const productionReaderPresent = existsSync(readerSocketPath({}));

const runnable =
  process.platform === "darwin" &&
  process.env["THINGS_DEPUTY_LIVE"] === "1" &&
  !productionReaderPresent &&
  hasSigningIdentity();

describe.skipIf(!runnable)("things-reader (live sandboxed bundle)", () => {
  let child: ChildProcess;
  let bridge: DeputySyncBridge;
  let token: string;

  beforeAll(async () => {
    if (!existsSync(appBinary)) {
      execFileSync("bash", ["scripts/build-deputy.sh"], { cwd: repoRoot, stdio: "ignore" });
    }
    child = spawn(appBinary, ["--serve"], { stdio: "ignore" });
    const socket = readerSocketPath({});
    const tokenFile = readerTokenPath({});
    const deadline = Date.now() + 10_000;
    while (!existsSync(socket) || !existsSync(tokenFile)) {
      if (Date.now() > deadline) throw new Error("reader did not come up within 10s");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    token = execFileSync("cat", [tokenFile], { encoding: "utf8" }).trim();
    bridge = new DeputySyncBridge(socket);
  }, 120_000);

  afterAll(() => {
    bridge?.close();
    child?.kill("SIGTERM");
    setTimeout(() => child?.kill("SIGKILL"), 1000).unref();
  });

  function request(fields: Record<string, unknown>): Record<string, unknown> {
    return bridge.request({ v: 1, token, ...fields }, 10_000);
  }

  it("handshakes as a reader with an explicit grant state", () => {
    const res = request({ verb: "hello" });
    expect(res["ok"]).toBe(true);
    expect(res["role"]).toBe("reader");
    expect(typeof res["granted"]).toBe("boolean");
  });

  it("without a grant, file verbs refuse with the ceremony pointer (never a prompt)", () => {
    const hello = request({ verb: "hello" });
    if (hello["granted"] === true) return; // a granted dev machine: covered by SANDBOX1 cells
    const res = request({ verb: "locate" });
    expect(res["ok"]).toBe(false);
    expect((res["error"] as { code: string }).code).toBe("not-granted");
    expect((res["error"] as { message: string }).message).toContain("things deputy grant");
  });

  it("automation verbs are structurally absent", () => {
    const res = request({ verb: "osascript", script: "tell app", timeoutMs: 1000 });
    expect(res["ok"]).toBe(false);
    expect((res["error"] as { code: string }).code).toBe("unsupported-verb");
  });

  it("rejects a bad token", () => {
    const res = bridge.request({ v: 1, token: "0".repeat(64), verb: "hello" }, 10_000);
    expect(res["ok"]).toBe(false);
    expect((res["error"] as { code: string }).code).toBe("bad-token");
  });
});
