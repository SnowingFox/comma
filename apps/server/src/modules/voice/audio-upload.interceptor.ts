import { type CallHandler, type ExecutionContext, HttpStatus, Injectable, type NestInterceptor, PayloadTooLargeException } from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import { VOICE_LIMITS } from '@comma/shared'
import type { Observable } from 'rxjs'
import { ApiException } from '@/filter/api-error.filter'

const Multipart = FileInterceptor('audio', {
  // Memory storage: the file is in `file.buffer`, nothing touches the disk.
  limits: { fileSize: VOICE_LIMITS.maxAudioBytes, files: 1, fields: 4, fieldSize: 256 * 1024 }
})

/** Reads the `audio` and `meta` parts; an oversized upload becomes 413 `audio_too_large`. */
@Injectable()
export class AudioUploadInterceptor implements NestInterceptor {
  private readonly multipart = new Multipart()

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    try {
      return await this.multipart.intercept(context, next)
    } catch (error) {
      if (error instanceof PayloadTooLargeException) {
        throw new ApiException(HttpStatus.PAYLOAD_TOO_LARGE, 'audio_too_large', 'Audio is larger than 25 MB')
      }
      throw error
    }
  }
}
