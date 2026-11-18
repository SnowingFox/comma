import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'

/** 32 random bytes, base64url: the refresh token the client keeps. */
export function newOpaqueToken(): string {
  return randomBytes(32).toString('base64url')
}

/** Only the SHA-256 of an opaque token is ever stored. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** A uniformly random 6-digit code, zero-padded. */
export function newEmailCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0')
}

/**
 * Keyed hash of an emailed code, bound to its user and purpose. A plain hash of 6 digits is reversed
 * by trying all million; with the server key a leaked row reveals nothing.
 */
export function hashEmailCode(key: string, userId: string, purpose: string, code: string): string {
  return createHmac('sha256', key).update(`${purpose}:${userId}:${code}`).digest('hex')
}

export function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
