import type { Baseline } from "../fingerprint.ts";
import { DB_V26 } from "./db-v26.ts";

/** All known-good schema baselines, keyed by Meta.databaseVersion. */
export const BASELINES: readonly Baseline[] = [DB_V26];
