/**
 * Environment tuple tracking: diffs, consumer phrasing, and the state-file
 * roundtrip behind the consent-churn tripwire.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  captureEnvironment,
  createEnvironmentTracker,
  describeEnvironmentChanges,
  diffEnvironment,
  type EnvironmentTuple,
} from "../../src/write/environment.ts";
import { environmentStatePath } from "../../src/paths.ts";

const TUPLE_A: EnvironmentTuple = {
  thingsVersion: "3.22.11",
  macosVersion: "15.5",
  pkgVersion: "0.3.0",
  nodeBinary: "/usr/local/bin/node",
};

let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "things-api-env-test-"));
  env = { THINGS_API_STATE_DIR: dir };
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("diffEnvironment", () => {
  it("returns nothing when no tuple was recorded (first run is not a change)", () => {
    expect(diffEnvironment(null, TUPLE_A)).toEqual([]);
  });

  it("returns nothing for identical tuples", () => {
    expect(diffEnvironment(TUPLE_A, { ...TUPLE_A })).toEqual([]);
  });

  it("lists each changed field with from/to", () => {
    const changes = diffEnvironment(TUPLE_A, {
      ...TUPLE_A,
      thingsVersion: "3.22.12",
      nodeBinary: "/opt/node/bin/node",
    });
    expect(changes).toEqual([
      { field: "thingsVersion", from: "3.22.11", to: "3.22.12" },
      { field: "nodeBinary", from: "/usr/local/bin/node", to: "/opt/node/bin/node" },
    ]);
  });

  it("treats null and a value as a change", () => {
    const changes = diffEnvironment({ ...TUPLE_A, thingsVersion: null }, TUPLE_A);
    expect(changes).toEqual([{ field: "thingsVersion", from: null, to: "3.22.11" }]);
  });
});

describe("describeEnvironmentChanges", () => {
  it("phrases changes for a consumer", () => {
    const text = describeEnvironmentChanges(
      diffEnvironment(TUPLE_A, { ...TUPLE_A, thingsVersion: "3.22.12", macosVersion: "26.0" }),
    );
    expect(text).toBe("Things changed (3.22.11 → 3.22.12); macOS changed (15.5 → 26.0)");
  });
});

describe("environment tracker state file", () => {
  it("record/load roundtrips through environment.json", () => {
    const tracker = createEnvironmentTracker("0.3.0", env);
    expect(tracker.load()).toBeNull();
    tracker.record(TUPLE_A);
    expect(tracker.load()).toEqual(TUPLE_A);
    expect(JSON.parse(readFileSync(environmentStatePath(env), "utf8"))).toEqual(TUPLE_A);
  });

  it("returns null for a corrupt state file instead of throwing", () => {
    writeFileSync(environmentStatePath(env), "not json{");
    const tracker = createEnvironmentTracker("0.3.0", env);
    expect(tracker.load()).toBeNull();
  });

  it("capture is memoized and carries our version and a node binary", () => {
    const tracker = createEnvironmentTracker("9.9.9", env);
    const first = tracker.capture();
    expect(first.pkgVersion).toBe("9.9.9");
    expect(first.nodeBinary.length).toBeGreaterThan(0);
    expect(tracker.capture()).toBe(first);
  });

  it("captureEnvironment tolerates missing system tools (fields become null)", () => {
    const tuple = captureEnvironment("1.2.3");
    expect(tuple.pkgVersion).toBe("1.2.3");
    for (const field of ["thingsVersion", "macosVersion"] as const) {
      expect(tuple[field] === null || typeof tuple[field] === "string").toBe(true);
    }
  });
});
