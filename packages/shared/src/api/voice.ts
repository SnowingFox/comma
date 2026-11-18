import { z } from 'zod'
import { LanguageTag } from './user'

/** Limits of `POST /v1/voice/runs`, checked before any provider is called. */
export const VOICE_LIMITS = {
  /** Bytes of the `audio` part. */
  maxAudioBytes: 25 * 1024 * 1024,
  /** Seconds of audio. */
  maxAudioSeconds: 600,
  /** Characters of `selected_text` (Ask Anything only). */
  maxSelectedTextChars: 20_000
} as const

export const VoiceMode = z.enum(['dictate', 'ask', 'translate'])
export type VoiceMode = z.infer<typeof VoiceMode>

/**
 * Where the desktop app puts the result: `insert` at the cursor, `replace` the selected text, or show it as an
 * `answer` card (never inserted). Dictate and Translate always insert; Ask Anything replaces a selection or answers.
 */
export const VoiceDelivery = z.enum(['insert', 'replace', 'answer'])
export type VoiceDelivery = z.infer<typeof VoiceDelivery>

/** Milliseconds the app measured on its side (recording, upload); accepted for diagnostics, never required. */
export const ClientTimings = z.record(z.string().max(40), z.number().nonnegative().max(3_600_000)).refine(
  (value) => Object.keys(value).length <= 20,
  'at most 20 timings'
)

/**
 * The `meta` part of `POST /v1/voice/runs`, a JSON string. `selected_text` is only allowed with `ask`;
 * `target_language` defaults to the first of the user's `translate_targets`, then English.
 */
export const VoiceRunMeta = z
  .object({
    mode: VoiceMode,
    target_language: LanguageTag.optional(),
    /** Focused app name; used only when the user's context level allows it. */
    app_name: z.string().trim().max(200).optional(),
    selected_text: z.string().max(VOICE_LIMITS.maxSelectedTextChars).optional(),
    client_timings: ClientTimings.optional()
  })
  .strict()
  .refine((meta) => meta.selected_text === undefined || meta.mode === 'ask', {
    message: 'only allowed in ask mode',
    path: ['selected_text']
  })
export type VoiceRunMeta = z.infer<typeof VoiceRunMeta>

export const VoiceTimings = z.object({
  /** Speech to text, both attempts when the language was retried. */
  stt_ms: z.number().int().nonnegative(),
  /** Rewrite request sent to its first streamed token. */
  llm_ttft_ms: z.number().int().nonnegative(),
  llm_total_ms: z.number().int().nonnegative(),
  /** Upload received to response ready. */
  total_ms: z.number().int().nonnegative()
})
export type VoiceTimings = z.infer<typeof VoiceTimings>

export const VoiceUsage = z.object({
  audio_seconds: z.number().nonnegative(),
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  /** List-price estimate of the speech-to-text call(s). */
  stt_cost_usd: z.number().nonnegative()
})
export type VoiceUsage = z.infer<typeof VoiceUsage>

/**
 * `POST /v1/voice/runs` -> 200. Errors: 400 `invalid_audio` / `validation_failed`, 413 `audio_too_large` /
 * `audio_too_long`, 402 `quota_exceeded` (with `resets_at`), 422 `no_speech`, 429 `run_in_progress`,
 * 502 `stt_failed` / `llm_failed`, 503 `provider_unavailable` / `provider_not_configured`.
 */
export const VoiceRunResponse = z.object({
  id: z.uuid(),
  raw_text: z.string(),
  refined_text: z.string().min(1),
  /** ISO 639-1 when recognised, else the provider's code. */
  detected_language: z.string(),
  delivery: VoiceDelivery,
  timings: VoiceTimings,
  usage: VoiceUsage
})
export type VoiceRunResponse = z.infer<typeof VoiceRunResponse>
