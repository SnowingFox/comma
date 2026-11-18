import { Body, Controller, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common'
import { Public } from '@nestjs/authentication'
import { Throttle } from '@nestjs/throttler'
import {
  LoginRequest,
  LogoutRequest,
  type OkResponse,
  RefreshRequest,
  RegisterRequest,
  type RegisterResponse,
  ResendVerificationRequest,
  type TokenResponse,
  VerifyEmailRequest
} from '@comma/shared'
import type { z } from 'zod'
import { AuthService } from './auth.service'

/** Per client IP, per route, per minute. */
export const AUTH_THROTTLE = { register: 10, verify: 10, resend: 5, login: 10, refresh: 30 } as const

const perMinute = (limit: number) => ({ default: { limit, ttl: 60_000 } })

@Controller({ path: '/auth', version: '1' })
@Public()
export class AuthController {
  @Inject()
  private readonly service: AuthService

  @Post('/register')
  @Throttle(perMinute(AUTH_THROTTLE.register))
  register(@Body({ schema: RegisterRequest }) body: RegisterRequest): Promise<RegisterResponse> {
    return this.service.register(body)
  }

  @Post('/verify-email')
  @HttpCode(HttpStatus.OK)
  @Throttle(perMinute(AUTH_THROTTLE.verify))
  async verifyEmail(@Body({ schema: VerifyEmailRequest }) body: VerifyEmailRequest): Promise<OkResponse> {
    await this.service.verifyEmail(body)
    return { ok: true }
  }

  @Post('/verify-email/resend')
  @HttpCode(HttpStatus.OK)
  @Throttle(perMinute(AUTH_THROTTLE.resend))
  async resend(@Body({ schema: ResendVerificationRequest }) body: ResendVerificationRequest): Promise<OkResponse> {
    await this.service.resendVerification(body)
    return { ok: true }
  }

  @Post('/login')
  @HttpCode(HttpStatus.OK)
  @Throttle(perMinute(AUTH_THROTTLE.login))
  login(@Body({ schema: LoginRequest }) body: z.output<typeof LoginRequest>): Promise<TokenResponse> {
    return this.service.login(body)
  }

  @Post('/refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle(perMinute(AUTH_THROTTLE.refresh))
  refresh(@Body({ schema: RefreshRequest }) body: RefreshRequest): Promise<TokenResponse> {
    return this.service.refresh(body.refresh_token)
  }

  /** Takes the refresh token, so a client can sign out even after its access token expired. */
  @Post('/logout')
  @HttpCode(HttpStatus.OK)
  async logout(@Body({ schema: LogoutRequest }) body: LogoutRequest): Promise<OkResponse> {
    await this.service.logout(body.refresh_token)
    return { ok: true }
  }
}
