import { integer, pgTable, primaryKey, timestamp, uuid, varchar } from 'drizzle-orm/pg-core'
import { users } from '../user/user.entity'

export type EmailCodePurpose = 'verify_email'

/** The one outstanding emailed code per user and purpose; a resend replaces it, success deletes it. */
export const emailCodes = pgTable(
  'email_codes',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: varchar('purpose', { length: 32 }).$type<EmailCodePurpose>().notNull(),
    /** HMAC-SHA256 of the code, never the code itself. */
    codeHash: varchar('code_hash', { length: 64 }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    /** When the code was sent; the resend cooldown counts from here. */
    sentAt: timestamp('sent_at', { withTimezone: true, mode: 'date' }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull()
  },
  (table) => [primaryKey({ columns: [table.userId, table.purpose] })]
)

export type EmailCodeRow = typeof emailCodes.$inferSelect
