/**
 * Curated, hand-written descriptions of the speech-to-text models and of the LLM families Comma
 * knows. Unknown ids are shown as they are.
 */

export const DEFAULT_STT_MODEL = "scribe_v3";

export type SttModel = {
  id: string;
  name: string;
  description: string;
  /** List price per hour of audio, batch rate. */
  usdPerHour: number;
  recommended?: boolean;
};

/** ElevenLabs Scribe models. Keyterms from the dictionary add 20% to the price. */
export const STT_MODELS: SttModel[] = [
  {
    id: "scribe_v3",
    name: "Scribe v3",
    description: "Most accurate, handles accents and mixed languages best.",
    usdPerHour: 0.2,
    recommended: true,
  },
  {
    id: "scribe_v2",
    name: "Scribe v2",
    description: "The previous generation, at the same price.",
    usdPerHour: 0.2,
  },
];

export function sttModel(id: string): SttModel | undefined {
  return STT_MODELS.find((m) => m.id === id);
}

export function formatUsdPerHour(usd: number): string {
  return `$${usd.toFixed(2)}/h`;
}

// ---- LLM ----------------------------------------------------------------------------------------

export type ModelTag = "recommended" | "fast" | "cheap" | "reasoning" | "large";

export const TAG_LABELS: Record<ModelTag, string> = {
  recommended: "Recommended for dictation",
  fast: "Fast",
  cheap: "Low cost",
  reasoning: "Reasoning",
  large: "Large",
};

export type ModelInfo = { description: string; tags: ModelTag[] };

/** First match wins; patterns run against the id without its provider prefix, lowercased. */
const FAMILIES: { test: RegExp; info: ModelInfo }[] = [
  {
    test: /deepseek[-_.]?v4[-_.]?flash/,
    info: { description: "Fast and cheap, good for dictation.", tags: ["recommended", "fast", "cheap"] },
  },
  {
    test: /deepseek[-_.]?(reasoner|r\d)/,
    info: { description: "Reasoning model, slower first token.", tags: ["reasoning"] },
  },
  {
    test: /deepseek[-_.]?v4[-_.]?pro/,
    info: { description: "DeepSeek's larger model; stronger rewrites, slower.", tags: ["large"] },
  },
  {
    test: /deepseek[-_.]?chat|deepseek[-_.]?v\d/,
    info: { description: "Quick general model, fine for dictation.", tags: ["fast", "cheap"] },
  },
  {
    test: /(^|[-_/])(thinking|reasoning)([-_]|$)|[-_]thinking$/,
    info: { description: "Reasoning model, slower first token.", tags: ["reasoning"] },
  },
  {
    test: /^o\d([-_.]|$)/,
    info: { description: "Reasoning model, slower first token.", tags: ["reasoning"] },
  },
  {
    test: /gpt[-_.]?[\d.]+[-_.]?(mini|nano)/,
    info: { description: "Small and quick; good for short rewrites.", tags: ["fast", "cheap"] },
  },
  {
    test: /gpt[-_.]?[\d.]+/,
    info: { description: "General model; reasons by default, so set the effort low for dictation.", tags: ["large"] },
  },
  {
    test: /claude[-_.]?.*haiku|haiku/,
    info: { description: "Anthropic's fast model; quick, careful rewrites.", tags: ["fast"] },
  },
  {
    test: /claude[-_.]?.*sonnet|sonnet/,
    info: { description: "Anthropic's balanced model; slower than Haiku.", tags: ["large"] },
  },
  {
    test: /claude[-_.]?.*opus|opus/,
    info: { description: "Anthropic's largest model; slow for dictation.", tags: ["large"] },
  },
  {
    test: /qwen/,
    info: { description: "Strong in Chinese and English.", tags: [] },
  },
  {
    test: /kimi|moonshot/,
    info: { description: "Long context, good in Chinese.", tags: [] },
  },
  {
    test: /glm/,
    info: { description: "Zhipu's model, good in Chinese.", tags: [] },
  },
  {
    test: /mistral|mixtral|ministral/,
    info: { description: "Good in European languages.", tags: [] },
  },
  {
    test: /gemini[-_.]?.*flash/,
    info: { description: "Google's fast model.", tags: ["fast", "cheap"] },
  },
  {
    test: /gemini/,
    info: { description: "Google's general model.", tags: ["large"] },
  },
];

/** The part before the first `/`, or "Other" for ids without one. */
export function providerOf(id: string): string {
  const slash = id.indexOf("/");
  return slash > 0 ? id.slice(0, slash) : "Other";
}

export function modelInfo(id: string): ModelInfo | undefined {
  const bare = id.slice(id.indexOf("/") + 1).toLowerCase();
  return FAMILIES.find((f) => f.test.test(bare))?.info;
}

/** Models grouped by provider prefix, groups and models in alphabetical order, "Other" last. */
export function groupModels(models: string[]): { provider: string; models: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const m of models) {
    const p = providerOf(m);
    groups.set(p, [...(groups.get(p) ?? []), m]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === "Other" ? 1 : b === "Other" ? -1 : a.localeCompare(b)))
    .map(([provider, list]) => ({ provider, models: list.sort((a, b) => a.localeCompare(b)) }));
}

// ---- Measured latency ---------------------------------------------------------------------------

const LATENCY_KEY = "comma-llm-latency";

export type Latency = { ttft_ms: number; effort: string; at: number };

function readLatencies(): Record<string, Latency> {
  try {
    return JSON.parse(localStorage.getItem(LATENCY_KEY) ?? "{}") as Record<string, Latency>;
  } catch {
    return {};
  }
}

const latencyKey = (baseUrl: string, model: string) => `${baseUrl.trim().replace(/\/+$/, "")}|${model}`;

/** Remembers the first-token latency of the last Test or Compare run for a model. */
export function rememberLatency(baseUrl: string, model: string, effort: string, ttftMs: number) {
  try {
    const all = readLatencies();
    all[latencyKey(baseUrl, model)] = { ttft_ms: ttftMs, effort, at: Date.now() };
    localStorage.setItem(LATENCY_KEY, JSON.stringify(all));
    window.dispatchEvent(new StorageEvent("storage", { key: LATENCY_KEY }));
  } catch {
    // storage unavailable: nothing to remember
  }
}

export function latencyFor(baseUrl: string, model: string): Latency | undefined {
  return readLatencies()[latencyKey(baseUrl, model)];
}

export const LATENCY_STORAGE_KEY = LATENCY_KEY;
