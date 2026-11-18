import { index, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core'
import { users } from '../user/user.entity'

/**
 * One signed-in app install, created by each login. Access tokens carry its id as `did`; deleting the
 * row (logout, revoke, refresh-token reuse) stops its refresh and access tokens at once.
 */
export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 100 }).notNull(),
    platform: varchar('platform', { length: 32 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow()
  },
  (table) => [index('devices_user_idx').on(table.userId)]
)

export type DeviceRow = typeof devices.$inferSelect
