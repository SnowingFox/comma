import { z } from 'zod'

/** Every error code the server answers with, in the `code` field of an {@link ApiError}. */
export const ErrorCode = z.enum([
  // Generic, by HTTP status.
  'bad_request',
  'validation_failed',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
  'service_unavailable',
  'internal_error',
  // Access tokens.
  'invalid_token',
  // Register, verify, login.
  'email_taken',
  'email_not_verified',
  'invalid_credentials',
  'invalid_code',
  'code_expired',
  'too_many_attempts',
  'resend_cooldown',
  // Refresh tokens.
  'invalid_refresh_token',
  'refresh_token_reused'
])
export type ErrorCode = z.infer<typeof ErrorCode>

/** Body of every non-2xx response. `message` is for humans and logs; branch on `code`. */
export const ApiError = z.object({
  code: ErrorCode,
  message: z.string()
})
export type ApiError = z.infer<typeof ApiError>

/** Body of an action that has nothing else to return. */
export const OkResponse = z.object({ ok: z.literal(true) })
export type OkResponse = z.infer<typeof OkResponse>
