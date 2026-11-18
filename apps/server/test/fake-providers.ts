import type { Server } from 'bun'

/** 16 kHz mono PCM16 WAV of `seconds` of silence. */
export function wav(seconds: number, sampleRate = 16_000): Uint8Array {
  const dataBytes = Math.round(seconds * sampleRate) * 2
  const bytes = new Uint8Array(44 + dataBytes)
  const view = new DataView(bytes.buffer)
  const ascii = (offset: number, text: string) => [...text].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)))
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, dataBytes, true)
  return bytes
}

function oggPage(granule: bigint, packet: Uint8Array, flags: number): Uint8Array {
  const page = new Uint8Array(27 + 1 + packet.length)
  const view = new DataView(page.buffer)
  page.set([0x4f, 0x67, 0x67, 0x53])
  view.setUint8(5, flags)
  view.setBigInt64(6, granule, true)
  view.setUint8(26, 1)
  view.setUint8(27, packet.length)
  page.set(packet, 28)
  return page
}

/** A minimal Ogg/Opus stream (OpusHead page, one audio page) lasting `seconds` after a 312-sample pre-skip. */
export function oggOpus(seconds: number): Uint8Array {
  const head = new Uint8Array(19)
  head.set(new TextEncoder().encode('OpusHead'))
  head[8] = 1
  head[9] = 1
  new DataView(head.buffer).setUint16(10, 312, true)
  new DataView(head.buffer).setUint32(12, 48_000, true)
  const first = oggPage(0n, head, 0x02)
  const last = oggPage(BigInt(Math.round(seconds * 48_000) + 312), new Uint8Array([0xfc, 0xff, 0xfe]), 0x04)
  const out = new Uint8Array(first.length + last.length)
  out.set(first)
  out.set(last, first.length)
  return out
}

export type SttCall = { apiKey: string | null; modelId: string; languageCode: string | null; keyterms: string[]; fileType: string }
export type LlmCall = { authorization: string | null; body: any }

type SttReply = { status?: number; json: unknown; delayMs?: number }
type LlmReply = { status?: number; deltas?: string[]; json?: unknown; usage?: Record<string, unknown>; delayMs?: number }

/**
 * Stands in for ElevenLabs (`POST /v1/speech-to-text`) and an OpenAI-compatible endpoint
 * (`POST /v1/chat/completions`, SSE). Replies are queued per test; the last one repeats.
 */
export class FakeProviders {
  readonly sttCalls: SttCall[] = []
  readonly llmCalls: LlmCall[] = []
  private sttReplies: SttReply[] = []
  private llmReplies: LlmReply[] = []
  private server: Server<undefined>

  constructor() {
    this.server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (request) => this.handle(request) })
  }

  get elevenlabsUrl(): string {
    return `http://127.0.0.1:${this.server.port}`
  }

  get llmUrl(): string {
    return `http://127.0.0.1:${this.server.port}/v1`
  }

  reset(): void {
    this.sttCalls.length = 0
    this.llmCalls.length = 0
    this.sttReplies = []
    this.llmReplies = []
  }

  stt(...replies: SttReply[]): this {
    this.sttReplies.push(...replies)
    return this
  }

  llm(...replies: LlmReply[]): this {
    this.llmReplies.push(...replies)
    return this
  }

  /** A typical ElevenLabs body. */
  static transcript(text: string, language = 'eng', probability = 0.98): SttReply {
    return { json: { text, language_code: language, language_probability: probability, words: [] } }
  }

  stop(): void {
    this.server.stop(true)
  }

  private next<T>(queue: T[]): T | undefined {
    return queue.length > 1 ? queue.shift() : queue[0]
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'POST' && url.pathname === '/v1/speech-to-text') {
      const form = await request.formData()
      const file = form.get('file')
      this.sttCalls.push({
        apiKey: request.headers.get('xi-api-key'),
        modelId: String(form.get('model_id')),
        languageCode: form.has('language_code') ? String(form.get('language_code')) : null,
        keyterms: form.getAll('keyterms').map(String),
        fileType: file instanceof Blob ? file.type : ''
      })
      const reply = this.next(this.sttReplies) ?? FakeProviders.transcript('')
      if (reply.delayMs) await Bun.sleep(reply.delayMs)
      return Response.json(reply.json, { status: reply.status ?? 200 })
    }
    if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const body: any = await request.json()
      this.llmCalls.push({ authorization: request.headers.get('authorization'), body })
      const reply = this.next(this.llmReplies) ?? { deltas: [] }
      if (reply.delayMs) await Bun.sleep(reply.delayMs)
      if (reply.status && reply.status >= 400) return Response.json(reply.json ?? { error: { message: 'failed' } }, { status: reply.status })
      const usage = reply.usage ?? { prompt_tokens: 120, completion_tokens: 12, completion_tokens_details: { reasoning_tokens: 0 } }
      const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
        `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`
      const events = [
        chunk({ role: 'assistant', content: '' }),
        ...(reply.deltas ?? []).map((content) => chunk({ content })),
        `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
        `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [], usage })}\n\n`,
        'data: [DONE]\n\n'
      ]
      return new Response(events.join(''), { headers: { 'content-type': 'text/event-stream' } })
    }
    return new Response('not found', { status: 404 })
  }
}
