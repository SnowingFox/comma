import type { Plan, UserSettings } from '@comma/shared'
import { jsonb, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core'

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Always stored trimmed and lowercased. */
  email: varchar('email', { length: 320 }).notNull().unique(),
  /** Argon2id PHC string from `Bun.password`. */
  passwordHash: text('password_hash').notNull(),
  name: varchar('name', { length: 100 }).notNull(),
  /** Null until the email code is confirmed; login requires it. */
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true, mode: 'date' }),
  plan: varchar('plan', { length: 32 }).$type<Plan>().notNull().default('free'),
  /** Partial: missing keys fall back to `DEFAULT_USER_SETTINGS`. */
  settings: jsonb('settings').$type<Partial<UserSettings>>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow()
})

export type UserRow = typeof users.$inferSelect
