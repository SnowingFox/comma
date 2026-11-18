import { sql } from 'drizzle-orm'
import { index, pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core'
import { users } from '../user/user.entity'

/** A user's dictionary: STT keyterms and names for the rewrite prompt. Unique per user, ignoring case. */
export const dictionaryTerms = pgTable(
  'dictionary_terms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    term: varchar('term', { length: 100 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex('dictionary_terms_user_term_idx').on(table.userId, sql`lower(${table.term})`),
    index('dictionary_terms_user_idx').on(table.userId, table.createdAt)
  ]
)

export type DictionaryTermRow = typeof dictionaryTerms.$inferSelect
