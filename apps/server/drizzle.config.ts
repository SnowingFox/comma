import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/entity/index.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE__URL ?? 'postgres://comma:comma@localhost:55432/comma' }
})
