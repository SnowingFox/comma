import { describe, expect, test } from 'bun:test'
import { APICallError, simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { LlmConfig } from '@/app.config'
import { streamRewrite } from '@/modules/voice/providers/llm'
import { createLlm, llmConfigured } from '@/modules/voice/providers/llm-model'

const config = (patch: Partial<LlmConfig>): LlmConfig =>
  Object.assign(new LlmConfig(), { provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'm', reasoningEffort: 'off' }, patch)

const usage = (input: number, output: number, reasoning?: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: output, text: output - (reasoning ?? 0), reasoning }
})

function mockModel(chunks: unknown[], options: { delayMs?: number } = {}) {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({ chunks: chunks as never[], initialDelayInMs: options.delayMs ?? 0, chunkDelayInMs: 0 })
    })
  })
}

const finish = (u = usage(50, 5, 2)) => ({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: u })

describe('LLM provider wiring', () => {
  test('openai-compatible: reasoning_effort none when off, as named otherwise, omitted for default', () => {
    expect(createLlm(config({ reasoningEffort: 'off' })).providerOptions).toEqual({ comma: { reasoningEffort: 'none' } })
    expect(createLlm(config({ reasoningEffort: 'high' })).providerOptions).toEqual({ comma: { reasoningEffort: 'high' } })
    expect(createLlm(config({ reasoningEffort: 'default' })).providerOptions).toEqual({})
    const model = createLlm(config({})).model as { provider: string; modelId: string }
    expect(model.provider).toStartWith('comma')
    expect(model.modelId).toBe('m')
  })

  test('deepseek: thinking disabled when off, its own effort levels otherwise, official URL by default', () => {
    const off = createLlm(config({ provider: 'deepseek', baseUrl: undefined, reasoningEffort: 'off' }))
    expect(off.providerOptions).toEqual({ deepseek: { thinking: { type: 'disabled' } } })
    expect((off.model as { provider: string }).provider).toStartWith('deepseek')
    expect(createLlm(config({ provider: 'deepseek', reasoningEffort: 'medium' })).providerOptions).toEqual({
      deepseek: { thinking: { type: 'enabled' }, reasoningEffort: 'high' }
    })
    expect(llmConfigured(config({ provider: 'deepseek', baseUrl: undefined }))).toBe(true)
  })

  test('configured needs a key, a model, and a base URL for openai-compatible', () => {
    expect(llmConfigured(config({}))).toBe(true)
    expect(llmConfigured(config({ baseUrl: undefined }))).toBe(false)
    expect(llmConfigured(config({ apiKey: undefined }))).toBe(false)
    expect(llmConfigured(config({ model: undefined }))).toBe(false)
  })
})

describe('streamed rewrite', () => {
  test('joins text, measures time to first token, reports usage with reasoning tokens', async () => {
    const model = mockModel([
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: 'Hello' },
      { type: 'text-delta', id: 't', delta: ', world.' },
      { type: 'text-end', id: 't' },
      finish()
    ], { delayMs: 30 })
    const result = await streamRewrite({ model, providerOptions: { comma: { reasoningEffort: 'none' } } }, { instructions: 'sys', prompt: 'user' })
    expect(result).toMatchObject({ text: 'Hello, world.', promptTokens: 50, completionTokens: 5, reasoningTokens: 2 })
    expect(result.ttftMs).toBeGreaterThanOrEqual(25)
    expect(result.totalMs).toBeGreaterThanOrEqual(result.ttftMs)
    const call = model.doStreamCalls[0]!
    expect(call.providerOptions).toEqual({ comma: { reasoningEffort: 'none' } })
    expect(JSON.stringify(call.prompt)).toContain('sys')
  })

  test('an error part becomes an LlmError with the status, key scrubbed', async () => {
    const error = new APICallError({ message: 'bad key secret-key', url: 'http://x', requestBodyValues: {}, statusCode: 401, isRetryable: false })
    const model = mockModel([{ type: 'stream-start', warnings: [] }, { type: 'error', error }])
    const failure = await streamRewrite({ model, providerOptions: {} }, { instructions: 's', prompt: 'u', secrets: ['secret-key'] }).catch((e: unknown) => e)
    expect(failure).toMatchObject({ name: 'LlmError', code: 'auth', status: 401 })
    expect((failure as Error).message).toContain('bad key [redacted]')
  })

  test('a thrown provider call maps by status', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw new APICallError({ message: 'slow down', url: 'http://x', requestBodyValues: {}, statusCode: 429, isRetryable: false })
      }
    })
    await expect(streamRewrite({ model, providerOptions: {} }, { instructions: 's', prompt: 'u' })).rejects.toMatchObject({ code: 'rate_limited' })
  })

  test('cancel and timeout abort the stream', async () => {
    const slow = () => mockModel([{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'x' }, finish()], { delayMs: 500 })
    const cancel = new AbortController()
    setTimeout(() => cancel.abort(), 20)
    await expect(streamRewrite({ model: slow(), providerOptions: {} }, { instructions: 's', prompt: 'u', signal: cancel.signal })).rejects.toMatchObject({ code: 'aborted' })
    await expect(streamRewrite({ model: slow(), providerOptions: {} }, { instructions: 's', prompt: 'u', timeoutMs: 20 })).rejects.toMatchObject({ code: 'timeout' })
  })
})
