import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'

// Release step: apply drizzle/ migrations once, before the server starts.
const url = process.env.DATABASE__URL
if (!url) {
  throw new Error('DATABASE__URL is required')
}
const pool = new Pool({ connectionString: url })
await migrate(drizzle(pool), { migrationsFolder: `${import.meta.dir}/../drizzle` })
await pool.end()
console.log('migrations applied')
