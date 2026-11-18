import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common'
import type {
  LoginRequest,
  RegisterRequest,
  RegisterResponse,
  ResendVerificationRequest,
  TokenResponse,
  VerifyEmailRequest
} from '@comma/shared'
import type { z } from 'zod'
import { ApiException } from '@/filter/api-error.filter'
import { DeviceService } from '@/modules/device/device.service'
import { presentUser } from '@/modules/user/internal/user.presenter'
import { UserService } from '@/modules/user/user.service'
import { newOpaqueToken } from '@/utils/token'
import { EmailCodeService } from './email-code.service'
import { Mailer } from './mailer'
import { SessionService } from './session.service'

const PASSWORD_HASH = { algorithm: 'argon2id' } as const

/** Verified against when the email is unknown, so a miss costs as much time as a wrong password. */
const DUMMY_HASH = Bun.password.hash(newOpaqueToken(), PASSWORD_HASH)

@Injectable()
export class AuthService {
  @Inject()
  private readonly users: UserService

  @Inject()
  private readonly devices: DeviceService

  @Inject()
  private readonly codes: EmailCodeService

  @Inject()
  private readonly sessions: SessionService

  @Inject()
  private readonly mailer: Mailer

  @Inject()
  private readonly logger: Logger

  async register(body: RegisterRequest): Promise<RegisterResponse> {
    const user = await this.users.create({
      email: body.email,
      name: body.name,
      passwordHash: await Bun.password.hash(body.password, PASSWORD_HASH)
    })
    if (!user) {
      throw new ApiException(HttpStatus.CONFLICT, 'email_taken', 'An account with this email already exists')
    }
    this.logger.log(`registered user ${user.id}`, AuthService.name)
    await this.sendCode(user.id, user.email, user.name)
    return { user: presentUser(user) }
  }

  /** Already verified is success too, so a retried request does not fail. */
  async verifyEmail(body: VerifyEmailRequest): Promise<void> {
    const user = await this.users.findByEmail(body.email)
    if (!user) {
      throw new ApiException(HttpStatus.BAD_REQUEST, 'invalid_code', 'Invalid code')
    }
    if (user.emailVerifiedAt === null) {
      await this.codes.verifyEmail(user.id, body.code)
    }
  }

  /** Quietly does nothing for unknown or verified addresses, so it cannot be used to probe accounts. */
  async resendVerification(body: ResendVerificationRequest): Promise<void> {
    const user = await this.users.findByEmail(body.email)
    if (user && user.emailVerifiedAt === null) {
      await this.sendCode(user.id, user.email, user.name)
    }
  }

  async login(body: z.output<typeof LoginRequest>): Promise<TokenResponse> {
    const user = await this.users.findByEmail(body.email)
    const valid = await Bun.password.verify(body.password, user?.passwordHash ?? (await DUMMY_HASH))
    if (!user || !valid) {
      throw new ApiException(HttpStatus.UNAUTHORIZED, 'invalid_credentials', 'Wrong email or password')
    }
    if (user.emailVerifiedAt === null) {
      throw new ApiException(HttpStatus.FORBIDDEN, 'email_not_verified', 'Verify your email before signing in')
    }
    const device = await this.devices.create({ userId: user.id, name: body.device_name, platform: body.platform })
    const tokens = await this.sessions.issue(user.id, device.id)
    return { ...tokens, user: presentUser(user) }
  }

  async refresh(refreshToken: string): Promise<TokenResponse> {
    const { userId, ...tokens } = await this.sessions.rotate(refreshToken)
    return { ...tokens, user: presentUser(await this.users.getUser(userId)) }
  }

  async logout(refreshToken: string): Promise<void> {
    await this.sessions.revoke(refreshToken)
  }

  private async sendCode(userId: string, email: string, name: string): Promise<void> {
    const code = await this.codes.issueVerificationCode(userId)
    await this.mailer.sendVerificationCode({ to: email, name, code })
  }
}
