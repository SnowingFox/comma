import { Inject, Injectable } from '@nestjs/common'
import { APICallError, RetryError, streamText } from 'ai'
import { LlmConfig } from '@/app.config'
import { redact } from '../internal/redact'
import { createLlm, llmConfigured, type LlmWiring } from './llm-model'

export type RewriteResult = {
  text: string
  promptTokens: number
  completionTokens: number
  reasoningTokens: number
  /** Request start to the first text chunk; equals `totalMs` when no text came. */
  ttftMs: number
  totalMs: number
}

export type LlmErrorCode = 'auth' | 'rate_limited' | 'http' | 'network' | 'timeout' | 'aborted'

export class LlmError extends Error {
  override readonly name = 'LlmError'
  constructor(
    message: string,
    readonly code: LlmErrorCode,
    readonly status: number | null = null
  ) {
    super(message)
  }
}

export const LLM_TIMEOUT_MS = 90_000

/**
 * One streamed rewrite. `signal` is the caller's cancel (client gone); the timeout is added here. Errors come back
 * as {@link LlmError} with the provider's status; `secrets` are scrubbed from every message.
 */
export async function streamRewrite(
  wiring: LlmWiring,
  input: { instructions: string; prompt: string; signal?: AbortSignal; timeoutMs?: number; secrets?: string[] }
): Promise<RewriteResult> {
  const timeout = AbortSignal.timeout(input.timeoutMs ?? LLM_TIMEOUT_MS)
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout
  const started = performance.now()
  let ttftMs: number | undefined
  let text = ''
  let streamError: unknown
  try {
    const result = streamText({
      model: wiring.model,
      instructions: input.instructions,
      prompt: input.prompt,
      providerOptions: wiring.providerOptions,
      abortSignal: signal,
      maxRetries: 1,
      // Errors are mapped below. The default handler would print the request (the user's transcript) and the
      // provider's raw response to the console.
      onError: () => {}
    })
    for await (const part of result.stream) {
      if (part.type === 'text-delta' && part.text) {
        ttftMs ??= performance.now() - started
        text += part.text
      } else if (part.type === 'error') {
        streamError = part.error
        break
      } else if (part.type === 'abort') {
        break
      }
    }
    if (signal.aborted) throw signal.reason
    if (streamError !== undefined) throw streamError
    const usage = await result.totalUsage
    const totalMs = performance.now() - started
    return {
      text,
      promptTokens: usage.inputTokens ?? 0,
      completionTokens: usage.outputTokens ?? 0,
      reasoningTokens: usage.outputTokenDetails?.reasoningTokens ?? 0,
      ttftMs: ttftMs ?? totalMs,
      totalMs
    }
  } catch (error) {
    if (input.signal?.aborted) throw new LlmError('LLM request cancelled', 'aborted')
    if (timeout.aborted) throw new LlmError('LLM request timed out', 'timeout')
    throw toLlmError(error, input.secrets ?? [])
  }
}

export function toLlmError(error: unknown, secrets: string[]): LlmError {
  const cause = RetryError.isInstance(error) ? error.lastError : error
  const message = redact(cause instanceof Error ? cause.message : String(cause), secrets).slice(0, 300)
  if (APICallError.isInstance(cause)) {
    const status = cause.statusCode ?? null
    if (status === 401 || status === 403) return new LlmError(`LLM rejected the API key: ${message}`, 'auth', status)
    if (status === 429) return new LlmError(`LLM rate limit: ${message}`, 'rate_limited', status)
    if (status === null) return new LlmError(`Cannot reach the LLM: ${message}`, 'network')
    return new LlmError(`LLM returned HTTP ${status}: ${message}`, 'http', status)
  }
  return new LlmError(`LLM request failed: ${message}`, 'network')
}

@Injectable()
export class LlmClient {
  @Inject()
  private readonly config: LlmConfig

  private wiring: LlmWiring | undefined

  get configured(): boolean {
    return llmConfigured(this.config)
  }

  rewrite(input: { instructions: string; prompt: string; signal?: AbortSignal }): Promise<RewriteResult> {
    this.wiring ??= createLlm(this.config)
    return streamRewrite(this.wiring, { ...input, secrets: [this.config.apiKey ?? ''] })
  }
}
