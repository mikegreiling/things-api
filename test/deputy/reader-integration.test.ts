/**
 * Live certification of the REAL sandboxed reader (deputy/reader), gated like
 * the broker suite (darwin + THINGS_DEPUTY_LIVE=1 + swiftc) PLUS a signing
 * identity — amfid kills sandboxed code without a real certificate chain.
 *
 * WHAT THIS SUITE CAN STILL ASSERT, and why it is less than it was. Since
 * helpers 1.3.0 the reader does not create its own rendezvous: launchd binds
 * the socket (the LaunchAgent's `Sockets` key) at a path outside the sandbox
 * container and hands over the listening fd at activation, and the access token
 * arrives in an environment variable the same plist carries. There is
 * deliberately NO fallback bind and no self-minted token — that is the point of
 * the design, and an ALPHA package adds no second code path to keep a test
 * convenient. A suite therefore cannot stand the reader up on its own, so what
 * is certified here is the REFUSAL contract: a `--serve` outside its LaunchAgent
 * names what is missing and exits nonzero rather than half-starting.
 *
 * The serving contract — handshake, verb gating, the fail-closed not-granted
 * refusal — is certified where it can actually be exercised: end-to-end under
 * launchd by the live migration a `things helpers setup` performs, and in the VM
 * by SANDBOX1 (docs/lab/sandbox1-scoped-reader.md), which also covers the
 * granted read path (it needs a one-time human panel no CI host can click).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const appBinary = join(
  repoRoot,
  "deputy/build/Things API Helper.app/Contents/Helpers/things-reader.app/Contents/MacOS/things-reader",
);

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

const runnable =
  process.platform === "darwin" &&
  process.env["THINGS_DEPUTY_LIVE"] === "1" &&
  hasSigningIdentity();

describe.skipIf(!runnable)("things-reader (live sandboxed bundle)", () => {
  beforeAll(() => {
    if (!existsSync(appBinary)) {
      execFileSync("bash", ["scripts/build-helpers.sh"], { cwd: repoRoot, stdio: "ignore" });
    }
  }, 300_000);

  /** Run the reader to completion. Every cell here expects a fast exit. */
  function serve(env: NodeJS.ProcessEnv): { status: number | null; stderr: string } {
    const res = spawnSync(appBinary, ["--serve"], {
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, ...env },
    });
    return { status: res.status, stderr: `${res.stdout ?? ""}${res.stderr ?? ""}` };
  }

  it("reports its version without needing launchd at all", () => {
    const res = spawnSync(appBinary, ["--version"], { encoding: "utf8", timeout: 20_000 });
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("refuses to serve without the token its LaunchAgent injects", () => {
    const { status, stderr } = serve({ THINGS_READER_TOKEN: "" });
    expect(status).not.toBe(0);
    expect(stderr).toContain("THINGS_READER_TOKEN is not set");
    expect(stderr).toContain("things helpers setup");
  });

  it("refuses to serve without a launchd-activated socket — it never binds its own", () => {
    // The failure mode this pins: a reader that quietly fell back to binding
    // inside its container would look healthy and put the rendezvous straight
    // back where 1.3.0 took it out of.
    const { status, stderr } = serve({ THINGS_READER_TOKEN: "0".repeat(64) });
    expect(status).not.toBe(0);
    expect(stderr).toContain("no launchd-activated socket");
    expect(stderr).toContain("things helpers setup");
  });
});
