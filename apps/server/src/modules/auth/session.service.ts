import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common'
import { InjectDrizzle } from '@nestjs/drizzle'
import { and, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm'
import { jwtVerify, SignJWT } from 'jose'
import type { AccessClaims } from '@/app'
import { AuthConfig, JwtConfig } from '@/app.config'
import { devices, refreshTokens } from '@/entity'
import { ApiException } from '@/filter/api-error.filter'
import { DeviceService } from '@/modules/device/device.service'
import type { Database } from '@/utils/database'
import { hashToken, newOpaqueToken } from '@/utils/token'

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60
const ISSUER = 'comma-server'
const AUDIENCE = 'comma'

export type IssuedTokens = { access_token: string; refresh_token: string; expires_in: number }

/**
 * Access tokens are HS256 JWTs (`sub` user, `did` device). Refresh tokens are 32 random bytes,
 * stored as SHA-256 on the device they were issued to, and single use: each refresh spends the
 * presented one and issues the next. Presenting a spent one again means it was copied, so the
 * device is signed out.
 */
@Injectable()
export class SessionService {
  @InjectDrizzle()
  private readonly db: Database

  @Inject()
  private readonly jwt: JwtConfig

  @Inject()
  private readonly auth: AuthConfig

  @Inject()
  private readonly devices: DeviceService

  @Inject()
  private readonly logger: Logger

  private key?: Uint8Array

  async issue(userId: string, deviceId: string): Promise<IssuedTokens> {
    const refreshToken = newOpaqueToken()
    await this.db.insert(refreshTokens).values({
      tokenHash: hashToken(refreshToken),
      deviceId,
      expiresAt: this.refreshExpiry()
    })
    return {
      access_token: await this.signAccessToken(userId, deviceId),
      refresh_token: refreshToken,
      expires_in: ACCESS_TOKEN_TTL_SECONDS
    }
  }

  /** Spends `refreshToken` and issues the next pair for the same device. */
  async rotate(refreshToken: string): Promise<IssuedTokens & { userId: string }> {
    const tokenHash = hashToken(refreshToken)
    const now = new Date()
    const rotated = await this.db.transaction(async (tx) => {
      // One conditional write, so two concurrent refreshes with one token cannot both win.
      const [spent] = await tx
        .update(refreshTokens)
        .set({ usedAt: now })
        .where(and(eq(refreshTokens.tokenHash, tokenHash), isNull(refreshTokens.usedAt)))
        .returning()
      if (!spent || spent.expiresAt <= now) {
        return spent ? 'expired' : 'unknown'
      }
      const device = await tx.query.devices.findFirst({ where: eq(devices.id, spent.deviceId) })
      if (!device) {
        return 'unknown'
      }
      const next = newOpaqueToken()
      await tx.insert(refreshTokens).values({ tokenHash: hashToken(next), deviceId: device.id, expiresAt: this.refreshExpiry() })
      // The database clock, like the column default the device was created with.
      await tx.update(devices).set({ lastSeenAt: sql`now()` }).where(eq(devices.id, device.id))
      // Spent tokens are kept for reuse detection only until they would have expired anyway.
      await tx
        .delete(refreshTokens)
        .where(and(eq(refreshTokens.deviceId, device.id), isNotNull(refreshTokens.usedAt), lt(refreshTokens.expiresAt, now)))
      return { userId: device.userId, deviceId: device.id, refreshToken: next }
    })
    if (rotated === 'expired') {
      throw new ApiException(HttpStatus.UNAUTHORIZED, 'invalid_refresh_token', 'Refresh token expired')
    }
    if (rotated === 'unknown') {
      // Not live: either never issued, or already spent. A spent one is a replay.
      const reused = await this.db.query.refreshTokens.findFirst({ where: eq(refreshTokens.tokenHash, tokenHash) })
      if (reused) {
        await this.devices.remove(reused.deviceId)
        this.logger.warn(`refresh token reused; signed out device ${reused.deviceId}`, SessionService.name)
        throw new ApiException(HttpStatus.UNAUTHORIZED, 'refresh_token_reused', 'Refresh token was already used')
      }
      throw new ApiException(HttpStatus.UNAUTHORIZED, 'invalid_refresh_token', 'Invalid refresh token')
    }
    return {
      userId: rotated.userId,
      access_token: await this.signAccessToken(rotated.userId, rotated.deviceId),
      refresh_token: rotated.refreshToken,
      expires_in: ACCESS_TOKEN_TTL_SECONDS
    }
  }

  /** Signs out the device a refresh token (live or spent) belongs to. Unknown tokens are ignored. */
  async revoke(refreshToken: string): Promise<void> {
    const token = await this.db.query.refreshTokens.findFirst({ where: eq(refreshTokens.tokenHash, hashToken(refreshToken)) })
    if (token) {
      await this.devices.remove(token.deviceId)
    }
  }

  /** `null` for anything but a valid, unexpired access token of ours. */
  async verifyAccessToken(token: string): Promise<AccessClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.signingKey(), {
        algorithms: ['HS256'],
        issuer: ISSUER,
        audience: AUDIENCE,
        requiredClaims: ['sub', 'did', 'iat', 'exp']
      })
      const { sub, did, iat, exp } = payload
      if (typeof sub !== 'string' || typeof did !== 'string' || typeof iat !== 'number' || typeof exp !== 'number') {
        return null
      }
      return { sub, did, iat, exp }
    } catch {
      return null
    }
  }

  private async signAccessToken(userId: string, deviceId: string): Promise<string> {
    return await new SignJWT({ did: deviceId })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(userId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
      .sign(this.signingKey())
  }

  private signingKey(): Uint8Array {
    this.key ??= new TextEncoder().encode(this.jwt.secret)
    return this.key
  }

  private refreshExpiry(): Date {
    return new Date(Date.now() + this.auth.refreshTtlDays * 24 * 60 * 60 * 1000)
  }
}
