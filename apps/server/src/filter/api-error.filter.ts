import { ErrorCode, type ApiError } from '@comma/shared'
import {
  type ArgumentsHost,
  BadRequestException,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Inject,
  Logger
} from '@nestjs/common'
import type { Response } from 'express'

const STATUS_CODES: Partial<Record<number, ErrorCode>> = {
  [HttpStatus.BAD_REQUEST]: 'bad_request',
  [HttpStatus.UNAUTHORIZED]: 'unauthorized',
  [HttpStatus.FORBIDDEN]: 'forbidden',
  [HttpStatus.NOT_FOUND]: 'not_found',
  [HttpStatus.CONFLICT]: 'conflict',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'bad_request',
  [HttpStatus.TOO_MANY_REQUESTS]: 'rate_limited',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'service_unavailable'
}

/** An `HttpException` whose body is already an `ApiError`. */
export class ApiException extends HttpException {
  constructor(status: HttpStatus, code: ErrorCode, message: string, extra: Omit<ApiError, 'code' | 'message'> = {}) {
    super({ code, message, ...extra } satisfies ApiError, status)
  }
}

/** A Standard Schema issue, as zod reports it to `StandardSchemaValidationPipe`. */
type SchemaIssue = { readonly message: string; readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> }

/** `StandardSchemaValidationPipe` exception factory: one `validation_failed` naming each bad field. */
export function validationException(issues: readonly SchemaIssue[]): BadRequestException {
  const message = issues
    .slice(0, 10)
    .map((issue) => {
      const path = (issue.path ?? []).map((part) => String(typeof part === 'object' ? part.key : part)).join('.')
      return path ? `${path}: ${issue.message}` : issue.message
    })
    .join('; ')
  return new BadRequestException({ code: 'validation_failed', message } satisfies ApiError)
}

/**
 * Every error leaves as `{ code, message }`. Codes thrown by our own code pass through; the
 * authentication library's `errorCode` is kept when it is one of ours; anything else gets the code
 * of its HTTP status. Unexpected errors are logged and answered with a bare 500.
 */
@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  @Inject()
  private readonly logger: Logger

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>()
    const [status, body] = this.toApiError(exception)
    if (status >= 500 && status !== HttpStatus.SERVICE_UNAVAILABLE) {
      this.logger.error(
        exception instanceof Error ? (exception.stack ?? exception.message) : String(exception),
        ApiErrorFilter.name
      )
    }
    response.status(status).json(body)
  }

  private toApiError(exception: unknown): [number, ApiError] {
    if (!(exception instanceof HttpException)) {
      return [HttpStatus.INTERNAL_SERVER_ERROR, { code: 'internal_error', message: 'Internal server error' }]
    }
    const status = exception.getStatus()
    const raw = exception.getResponse()
    const fields: Record<string, unknown> = typeof raw === 'object' && raw !== null ? { ...raw } : { message: raw }
    const own = ErrorCode.safeParse(fields.code ?? fields.errorCode)
    const code = own.success ? own.data : (STATUS_CODES[status] ?? (status >= 500 ? 'internal_error' : 'bad_request'))
    const message = Array.isArray(fields.message)
      ? fields.message.join('; ')
      : typeof fields.message === 'string'
        ? fields.message
        : exception.message
    const resetsAt = typeof fields.resets_at === 'string' ? { resets_at: fields.resets_at } : {}
    return [status, { code, message, ...resetsAt }]
  }
}
