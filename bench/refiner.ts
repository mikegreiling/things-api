/**
 * The refinement-loop refiner (CONSTITUTION "Roles": the frontier refiner analyzes
 * failures and proposes the smallest generalizable patch — it never executes tasks
 * and never grades). Kept behind a small {@link Refiner} interface so the loop driver
 * can be unit-tested with a fake, and the live implementation ({@link CodexRefiner})
 * makes a single-turn model call via pi-agent-core over the codex OAuth store
 * (`bench/codex-auth.ts`) or an env-key provider.
 *
 * The refiner is asked for a STRICT JSON object (fenced) and the response is parsed
 * with {@link parseRefinerOutput}; a live call retries ONCE on parse failure.
 */
import { buildCodexAgentAuth } from "./codex-auth.ts";
import { isProviderError, ProviderError, type UsageDelta } from "./loop-core.ts";

/** Heuristic failure classes (CONSTITUTION "Roles" — every failure classified). */
export type FailureClass =
  | "discovery"
  | "behavior-misunderstanding"
  | "data-model-misunderstanding"
  | "argument-construction"
  | "recovery"
  | "tool-defect";

export const FAILURE_CLASSES: readonly FailureClass[] = [
  "discovery",
  "behavior-misunderstanding",
  "data-model-misunderstanding",
  "argument-construction",
  "recovery",
  "tool-defect",
];

/** One classification the refiner attaches to a digested task. */
export interface Classification {
  taskId: string;
  class: string;
  note: string;
}

/** The single input to a refiner call. */
export interface RefinerInput {
  /** The surface-improvement charter (system prompt). */
  systemPrompt: string;
  /** Target file bodies + the failure digest (user content). */
  userContent: string;
}

/** The required, strictly-parsed refiner output. */
export interface RefinerOutput {
  classifications: Classification[];
  /** Unified diff to apply within the arm's allowlist. */
  patch: string;
  rationale: string;
  predictedBlastRadius: string;
  /** True iff the patch changes gui.md SEMANTICS (skill arm) — forces needs-mike. */
  guiSemanticChange: boolean;
  /** Provider-reported token usage for this call (fed to the invocation token budget). */
  usage?: UsageDelta;
}

/** Confidence the post-hoc debrief attaches to its attribution. */
export type Confidence = "high" | "medium" | "low";

/** The single input to a post-hoc debrief call. */
export interface DebriefInput {
  /** The debrief charter (system prompt). */
  systemPrompt: string;
  /** Patch + pre-hoc rationale/blast-radius + per-task before/after numbers (no task text). */
  userContent: string;
}

/** The required, strictly-parsed post-hoc debrief output. */
export interface DebriefOutput {
  /** What most likely accounts for the measured delta, positive or negative. */
  attribution: string;
  /** One transferable sentence — feeds forward into later charters. */
  lesson: string;
  confidence: Confidence;
  usage?: UsageDelta;
}

/** The seam the loop driver depends on; swap a fake in tests. */
export interface Refiner {
  refine(input: RefinerInput): Promise<RefinerOutput>;
  /** Post-hoc debrief of a re-benched candidate (accepted or reverted). */
  debrief(input: DebriefInput): Promise<DebriefOutput>;
}

/** Normalize an arbitrary confidence string to the closed set (default "low"). */
export function normalizeConfidence(value: unknown): Confidence {
  const v = String(value ?? "").toLowerCase();
  return v === "high" || v === "medium" || v === "low" ? v : "low";
}

/**
 * Parse a debrief object from a model response (same fence-preference strategy as
 * {@link parseRefinerOutput}). Requires a string `attribution`; `lesson` defaults to ""
 * and `confidence` is normalized. Returns null when nothing parses into such an object.
 */
export function parseDebriefOutput(text: string | null): DebriefOutput | null {
  if (text === null) return null;
  const candidates: string[] = [];
  const fences = [...text.matchAll(/```(\w*)\n([\s\S]*?)```/g)];
  const jsonFences = fences.filter((m) => m[1]?.toLowerCase() === "json");
  for (const m of (jsonFences.length > 0 ? jsonFences : fences).toReversed()) {
    candidates.push((m[2] ?? "").trim());
  }
  candidates.push(text.trim());

  for (const raw of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj["attribution"] !== "string") continue;
    return {
      attribution: obj["attribution"] as string,
      lesson: typeof obj["lesson"] === "string" ? obj["lesson"] : "",
      confidence: normalizeConfidence(obj["confidence"]),
    };
  }
  return null;
}

/**
 * Extract the parsed refiner object from a model response. Prefers the LAST fenced
 * ```json block, then any fenced block, then the raw text. Returns null when no
 * candidate parses into an object carrying a string `patch` (the one required field);
 * the other fields are defaulted leniently so a slightly-shaped-off response still
 * lands rather than forcing a retry.
 */
