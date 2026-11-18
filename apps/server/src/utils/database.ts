import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '@/entity'

/** The `@InjectDrizzle()` instance, typed with our schema. */
export type Database = NodePgDatabase<typeof schema>
