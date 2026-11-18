import { DEFAULT_USER_SETTINGS, type User } from '@comma/shared'
import type { UserRow } from '@/entity'

/** The API shape of a user row. */
export function presentUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    email_verified: row.emailVerifiedAt !== null,
    plan: row.plan,
    settings: { ...DEFAULT_USER_SETTINGS, ...row.settings },
    created_at: row.createdAt.toISOString()
  }
}