export function parseRefinerOutput(text: string | null): RefinerOutput | null {
  if (text === null) return null;
  const candidates: string[] = [];
  const fences = [...text.matchAll(/```(\w*)\n([\s\S]*?)```/g)];
  const jsonFences = fences.filter((m) => m[1]?.toLowerCase() === "json");
  for (const m of (jsonFences.length > 0 ? jsonFences : fences).toReversed()) {
    candidates.push((m[2] ?? "").trim());
  }
  candidates.push(text.trim());

  for (const raw of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj["patch"] !== "string") continue;

    const classifications: Classification[] = Array.isArray(obj["classifications"])
      ? (obj["classifications"] as unknown[])
          .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null)
          .map((c) => ({
            taskId: String(c["taskId"] ?? ""),
            class: String(c["class"] ?? ""),
            note: String(c["note"] ?? ""),
          }))
      : [];

    return {
      classifications,
      patch: obj["patch"] as string,
      rationale: typeof obj["rationale"] === "string" ? obj["rationale"] : "",
      predictedBlastRadius:
        typeof obj["predictedBlastRadius"] === "string" ? obj["predictedBlastRadius"] : "",
      guiSemanticChange: obj["guiSemanticChange"] === true,
    };
  }
  return null;
}

// --- live implementation ---------------------------------------------------

interface MinMessage {
  role?: string;
  content?: unknown;
}

interface MinTextBlock {
  type?: string;
  text?: string;
}

/** Concatenate the last assistant message's text blocks (mirrors runner.ts). */
function lastAssistantText(messages: unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as MinMessage;
    if (m.role !== "assistant") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      const t = (m.content as MinTextBlock[])
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("");
      if (t !== "") return t;
    }
  }
  return null;
}

export interface CodexRefinerOptions {
  model: string;
  /** "openai-codex" (OAuth store) or an env-key provider id (e.g. "openai"). */
  provider: string;
}

/**
 * Live refiner: one single-turn pi-agent-core call (no tools) per attempt, retried
 * once on a parse miss. The codex provider resolves a ChatGPT-subscription OAuth token
 * per turn (`getApiKey`), matching `bench/runner.ts`'s auth wiring.
 */
export class CodexRefiner implements Refiner {
  readonly #opts: CodexRefinerOptions;

  constructor(opts: CodexRefinerOptions) {
    this.#opts = opts;
  }

  async #callOnce(
    input: RefinerInput,
    suffix: string,
  ): Promise<{ text: string | null; usage: UsageDelta }> {
    const { Agent } = await import("@earendil-works/pi-agent-core");

    let model: unknown;
    let getApiKey: ((provider: string) => Promise<string | undefined>) | undefined;
    if (this.#opts.provider === "openai-codex") {
      const codex = await buildCodexAgentAuth(this.#opts.model);
      model = codex.model;
      getApiKey = codex.getApiKey;
    } else {
      const piai = await import("@earendil-works/pi-ai/compat");
      const getModel = piai.getModel as (provider: string, model: string) => unknown;
      model = getModel(this.#opts.provider, this.#opts.model);
      if (model === undefined) {
        throw new Error(`unknown refiner model ${this.#opts.provider}/${this.#opts.model}`);
      }
    }

    const agent = new Agent({
      initialState: { systemPrompt: input.systemPrompt, model: model as never, tools: [] },
      ...(getApiKey !== undefined && { getApiKey }),
    });

    const usage: UsageDelta = { tokensIn: 0, tokensOut: 0 };
    const unsubscribe = agent.subscribe((event) => {
      const e = event as {
        type?: string;
        message?: { role?: string; usage?: { input?: number; output?: number } };
      };
      if (e.type === "message_end" && e.message?.role === "assistant" && e.message.usage) {
        usage.tokensIn += e.message.usage.input ?? 0;
        usage.tokensOut += e.message.usage.output ?? 0;
      }
    });

    try {
      await agent.prompt(input.userContent + suffix);
    } catch (err) {
      // Surface provider failures (429/quota/5xx) so the loop's circuit breaker can
      // count them; other stream errors leave the partial transcript to be parsed.
      if (isProviderError(err)) {
        throw new ProviderError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      unsubscribe();
    }
    return { text: lastAssistantText(agent.state.messages as unknown[]), usage };
  }

  async refine(input: RefinerInput): Promise<RefinerOutput> {
    const usage: UsageDelta = { tokensIn: 0, tokensOut: 0 };
    const account = (u: UsageDelta): void => {
      usage.tokensIn += u.tokensIn;
      usage.tokensOut += u.tokensOut;
    };

    const a = await this.#callOnce(input, "");
    account(a.usage);
    const first = parseRefinerOutput(a.text);
    if (first !== null) return { ...first, usage };

    const b = await this.#callOnce(
      input,
      "\n\nYour previous reply did not parse. Reply with ONLY a single fenced " +
        "```json object matching the required schema — no prose before or after.",
    );
    account(b.usage);
    const retry = parseRefinerOutput(b.text);
    if (retry !== null) return { ...retry, usage };

    throw new Error("refiner output did not parse as the required JSON after one retry");
  }

  async debrief(input: DebriefInput): Promise<DebriefOutput> {
    // DebriefInput is structurally a RefinerInput (systemPrompt + userContent).
    const usage: UsageDelta = { tokensIn: 0, tokensOut: 0 };
    const account = (u: UsageDelta): void => {
      usage.tokensIn += u.tokensIn;
      usage.tokensOut += u.tokensOut;
    };

    const a = await this.#callOnce(input, "");
    account(a.usage);
    const first = parseDebriefOutput(a.text);
    if (first !== null) return { ...first, usage };

    const b = await this.#callOnce(
      input,
      "\n\nYour previous reply did not parse. Reply with ONLY a single fenced " +
        '```json object {"attribution","lesson","confidence"} — no prose around it.',
    );
    account(b.usage);
    const retry = parseDebriefOutput(b.text);
    if (retry !== null) return { ...retry, usage };

    throw new Error("debrief output did not parse as the required JSON after one retry");
  }
}
