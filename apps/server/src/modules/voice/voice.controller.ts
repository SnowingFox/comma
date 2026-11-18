import { Body, Controller, HttpCode, HttpStatus, Inject, Post, Res, UploadedFile, UseInterceptors } from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import { VoiceRunMeta, type VoiceRunResponse } from '@comma/shared'
import type { Response } from 'express'
import type { AuthUser } from '@/app'
import { User } from '@/decorator/user.decorator'
import { validationException } from '@/filter/api-error.filter'
import { AudioUploadInterceptor } from './audio-upload.interceptor'
import { VoiceService } from './voice.service'

type UploadedAudio = { buffer: Buffer; size: number }

function parseMeta(raw: unknown): VoiceRunMeta {
  let json: unknown
  try {
    json = typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch {
    throw validationException([{ message: 'meta: must be a JSON object' }])
  }
  const parsed = VoiceRunMeta.safeParse(json)
  if (!parsed.success) {
    throw validationException(parsed.error.issues.map((issue) => ({ message: issue.message, path: ['meta', ...issue.path] })))
  }
  return parsed.data
}

@Controller({ path: '/voice', version: '1' })
export class VoiceController {
  @Inject()
  private readonly voice: VoiceService

  /** multipart/form-data: `audio` (WAV or Ogg/Opus) and `meta` (JSON, see `VoiceRunMeta`). */
  @Post('/runs')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @UseInterceptors(AudioUploadInterceptor)
  run(
    @User() caller: AuthUser,
    @UploadedFile() file: UploadedAudio | undefined,
    @Body() body: Record<string, unknown> | undefined,
    @Res({ passthrough: true }) response: Response
  ): Promise<VoiceRunResponse> {
    const meta = parseMeta(body?.meta)
    // The client hanging up cancels the provider calls.
    const cancel = new AbortController()
    response.on('close', () => {
      if (!response.writableFinished) cancel.abort()
    })
    const audio = file ? new Uint8Array(file.buffer.buffer, file.buffer.byteOffset, file.buffer.byteLength) : undefined
    return this.voice.run(caller, audio, meta, cancel.signal)
  }
}
