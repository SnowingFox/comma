import { HttpStatus, Inject, Injectable } from '@nestjs/common'
import { InjectDrizzle } from '@nestjs/drizzle'
import { and, eq, gt, lt, lte, sql } from 'drizzle-orm'
import { JwtConfig } from '@/app.config'
import { type EmailCodePurpose, emailCodes, users } from '@/entity'
import { ApiException } from '@/filter/api-error.filter'
import type { Database } from '@/utils/database'
import { hashEmailCode, newEmailCode, sameSecret } from '@/utils/token'

export const CODE_TTL_MS = 10 * 60 * 1000
export const RESEND_COOLDOWN_MS = 60 * 1000
export const MAX_ATTEMPTS = 5

const VERIFY: EmailCodePurpose = 'verify_email'

/** 6-digit email codes: one outstanding per user, hashed, 10 minutes, 5 attempts, resend after 60 s. */
@Injectable()
export class EmailCodeService {
  @InjectDrizzle()
  private readonly db: Database

  @Inject()
  private readonly jwt: JwtConfig

  /** A new code replacing the outstanding one; `resend_cooldown` within 60 s of the last. */
  async issueVerificationCode(userId: string): Promise<string> {
    const code = newEmailCode()
    const now = new Date()
    const values = {
      codeHash: hashEmailCode(this.jwt.secret, userId, VERIFY, code),
      attempts: 0,
      sentAt: now,
      expiresAt: new Date(now.getTime() + CODE_TTL_MS)
    }
    // One statement: the cooldown check and the replacement cannot race.
    const written = await this.db
      .insert(emailCodes)
      .values({ userId, purpose: VERIFY, ...values })
      .onConflictDoUpdate({
        target: [emailCodes.userId, emailCodes.purpose],
        set: values,
        setWhere: lte(emailCodes.sentAt, new Date(now.getTime() - RESEND_COOLDOWN_MS))
      })
      .returning({ userId: emailCodes.userId })
    if (written.length === 0) {
      throw new ApiException(HttpStatus.TOO_MANY_REQUESTS, 'resend_cooldown', 'Wait a minute before asking for another code')
    }
    return code
  }

  /** Marks the user verified when `code` matches; every try, right or wrong, uses up an attempt. */
  async verifyEmail(userId: string, code: string): Promise<void> {
    const now = new Date()
    const [attempt] = await this.db
      .update(emailCodes)
      .set({ attempts: sql`${emailCodes.attempts} + 1` })
      .where(
        and(
          eq(emailCodes.userId, userId),
          eq(emailCodes.purpose, VERIFY),
          lt(emailCodes.attempts, MAX_ATTEMPTS),
          gt(emailCodes.expiresAt, now)
        )
      )
      .returning()
    if (!attempt) {
      throw await this.unusable(userId, now)
    }
    if (!sameSecret(attempt.codeHash, hashEmailCode(this.jwt.secret, userId, VERIFY, code))) {
      const left = MAX_ATTEMPTS - attempt.attempts
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        left > 0 ? 'invalid_code' : 'too_many_attempts',
        left > 0 ? `Wrong code, ${left} attempts left` : 'Too many wrong codes; ask for a new one'
      )
    }
    await this.db.transaction(async (tx) => {
      await tx.delete(emailCodes).where(and(eq(emailCodes.userId, userId), eq(emailCodes.purpose, VERIFY)))
      await tx.update(users).set({ emailVerifiedAt: now, updatedAt: now }).where(eq(users.id, userId))
    })
  }

  private async unusable(userId: string, now: Date): Promise<ApiException> {
    const row = await this.db.query.emailCodes.findFirst({
      where: and(eq(emailCodes.userId, userId), eq(emailCodes.purpose, VERIFY))
    })
    if (row && row.expiresAt <= now) {
      return new ApiException(HttpStatus.BAD_REQUEST, 'code_expired', 'The code has expired; ask for a new one')
    }
    if (row) {
      return new ApiException(HttpStatus.BAD_REQUEST, 'too_many_attempts', 'Too many wrong codes; ask for a new one')
    }
    return new ApiException(HttpStatus.BAD_REQUEST, 'invalid_code', 'Invalid code')
  }
}
