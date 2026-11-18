import { z } from 'zod'
import { User, UserName } from './user'

/** Trimmed and lowercased before it is checked, so the server stores one form. */
export const Email = z.string().trim().toLowerCase().pipe(z.email().max(320))

/** Policy for new passwords; login accepts any non-empty string. */
export const NewPassword = z.string().min(8).max(256)

/** The 6-digit code from the verification email. */
export const EmailCode = z.string().regex(/^\d{6}$/, 'expected 6 digits')

/** `POST /v1/auth/register` -> 201 {@link RegisterResponse}. The account stays unverified until verify-email. */
export const RegisterRequest = z.object({
  email: Email,
  password: NewPassword,
  name: UserName
})
export type RegisterRequest = z.infer<typeof RegisterRequest>

export const RegisterResponse = z.object({ user: User })
export type RegisterResponse = z.infer<typeof RegisterResponse>

/** `POST /v1/auth/verify-email` -> 200 `OkResponse`. */
export const VerifyEmailRequest = z.object({ email: Email, code: EmailCode })
export type VerifyEmailRequest = z.infer<typeof VerifyEmailRequest>

/** `POST /v1/auth/verify-email/resend` -> 200 `OkResponse`, also for unknown or verified addresses. */
export const ResendVerificationRequest = z.object({ email: Email })
export type ResendVerificationRequest = z.infer<typeof ResendVerificationRequest>

/** `POST /v1/auth/login` -> 200 {@link TokenResponse}. Each login is a new device. */
export const LoginRequest = z.object({
  email: Email,
  password: z.string().min(1).max(256),
  /** Shown in the device list, e.g. "Ada's MacBook Pro". */
  device_name: z.string().trim().min(1).max(100).default('Unknown device'),
  /** e.g. `macos`. */
  platform: z.string().trim().min(1).max(32).default('unknown')
})
export type LoginRequest = z.input<typeof LoginRequest>

/** `POST /v1/auth/refresh` -> 200 {@link TokenResponse}. The presented token stops working. */
export const RefreshRequest = z.object({ refresh_token: z.string().min(1).max(256) })
export type RefreshRequest = z.infer<typeof RefreshRequest>

/** `POST /v1/auth/logout` -> 200 `OkResponse`. Signs the token's device out. */
export const LogoutRequest = z.object({ refresh_token: z.string().min(1).max(256) })
export type LogoutRequest = z.infer<typeof LogoutRequest>

export const TokenResponse = z.object({
  /** HS256 JWT for `Authorization: Bearer`. */
  access_token: z.string(),
  /** Opaque; single use, replaced by every refresh. */
  refresh_token: z.string(),
  /** Seconds until `access_token` expires. */
  expires_in: z.number().int().positive(),
  user: User
})
export type TokenResponse = z.infer<typeof TokenResponse>
