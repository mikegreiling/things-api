/**
 * `npm run bench:login` — ChatGPT-subscription OAuth login for the bench runner.
 *
 * Creates `~/.config/things-api-bench/` and runs the pi-ai login CLI WITH THAT
 * DIRECTORY AS CWD, because that CLI writes `auth.json` relative to the current
 * directory. Credentials therefore land at `~/.config/things-api-bench/auth.json`
 * (never inside the repo), which is exactly where {@link FileCredentialStore}
 * reads them. Defaults to the `openai-codex` provider; pass another provider id
 * as an argument to override (`npm run bench:login -- <provider>`).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { AUTH_DIR, CODEX_PROVIDER_ID } from "./codex-auth.ts";

const BENCH_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(BENCH_DIR, "..");
const PI_AI_CLI = join(REPO_ROOT, "node_modules", "@earendil-works", "pi-ai", "dist", "cli.js");

const provider = process.argv[2] ?? CODEX_PROVIDER_ID;

mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });

const res = spawnSync(process.execPath, [PI_AI_CLI, "login", provider], {
  cwd: AUTH_DIR,
  stdio: "inherit",
});

process.exit(res.status ?? 1);
