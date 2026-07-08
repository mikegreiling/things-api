#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// Dev checkouts (npm link) run live TS source via Node's type stripping;
// published tarballs ship only dist + bin, so src is absent and dist is used.
import { existsSync } from "node:fs";

const src = new URL("../src/cli/main.ts", import.meta.url);
const entry = existsSync(src) ? src : new URL("../dist/cli/main.js", import.meta.url);
const { runCli } = await import(entry.href);
runCli();
