/**
 * Config precedence: env > stored > default, with the boolean/profile env
 * overrides recognized BIDIRECTIONALLY (a recognized value wins over stored
 * config in either direction; an unset/unrecognized one falls through). Tests
 * pass a synthetic env pointing at a temp config dir, so they never touch the
 * real process env or the user's config file.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { describeConfig, loadConfig, saveConfigKey } from "../../src/config.ts";

let configDir: string;

/** A hermetic env whose config dir is our temp dir, plus any overrides. */
function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { THINGS_API_CONFIG_DIR: configDir, ...overrides };
}

/** Provenance of one key from `describeConfig` under the given env. */
function sourceOf(key: string, e: NodeJS.ProcessEnv): string | undefined {
  return describeConfig(e).find((v) => v.key === key)?.source;
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "things-api-config-unit-"));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

describe("boolean env overrides are bidirectional", () => {
  it("THINGS_API_UI_ENABLED=false forces the vector off against a stored true", () => {
    saveConfigKey("uiEnabled", true, env());
    expect(loadConfig(env()).ui.enabled).toBe(true); // stored true, no env
    expect(loadConfig(env({ THINGS_API_UI_ENABLED: "false" })).ui.enabled).toBe(false);
    expect(loadConfig(env({ THINGS_API_UI_ENABLED: "true" })).ui.enabled).toBe(true);
  });

  it("THINGS_API_UI_ENABLED=true forces the vector on against a stored false", () => {
    saveConfigKey("uiEnabled", false, env());
    expect(loadConfig(env()).ui.enabled).toBe(false);
    expect(loadConfig(env({ THINGS_API_UI_ENABLED: "true" })).ui.enabled).toBe(true);
  });

  it("THINGS_API_ALLOW_EXPERIMENTAL=false forces it off against a stored true", () => {
    saveConfigKey("allowExperimental", true, env());
    expect(loadConfig(env()).allowExperimental).toBe(true);
    expect(loadConfig(env({ THINGS_API_ALLOW_EXPERIMENTAL: "false" })).allowExperimental).toBe(
      false,
    );
    expect(loadConfig(env({ THINGS_API_ALLOW_EXPERIMENTAL: "true" })).allowExperimental).toBe(true);
  });

  it("THINGS_API_AUDIT accepts on as well as the legacy off", () => {
    saveConfigKey("auditEnabled", false, env());
    expect(loadConfig(env()).auditEnabled).toBe(false); // stored false
    expect(loadConfig(env({ THINGS_API_AUDIT: "on" })).auditEnabled).toBe(true);
    // Legacy off still wins over a stored true.
    saveConfigKey("auditEnabled", true, env());
    expect(loadConfig(env({ THINGS_API_AUDIT: "off" })).auditEnabled).toBe(false);
  });

  it("THINGS_API_BOUNCE_ENABLED forces the bounce off/on bidirectionally", () => {
    expect(loadConfig(env()).bounceEnabled).toBe(true); // default on
    saveConfigKey("bounceEnabled", true, env());
    expect(loadConfig(env({ THINGS_API_BOUNCE_ENABLED: "false" })).bounceEnabled).toBe(false);
    saveConfigKey("bounceEnabled", false, env());
    expect(loadConfig(env()).bounceEnabled).toBe(false); // stored false
    expect(loadConfig(env({ THINGS_API_BOUNCE_ENABLED: "true" })).bounceEnabled).toBe(true);
  });

  it("THINGS_API_BOUNCE_MAX_ITEMS accepts a positive int and defaults to 30", () => {
    expect(loadConfig(env()).bounceMaxItems).toBe(30);
    expect(loadConfig(env({ THINGS_API_BOUNCE_MAX_ITEMS: "50" })).bounceMaxItems).toBe(50);
    saveConfigKey("bounceMaxItems", 12, env());
    expect(loadConfig(env()).bounceMaxItems).toBe(12); // stored
    expect(loadConfig(env({ THINGS_API_BOUNCE_MAX_ITEMS: "5" })).bounceMaxItems).toBe(5); // env wins
    // A non-positive / non-integer env value falls through to stored, then default.
    expect(loadConfig(env({ THINGS_API_BOUNCE_MAX_ITEMS: "0" })).bounceMaxItems).toBe(12);
    expect(loadConfig(env({ THINGS_API_BOUNCE_MAX_ITEMS: "-4" })).bounceMaxItems).toBe(12);
    expect(loadConfig(env({ THINGS_API_BOUNCE_MAX_ITEMS: "abc" })).bounceMaxItems).toBe(12);
  });

  it("allow-experimental now defaults to TRUE (private-surface on by default)", () => {
    expect(loadConfig(env()).allowExperimental).toBe(true);
    expect(loadConfig(env({ THINGS_API_ALLOW_EXPERIMENTAL: "false" })).allowExperimental).toBe(
      false,
    );
  });

  it("an unrecognized boolean env value falls through to stored/default", () => {
    saveConfigKey("uiEnabled", true, env());
    expect(loadConfig(env({ THINGS_API_UI_ENABLED: "yes" })).ui.enabled).toBe(true); // stored
    // No stored value + garbage env → built-in default (false).
    rmSync(configDir, { recursive: true, force: true });
    configDir = mkdtempSync(join(tmpdir(), "things-api-config-unit-"));
    expect(loadConfig(env({ THINGS_API_UI_ENABLED: "1" })).ui.enabled).toBe(false);
  });
});

