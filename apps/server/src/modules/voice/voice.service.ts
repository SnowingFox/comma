import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common'
import {
  DEFAULT_USER_SETTINGS,
  type ErrorCode,
  VOICE_LIMITS,
  type VoiceDelivery,
  type VoiceRunMeta,
  type VoiceRunResponse
} from '@comma/shared'
import type { AuthUser } from '@/app'
import { ApiException } from '@/filter/api-error.filter'
import { DictionaryService } from '@/modules/dictionary/dictionary.service'
import { UserService } from '@/modules/user/user.service'
import { inspectAudio } from './internal/audio'
import { languageName, normalizeLanguages, toIso1 } from './internal/languages'
import { buildPrompt, parseAskOutput } from './internal/prompts'
import { LlmClient, LlmError } from './providers/llm'
import { SttClient, SttError, sanitizeKeyterms, sttCostUsd, transcribeWithRetry } from './providers/stt'
import { type RunMetrics, VoiceRunStore } from './voice-run.store'

/** Shorter than this, nothing can have been said; answered without calling a provider. */
const MIN_AUDIO_SECONDS = 0.3

const noSpeech = () => new ApiException(HttpStatus.UNPROCESSABLE_ENTITY, 'no_speech', "Didn't catch that")

/** Provider failures as the client sees them; the provider's own message stays in the server log. */
export function providerException(error: unknown): ApiException | undefined {
  if (error instanceof SttError) {
    switch (error.code) {
      case 'rate_limited':
      case 'network':
      case 'timeout':
        return new ApiException(HttpStatus.SERVICE_UNAVAILABLE, 'provider_unavailable', 'Speech to text is unavailable, try again shortly')
      case 'invalid_request':
        return new ApiException(HttpStatus.BAD_REQUEST, 'invalid_audio', 'Speech to text could not read the audio')
      case 'aborted':
        return new ApiException(HttpStatus.BAD_REQUEST, 'bad_request', 'The run was cancelled')
      default:
        return new ApiException(HttpStatus.BAD_GATEWAY, 'stt_failed', 'Speech to text failed')
    }
  }
  if (error instanceof LlmError) {
    switch (error.code) {
      case 'rate_limited':
      case 'network':
      case 'timeout':
        return new ApiException(HttpStatus.SERVICE_UNAVAILABLE, 'provider_unavailable', 'The rewrite model is unavailable, try again shortly')
      case 'aborted':
        return new ApiException(HttpStatus.BAD_REQUEST, 'bad_request', 'The run was cancelled')
      default:
        return new ApiException(HttpStatus.BAD_GATEWAY, 'llm_failed', 'The rewrite failed')
    }
  }
  return undefined
}

function errorCodeOf(error: unknown): ErrorCode {
  if (error instanceof ApiException) {
    const body = error.getResponse() as { code?: ErrorCode }
    return body.code ?? 'internal_error'
  }
  return 'internal_error'
}

/** Speech to text, then the rewrite, on Comma's provider keys, metered against the user's weekly credits. */
@Injectable()
export class VoiceService {
  @Inject()
  private readonly logger: Logger

  @Inject()
  private readonly stt: SttClient

  @Inject()
  private readonly llm: LlmClient

  @Inject()
  private readonly runs: VoiceRunStore

  @Inject()
  private readonly users: UserService

  @Inject()
  private readonly dictionary: DictionaryService

  async run(caller: AuthUser, audio: Uint8Array | undefined, meta: VoiceRunMeta, signal?: AbortSignal): Promise<VoiceRunResponse> {
    const started = performance.now()
    // Every limit is checked before a provider is called.
    if (!audio?.length) throw new ApiException(HttpStatus.BAD_REQUEST, 'invalid_audio', 'The audio part is missing or empty')
    if (audio.length > VOICE_LIMITS.maxAudioBytes) {
      throw new ApiException(HttpStatus.PAYLOAD_TOO_LARGE, 'audio_too_large', 'Audio is larger than 25 MB')
    }
    const info = inspectAudio(audio)
    if (!info) throw new ApiException(HttpStatus.BAD_REQUEST, 'invalid_audio', 'Audio must be WAV or Ogg/Opus')
    if (info.seconds > VOICE_LIMITS.maxAudioSeconds) {
      throw new ApiException(HttpStatus.PAYLOAD_TOO_LARGE, 'audio_too_long', 'Audio is longer than 10 minutes')
    }
    if (!this.stt.configured || !this.llm.configured) {
      throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE, 'provider_not_configured', 'Comma credits are not available on this server')
    }
    if (info.seconds < MIN_AUDIO_SECONDS) throw noSpeech()

