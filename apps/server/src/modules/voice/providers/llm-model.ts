// The only place that knows about LLM providers. Adding one (OpenAI, Anthropic, ...) is one entry in PROVIDERS
// plus its value in `LLM_PROVIDERS` (app.config.ts).

import { createDeepSeek } from '@ai-sdk/deepseek'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel, streamText } from 'ai'
import type { LlmConfig, LlmProvider, ReasoningEffort } from '@/app.config'

export type ProviderOptions = NonNullable<Parameters<typeof streamText>[0]['providerOptions']>

/** A ready model plus the per-call provider options that carry the reasoning setting. */
export type LlmWiring = { model: LanguageModel; providerOptions: ProviderOptions }

type Settings = { apiKey: string; baseUrl?: string; model: string }

/** Name of our openai-compatible provider instance; also its `providerOptions` key. */
const COMPATIBLE_NAME = 'comma'

const PROVIDERS: Record<LlmProvider, { create: (settings: Settings) => LanguageModel; reasoning: (effort: ReasoningEffort) => ProviderOptions }> = {
  'openai-compatible': {
    create: ({ apiKey, baseUrl, model }) =>
      createOpenAICompatible({ name: COMPATIBLE_NAME, apiKey, baseURL: baseUrl ?? '', includeUsage: true }).chatModel(model),
    // Sent as `reasoning_effort` unchanged: off -> "none".
    reasoning: (effort): ProviderOptions =>
      effort === 'default' ? {} : { [COMPATIBLE_NAME]: { reasoningEffort: effort === 'off' ? 'none' : effort } }
  },
  deepseek: {
    create: ({ apiKey, baseUrl, model }) => createDeepSeek({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) }).chat(model),
    // DeepSeek V4 turns thinking off with `thinking.type` and has only low | high | max efforts.
    reasoning: (effort): ProviderOptions => {
      if (effort === 'default') return {}
      if (effort === 'off') return { deepseek: { thinking: { type: 'disabled' } } }
      return { deepseek: { thinking: { type: 'enabled' }, reasoningEffort: effort === 'low' ? 'low' : 'high' } }
    }
  }
}

/** Whether voice runs can call the LLM with this config. */
export function llmConfigured(config: LlmConfig): boolean {
  return Boolean(config.apiKey && config.model && (config.provider !== 'openai-compatible' || config.baseUrl))
}

export function createLlm(config: LlmConfig): LlmWiring {
  const provider = PROVIDERS[config.provider]
  return {
    model: provider.create({ apiKey: config.apiKey ?? '', baseUrl: config.baseUrl, model: config.model ?? '' }),
    providerOptions: provider.reasoning(config.reasoningEffort)
  }
}
