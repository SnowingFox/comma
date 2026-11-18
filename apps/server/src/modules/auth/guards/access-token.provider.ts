import { type ExecutionContext, Injectable } from '@nestjs/common'
import {
  AuthenticationError,
  AuthenticationProvider,
  AuthenticationRegistry,
  type AuthenticationResult
} from '@nestjs/authentication'
import type { AccessClaims, AuthUser } from '@/app'
import { DeviceService } from '@/modules/device/device.service'
import { SessionService } from '../session.service'

/** `Authorization: Bearer <access token>` for the global guard; a signed-out device's tokens stop at once. */
@Injectable()
export class AccessTokenProvider extends AuthenticationProvider<AuthUser, AccessClaims> {
  // The library requires providers to register from their own constructor.
  constructor(
    registry: AuthenticationRegistry,
    private readonly sessions: SessionService,
    private readonly devices: DeviceService
  ) {
    super()
    registry.registerProvider(this)
  }

  async authenticate(context: ExecutionContext): Promise<AuthenticationResult<AuthUser, AccessClaims> | null> {
    const header = this.header(context, 'authorization')
    if (!header) {
      return null
    }
    const [scheme, token] = header.split(' ')
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      throw this.reject()
    }
    const claims = await this.sessions.verifyAccessToken(token)
    if (!claims || !(await this.devices.isActive(claims.sub, claims.did))) {
      throw this.reject()
    }
    return { user: { userId: claims.sub, deviceId: claims.did }, session: claims }
  }

  override challenge(): string {
    return 'Bearer realm="comma"'
  }

  private reject(): AuthenticationError {
    return new AuthenticationError('Invalid or expired access token', {
      code: 'invalid_token',
      challenge: 'Bearer realm="comma", error="invalid_token"'
    })
  }
}
