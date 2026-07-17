/**
 * ChatGPT-subscription OAuth (`openai-codex`) auth for the bench runner.
 *
 * pi-ai ships the codex provider (`openaiCodexProvider()`, api
 * `openai-codex-responses`) and a persistent-credential machine
 * (`createModels({ credentials })` + `Models.getAuth()` runs the OAuth token
 * refresh under a per-provider store lock). It does NOT ship a file-backed
 * `CredentialStore`, so this module implements one over a single `auth.json`
 * whose shape matches what the pi-ai login CLI writes (`{ [providerId]: cred }`)
 * — one map keyed by provider id, one credential each.
 *
 * Credentials live OUTSIDE the repo, in `~/.config/things-api-bench/auth.json`
 * (0600), never under the checkout.
 *
 * Stream glue: the codex Responses backend needs only the OAuth access token as
 * `options.apiKey` — it parses the ChatGPT account id out of the JWT itself
 * (`api/openai-codex-responses.js` → `extractAccountId`) and takes the base URL
 * from the model's own metadata, so no custom `streamFn` is required. The
 * default agent `streamSimple` dispatches on `model.api`; supplying the token
 * through the agent's `getApiKey(provider)` hook (re-resolved per turn, so an
 * expiring token is refreshed mid-run) is the whole integration.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

/** Provider id used by pi-ai for the codex OAuth provider (matches the login CLI). */
export const CODEX_PROVIDER_ID = "openai-codex";

/** Credential home — deliberately outside the repo. */
export const AUTH_DIR = join(homedir(), ".config", "things-api-bench");
export const AUTH_FILE = join(AUTH_DIR, "auth.json");

/**
 * File-backed {@link CredentialStore} over `auth.json`, matching the pi-ai login
 * CLI's on-disk shape (`{ [providerId]: Credential }`). `modify` is serialized
 * per provider id so the locked OAuth refresh inside `Models.getAuth()` is a
 * clean read-modify-write; the file is always (re)written 0600.
 */
export class FileCredentialStore implements CredentialStore {
  readonly #file: string;
  readonly #chains = new Map<string, Promise<unknown>>();

  constructor(file: string = AUTH_FILE) {
    this.#file = file;
  }

  #readAll(): Record<string, Credential> {
    if (!existsSync(this.#file)) return {};
    try {
      const parsed = JSON.parse(readFileSync(this.#file, "utf8")) as unknown;
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, Credential>)
        : {};
    } catch {
      return {};
    }
  }

  #writeAll(all: Record<string, Credential>): void {
    mkdirSync(dirname(this.#file), { recursive: true, mode: 0o700 });
    writeFileSync(this.#file, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
    // writeFileSync's mode only applies on creation; force 0600 on an existing file too.
    chmodSync(this.#file, 0o600);
  }

  read(providerId: string): Promise<Credential | undefined> {
    return Promise.resolve(this.#readAll()[providerId]);
  }

  list(): Promise<readonly CredentialInfo[]> {
    return Promise.resolve(
      Object.entries(this.#readAll()).map(([providerId, cred]) => ({
        providerId,
        type: cred.type,
      })),
    );
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    const prev = this.#chains.get(providerId) ?? Promise.resolve();
    const next = prev.then(async () => {
      const all = this.#readAll();
      const updated = await fn(all[providerId]);
      if (updated !== undefined) {
        all[providerId] = updated;
        this.#writeAll(all);
      }
      return updated ?? all[providerId];
    });
    // Keep the chain alive for serialization even if this write rejected.
    this.#chains.set(
      providerId,
      next.catch(() => undefined),
    );
    return next;
  }

  delete(providerId: string): Promise<void> {
    const prev = this.#chains.get(providerId) ?? Promise.resolve();
    const next = prev.then(() => {
      const all = this.#readAll();
      if (providerId in all) {
        delete all[providerId];
        this.#writeAll(all);
      }
    });
    this.#chains.set(
      providerId,
      next.catch(() => undefined),
    );
    return next;
  }
}

/** True when a codex credential is stored (does not resolve/refresh it). */
export async function hasCodexCredential(): Promise<boolean> {
  return (await new FileCredentialStore().read(CODEX_PROVIDER_ID)) !== undefined;
}

/** The clear, actionable message shown when no codex credential is on disk. */
export function codexLoginHint(): string {
  return (
    `no ${CODEX_PROVIDER_ID} credential found at ${AUTH_FILE}\n` +
    `sign in with your ChatGPT subscription first:\n\n` +
    `    npm run bench:login\n`
  );
}

export interface CodexAgentAuth {
  /** A codex `Model` (api "openai-codex-responses") for the agent's initial state. */
  model: unknown;
  /** Per-turn token resolver for the agent's `getApiKey` hook (refreshes under lock). */
  getApiKey: (provider: string) => Promise<string | undefined>;
}

/**
 * Resolve a codex model + a token resolver for the given model id, backed by the
 * on-disk credential. Throws {@link codexLoginHint} when no credential exists.
 */
export async function buildCodexAgentAuth(modelId: string): Promise<CodexAgentAuth> {
  const { createModels } = await import("@earendil-works/pi-ai");
  const { openaiCodexProvider } = await import("@earendil-works/pi-ai/providers/openai-codex");

  const store = new FileCredentialStore();
  if ((await store.read(CODEX_PROVIDER_ID)) === undefined) {
    throw new Error(codexLoginHint());
  }

  const models = createModels({ credentials: store });
  models.setProvider(openaiCodexProvider());

  const model = models.getModel(CODEX_PROVIDER_ID, modelId);
  if (model === undefined) {
    const known = models
      .getModels(CODEX_PROVIDER_ID)
      .map((m) => m.id)
      .join(", ");
    throw new Error(`unknown ${CODEX_PROVIDER_ID} model "${modelId}" — known ids: ${known}`);
  }

  // Models.getAuth runs the OAuth refresh under the store lock and returns the
  // (possibly refreshed) access token as auth.apiKey — exactly what the codex
  // Responses backend consumes. Re-resolving per turn keeps a long run's token fresh.
  const getApiKey = async (provider: string): Promise<string | undefined> => {
    const result = await models.getAuth(provider);
    return result?.auth.apiKey;
  };

  return { model, getApiKey };
}
