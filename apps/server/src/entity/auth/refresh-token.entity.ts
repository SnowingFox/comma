import { index, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core'
import { devices } from '../device/device.entity'

/**
 * Every refresh token a device was issued, by SHA-256. Spent ones stay (with `usedAt`) until they
 * expire, so presenting one again is recognised as reuse.
 */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    tokenHash: varchar('token_hash', { length: 64 }).primaryKey(),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true, mode: 'date' })
  },
  (table) => [index('refresh_tokens_device_idx').on(table.deviceId)]
)

export type RefreshTokenRow = typeof refreshTokens.$inferSelect
