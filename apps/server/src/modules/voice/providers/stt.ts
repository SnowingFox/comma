// ElevenLabs Speech to Text (batch): POST {base}/v1/speech-to-text, multipart. Ported from the Comma prototype (MIT).
// Fields: model_id, file, language_code (omitted = auto-detect), keyterms (repeated; max 1000, each <= 50 characters
// and <= 5 words, none of < > { } [ ] \).

import { Inject, Injectable } from '@nestjs/common'
import { ElevenLabsConfig } from '@/app.config'
import { MIN_LANGUAGE_PROBABILITY, toIso1 } from '../internal/languages'
import { redact } from '../internal/redact'

export type SttErrorCode = 'auth' | 'rate_limited' | 'invalid_request' | 'http' | 'network' | 'timeout' | 'aborted'

export class SttError extends Error {
  override readonly name = 'SttError'
  constructor(
    message: string,
    readonly code: SttErrorCode,
    readonly status: number | null = null
  ) {
    super(message)
  }
}

export type SttRequest = {
  audio: Uint8Array
  mimeType: string
  extension: string
  keyterms: string[]
  /** ISO 639-1 to force; omitted = auto-detect. */
  languageCode?: string
  signal?: AbortSignal
}

export type SttAttempt = {
  text: string
  /** As the provider reports it (ISO 639-3). */
  languageCode: string
  languageProbability?: number
  ms: number
}

/** List price, USD per hour of batch audio; keyterms add 20%. */
export const STT_USD_PER_HOUR = 0.22
const KEYTERMS_SURCHARGE = 1.2
const TIMEOUT_MS = 120_000

export function sttCostUsd(seconds: number, attempts: number, usedKeyterms: boolean): number {
  return (seconds / 3600) * STT_USD_PER_HOUR * attempts * (usedKeyterms ? KEYTERMS_SURCHARGE : 1)
}

const FORBIDDEN_TERM_CHARS = /[<>{}[\]\\]/

/** The provider's keyterm limits: invalid terms are dropped, not sent. */
export function sanitizeKeyterms(terms: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of terms) {
    const term = raw.trim().replace(/\s+/g, ' ')
    if (!term || term.length > 50 || term.split(' ').length > 5 || FORBIDDEN_TERM_CHARS.test(term)) continue
    const key = term.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(term)
    if (out.length >= 1000) break
  }
  return out
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

@Injectable()
export class SttClient {
  @Inject()
  private readonly config: ElevenLabsConfig

  get configured(): boolean {
    return Boolean(this.config.apiKey)
  }

  async transcribe(request: SttRequest): Promise<SttAttempt> {
    const apiKey = this.config.apiKey ?? ''
    const form = new FormData()
    form.append('model_id', this.config.model)
    form.append('file', new Blob([request.audio as Uint8Array<ArrayBuffer>], { type: request.mimeType }), `audio.${request.extension}`)
    if (request.languageCode) form.append('language_code', request.languageCode)
    for (const term of request.keyterms) form.append('keyterms', term)

    const timeout = AbortSignal.timeout(TIMEOUT_MS)
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout
    const started = performance.now()
    let response: Response
    let text: string
    try {
      response = await fetch(`${this.config.baseUrl.replace(/\/+$/, '')}/v1/speech-to-text`, {
        method: 'POST',
        headers: { 'xi-api-key': apiKey },
        body: form,
        signal
      })
      text = await response.text()
    } catch (error) {
      if (isAbort(error)) {
        throw request.signal?.aborted
          ? new SttError('Speech to text was cancelled', 'aborted')
          : new SttError('Speech to text timed out', 'timeout')
      }
      throw new SttError(`Cannot reach ElevenLabs: ${redact(String((error as Error).message), [apiKey])}`, 'network')
    }
    if (!response.ok) throw mapSttError(response.status, redact(text.slice(0, 2000), [apiKey]))
    let json: any
    try {
      json = JSON.parse(text)
    } catch {
      throw new SttError('ElevenLabs returned a body that is not JSON', 'http', response.status)
    }
    // Multichannel responses carry `transcripts`; join them so callers get one text.
    const chunks: any[] = Array.isArray(json?.transcripts) ? json.transcripts : [json]
    const first = chunks[0] ?? {}
    return {
      text: chunks.map((chunk) => String(chunk?.text ?? '')).join('\n').trim(),
      languageCode: String(first.language_code ?? ''),
      languageProbability: typeof first.language_probability === 'number' ? first.language_probability : undefined,
      ms: performance.now() - started
    }
  }
}

/** Upstream status and `detail` to an {@link SttError}; the body is already scrubbed of the key. */
export function mapSttError(status: number, body: string): SttError {
  let detail: any
  try {
    detail = JSON.parse(body)?.detail
  } catch {
    detail = undefined
  }
  const upstream: string =
    typeof detail === 'string'
      ? detail
      : Array.isArray(detail)
        ? detail.map((item: any) => item?.msg).filter(Boolean).join('; ')
        : String(detail?.message ?? '')
  const suffix = upstream ? `: ${upstream.slice(0, 300)}` : ''
  if (status === 401 || status === 403) return new SttError(`ElevenLabs rejected the API key${suffix}`, 'auth', status)
  if (status === 429) return new SttError(`ElevenLabs rate limit or quota exceeded${suffix}`, 'rate_limited', status)
  if (status === 400 || status === 422) return new SttError(`ElevenLabs rejected the request${suffix}`, 'invalid_request', status)
  return new SttError(`ElevenLabs returned HTTP ${status}${suffix}`, 'http', status)
}

/** `attempts` is the number of billed provider calls. */
export type SttOutcome = { result: SttAttempt; attempts: number; retried: boolean }

/**
 * Auto-detect first. When the user has languages and the transcript is not empty, the audio is sent ONCE more
 * with the first language forced if the detected language is not one of them or `language_probability` is below
 * {@link MIN_LANGUAGE_PROBABILITY}. The more confident attempt wins (a tie keeps the first; an empty retry never
 * wins). A failing retry keeps the first result, except when the run was cancelled.
 */
export async function transcribeWithRetry(
  call: (languageCode: string | undefined) => Promise<SttAttempt>,
  languages: readonly string[]
): Promise<SttOutcome> {
  const first = await call(undefined)
  const preferred = languages[0]
  if (!preferred || !first.text) return { result: first, attempts: 1, retried: false }
  const detected = toIso1(first.languageCode)
  const confident = first.languageProbability === undefined || first.languageProbability >= MIN_LANGUAGE_PROBABILITY
  if (detected && languages.includes(detected) && confident) return { result: first, attempts: 1, retried: false }
  try {
    const second = await call(preferred)
    const better = second.text !== '' && (second.languageProbability ?? 0) > (first.languageProbability ?? 0)
    return { result: better ? second : first, attempts: 2, retried: true }
  } catch (error) {
    if (error instanceof SttError && error.code === 'aborted') throw error
    // A failed call is not billed by the provider, so only the first attempt counts.
    return { result: first, attempts: 1, retried: true }
  }
}