describe("THINGS_API_PROFILE accepts both profiles", () => {
  it("workstation env wins over a stored dedicated-server", () => {
    saveConfigKey("profile", "dedicated-server", env());
    expect(loadConfig(env()).profile).toBe("dedicated-server");
    expect(loadConfig(env({ THINGS_API_PROFILE: "workstation" })).profile).toBe("workstation");
  });

  it("dedicated-server env wins over a stored workstation", () => {
    saveConfigKey("profile", "workstation", env());
    expect(loadConfig(env({ THINGS_API_PROFILE: "dedicated-server" })).profile).toBe(
      "dedicated-server",
    );
  });

  it("an unrecognized profile env value falls through to the default", () => {
    expect(loadConfig(env({ THINGS_API_PROFILE: "laptop" })).profile).toBe("workstation");
  });

  it("the profile default drives maxDisruption when nothing else sets it", () => {
    expect(loadConfig(env()).maxDisruption).toBe(1); // workstation
    expect(loadConfig(env({ THINGS_API_PROFILE: "dedicated-server" })).maxDisruption).toBe(2);
  });
});

describe("describeConfig provenance reflects the winning layer", () => {
  it("labels a value forced off by env as source=env", () => {
    saveConfigKey("uiEnabled", true, env());
    expect(sourceOf("ui-enabled", env({ THINGS_API_UI_ENABLED: "false" }))).toBe("env");
  });

  it("labels a stored value as stored and an untouched key as default", () => {
    saveConfigKey("allowExperimental", true, env());
    expect(sourceOf("allow-experimental", env())).toBe("stored");
    expect(sourceOf("actor", env())).toBe("default");
  });

  it("labels the bounce keys' provenance (env > stored > default)", () => {
    expect(sourceOf("bounce-enabled", env())).toBe("default");
    expect(sourceOf("bounce-max-items", env())).toBe("default");
    saveConfigKey("bounceMaxItems", 20, env());
    expect(sourceOf("bounce-max-items", env())).toBe("stored");
    expect(sourceOf("bounce-max-items", env({ THINGS_API_BOUNCE_MAX_ITEMS: "40" }))).toBe("env");
    expect(sourceOf("bounce-enabled", env({ THINGS_API_BOUNCE_ENABLED: "false" }))).toBe("env");
  });

  it("labels host and the profile-derived maxDisruption default as derived", () => {
    expect(sourceOf("host", env())).toBe("derived");
    expect(sourceOf("maxDisruption", env())).toBe("derived");
    // A stored tier reads stored; an env tier reads env.
    saveConfigKey("maxDisruption", 2, env());
    expect(sourceOf("maxDisruption", env())).toBe("stored");
    expect(sourceOf("maxDisruption", env({ THINGS_API_MAX_DISRUPTION: "3" }))).toBe("env");
  });

  it("includes host in the full listing", () => {
    const keys = describeConfig(env()).map((v) => v.key);
    expect(keys).toContain("host");
  });
});

describe("certified-app-version (behavioral-drift baseline)", () => {
  it("defaults to null (never certified) and round-trips a stored value", () => {
    expect(loadConfig(env()).certifiedAppVersion).toBeNull();
    expect(sourceOf("certified-app-version", env())).toBe("default");
    saveConfigKey("certifiedAppVersion", "3.22.11", env());
    expect(loadConfig(env()).certifiedAppVersion).toBe("3.22.11");
    expect(sourceOf("certified-app-version", env())).toBe("stored");
  });

  it("clears back to null when set to null", () => {
    saveConfigKey("certifiedAppVersion", "3.22.11", env());
    saveConfigKey("certifiedAppVersion", null, env());
    expect(loadConfig(env()).certifiedAppVersion).toBeNull();
  });
});