    const user = await this.users.getUser(caller.userId)
    const settings = { ...DEFAULT_USER_SETTINGS, ...user.settings }
    const audioSeconds = Math.round(info.seconds * 1000) / 1000
    const runId = await this.runs.begin({ userId: user.id, deviceId: caller.deviceId, plan: user.plan, mode: meta.mode, audioSeconds })

    const metrics: RunMetrics = {}
    try {
      const languages = normalizeLanguages(settings.languages)
      const dictionary = await this.dictionary.terms(user.id)
      const keyterms = sanitizeKeyterms(dictionary)

      const sttStarted = performance.now()
      const stt = await transcribeWithRetry(
        (languageCode) =>
          this.stt.transcribe({ audio, mimeType: info.mimeType, extension: info.extension, keyterms, languageCode, signal }),
        languages
      )
      metrics.sttMs = Math.round(performance.now() - sttStarted)
      metrics.sttRetried = stt.retried
      metrics.sttCostUsd = sttCostUsd(audioSeconds, stt.attempts, keyterms.length > 0)
      const detected = toIso1(stt.result.languageCode) ?? stt.result.languageCode
      metrics.detectedLanguage = detected.slice(0, 16)
      const raw = stt.result.text.trim()
      if (!raw) throw noSpeech()

      const appName = settings.context_level === 'off' ? undefined : meta.app_name
      const selectedText = settings.context_level === 'app_and_selection' ? meta.selected_text : undefined
      const hasSelection = Boolean(selectedText?.trim())
      const target = meta.target_language ?? settings.translate_targets[0] ?? 'en'
      const prompt = buildPrompt({
        mode: meta.mode,
        transcript: raw,
        languages,
        targetLanguage: languageName(target),
        dictionary,
        appName,
        selectedText
      })
      const rewrite = await this.llm.rewrite({ instructions: prompt.system, prompt: prompt.user, signal })
      metrics.llmTtftMs = Math.round(rewrite.ttftMs)
      metrics.llmTotalMs = Math.round(rewrite.totalMs)
      metrics.promptTokens = rewrite.promptTokens
      metrics.completionTokens = rewrite.completionTokens

      let delivery: VoiceDelivery = 'insert'
      let refined = rewrite.text.trim()
      if (meta.mode === 'ask') {
        ;({ delivery, text: refined } = parseAskOutput(rewrite.text, hasSelection))
      }
      if (!refined) throw noSpeech()
      metrics.delivery = delivery
      metrics.totalMs = Math.round(performance.now() - started)
      await this.runs.finish(runId, 'ok', metrics)
      this.logger.log(
        `run ${runId} ${meta.mode} ok audio=${audioSeconds}s stt=${metrics.sttMs}ms${stt.retried ? ' (retried)' : ''} ` +
          `ttft=${metrics.llmTtftMs}ms llm=${metrics.llmTotalMs}ms total=${metrics.totalMs}ms ` +
          `tokens=${rewrite.promptTokens}/${rewrite.completionTokens} reasoning=${rewrite.reasoningTokens}`,
        VoiceService.name
      )
      return {
        id: runId,
        raw_text: raw,
        refined_text: refined,
        detected_language: detected,
        delivery,
        timings: {
          stt_ms: metrics.sttMs,
          llm_ttft_ms: metrics.llmTtftMs,
          llm_total_ms: metrics.llmTotalMs,
          total_ms: metrics.totalMs
        },
        usage: {
          audio_seconds: audioSeconds,
          prompt_tokens: rewrite.promptTokens,
          completion_tokens: rewrite.completionTokens,
          stt_cost_usd: Math.round(metrics.sttCostUsd * 1e6) / 1e6
        }
      }
    } catch (error) {
      const mapped = providerException(error)
      const thrown = mapped ?? error
      metrics.totalMs = Math.round(performance.now() - started)
      await this.runs.finish(runId, 'error', { ...metrics, errorCode: errorCodeOf(thrown) }).catch(() => undefined)
      if (mapped) {
        // Provider messages are already scrubbed of keys; they never reach the client.
        this.logger.warn(`run ${runId} ${meta.mode} failed: ${(error as Error).message}`, VoiceService.name)
      }
      throw thrown
    }
  }
}
