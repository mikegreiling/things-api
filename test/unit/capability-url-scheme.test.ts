/**
 * `urlSchemeCapability` — Things' OWN authorization for the URL scheme
 * (URLEN1, #611).
 *
 * Two things are under test and neither may touch the host: the four verdicts
 * the on-disk value maps to, and the CONSENT DISCIPLINE around reading it. The
 * setting lives in `uriSchemeEnabled` inside the Things group container, which
 * is the same app-data TCC class as the database — so a read attempted from a
 * process with no standing is exactly the "try it and see" the permissions
 * doctrine's Article I corollary forbids. Every probe here is injected; no cell
 * opens a real plist or spawns `plutil`.
 */
import { describe, expect, it } from "vitest";

import {
  urlSchemeAllowed,
  urlSchemeCapability,
  UrlSchemeCapabilityError,
  type CapabilityDeps,
  type ReadCapability,
  type ReadCapabilityMode,
} from "../../src/capability.ts";

const HOST = { bundleId: "com.mitchellh.ghostty", name: "Ghostty" };

function standing(mode: ReadCapabilityMode): ReadCapability {
  return { mode, detail: `test standing: ${mode}`, remediation: [], host: HOST };
}

/**
 * A machine whose container IS reachable, whose plist read succeeds, and whose
 * extract answers `raw`. Passing `raw: null` models the key being absent (the
 * extract throws, exactly as `plutil -extract` does on a missing key path).
 */
function machine(raw: string | null, over: Partial<CapabilityDeps> = {}): CapabilityDeps {
  return {
    env: { __CFBundleIdentifier: HOST.bundleId, HOME: "/nonexistent" },
    lookupAppName: () => HOST.name,
    readStanding: () => standing("direct-fda"),
    readPrefsPlist: () => Buffer.from("irrelevant — the extract seam interprets these bytes"),
    extractUriSchemeEnabled: () => {
      if (raw === null) throw new Error("No value at that key path: uriSchemeEnabled");
      return raw;
    },
    ...over,
  };
}

describe("urlSchemeCapability — the value matrix", () => {
  it("1 → enabled, and enabled is the only verdict with nothing to remediate", () => {
    const cap = urlSchemeCapability(machine("1\n"));
    expect(cap.mode).toBe("enabled");
    expect(cap.remediation).toEqual([]);
    expect(urlSchemeAllowed(cap)).toBe(true);
  });

  it("true → enabled (the plist can hold a boolean as well as an integer)", () => {
    expect(urlSchemeCapability(machine("true")).mode).toBe("enabled");
  });

  it("0 → disabled, refused, and the detail names the exact Settings path", () => {
    const cap = urlSchemeCapability(machine("0\n"));
    expect(cap.mode).toBe("disabled");
    expect(urlSchemeAllowed(cap)).toBe(false);
    expect(cap.detail).toContain("Things ▸ Settings ▸ General ▸ Enable Things URLs");
    expect(cap.remediation.join(" ")).toContain("Enable Things URLs");
  });

  it("false → disabled", () => {
    expect(urlSchemeCapability(machine("false")).mode).toBe("disabled");
  });

  it("key absent → never-asked, refused, and the copy says the command would WAIT", () => {
    const cap = urlSchemeCapability(machine(null));
    expect(cap.mode).toBe("never-asked");
    expect(urlSchemeAllowed(cap)).toBe(false);
    // MEASURED (URLEN1 P2/P3): the app parks the command behind its alert
    // rather than dropping it, which is why the copy must not say "discarded".
    expect(cap.detail).toContain("waits there");
    expect(cap.remediation.join(" ")).toContain("Enable");
  });

  it("an unrecognized value → unreadable and PERMISSIVE, with the value surfaced verbatim", () => {
    const cap = urlSchemeCapability(machine("banana"));
    expect(cap.mode).toBe("unreadable");
    expect(cap.detail).toContain("banana");
    expect(urlSchemeAllowed(cap)).toBe(true);
  });
});

describe("urlSchemeCapability — consent discipline (Article I corollary)", () => {
  const REACHABLE: ReadCapabilityMode[] = ["helpers", "direct-fda", "session-grant"];
  const UNREACHABLE: ReadCapabilityMode[] = [
    "none",
    "helpers-unavailable",
    // A caller-supplied database path says nothing about the container, so the
    // container is left alone rather than opened to find out (Article VI).
    "explicit-db",
  ];

  for (const mode of REACHABLE) {
    it(`read standing '${mode}' already covers the container, so the plist IS read`, () => {
      let opened = 0;
      const cap = urlSchemeCapability(
        machine("1", {
          readStanding: () => standing(mode),
          readPrefsPlist: () => {
            opened += 1;
            return Buffer.from("x");
          },
        }),
      );
      expect(opened).toBe(1);
      expect(cap.mode).toBe("enabled");
    });
  }

  for (const mode of UNREACHABLE) {
    it(`read standing '${mode}' must NOT open the container — unreadable, zero opens`, () => {
      let opened = 0;
      const cap = urlSchemeCapability(
        machine("0", {
          readStanding: () => standing(mode),
          readPrefsPlist: () => {
            opened += 1;
            return Buffer.from("x");
          },
        }),
      );
      expect(opened).toBe(0);
      expect(cap.mode).toBe("unreadable");
      expect(cap.detail).toContain(mode);
      // Permissive: a state we cannot read is never a refusal — the verify and
      // its hint carry that case instead.
      expect(urlSchemeAllowed(cap)).toBe(true);
    });
  }

  it("a plist read that throws degrades to unreadable rather than propagating", () => {
    const cap = urlSchemeCapability(
      machine("1", {
        readPrefsPlist: () => {
          throw Object.assign(new Error("EPERM"), { code: "EPERM" });
        },
      }),
    );
    expect(cap.mode).toBe("unreadable");
    expect(urlSchemeAllowed(cap)).toBe(true);
  });

  it("is STATELESS — every call re-reads, because the human can flip it between commands", () => {
    let value = "1";
    const deps = machine("1", { extractUriSchemeEnabled: () => value });
    expect(urlSchemeCapability(deps).mode).toBe("enabled");
    value = "0";
    expect(urlSchemeCapability(deps).mode).toBe("disabled");
  });
});

describe("UrlSchemeCapabilityError", () => {
  it("carries the verdict and folds its remediation into the message", () => {
    const cap = urlSchemeCapability(machine("0"));
    const err = new UrlSchemeCapabilityError(cap);
    expect(err.name).toBe("UrlSchemeCapabilityError");
    expect(err.capability.mode).toBe("disabled");
    expect(err.message).toContain("Enable Things URLs");
    expect(err.remediation).toEqual(cap.remediation);
  });
});
