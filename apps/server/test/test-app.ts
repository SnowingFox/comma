import 'reflect-metadata'
import { randomBytes } from 'node:crypto'
import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { ThrottlerStorage } from '@nestjs/throttler'
import type { TokenResponse } from '@comma/shared'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Client, Pool } from 'pg'
import request from 'supertest'
import { dotenvLoader } from 'nest-typed-config'
import { configKey, DatabaseConfig, ElevenLabsConfig, LlmConfig, QuotaConfig, validateConfig } from '@/app.config'
import { AppModule } from '@/app.module'
import { configureApp } from '@/main'
import { Mailer } from '@/modules/auth/mailer'

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? 'postgres://comma:comma@localhost:55432/comma'

/** A fresh, migrated database per test file, dropped by the returned cleanup. */
export async function createTestDatabase(): Promise<{ url: string; query: Pool['query']; drop: () => Promise<void> }> {
  const name = `comma_test_${randomBytes(6).toString('hex')}`
  const admin = new Client({ connectionString: ADMIN_URL })
  await admin.connect()
  await admin.query(`create database ${name}`)
  await admin.end()
  const url = new URL(ADMIN_URL)
  url.pathname = `/${name}`
  const pool = new Pool({ connectionString: url.toString() })
  await migrate(drizzle(pool), { migrationsFolder: `${import.meta.dir}/../drizzle` })
  return {
    url: url.toString(),
    query: pool.query.bind(pool) as Pool['query'],
    drop: async () => {
      await pool.end()
      const cleanup = new Client({ connectionString: ADMIN_URL })
      await cleanup.connect()
      await cleanup.query(`drop database if exists ${name} with (force)`)
      await cleanup.end()
    }
  }
}

/** Stands in for the mailer and keeps every code it was asked to send. */
export class Outbox extends Mailer {
  readonly sent: { to: string; name: string; code: string }[] = []

  async sendVerificationCode(message: { to: string; name: string; code: string }): Promise<void> {
    this.sent.push(message)
  }

  lastCode(to: string): string {
    const message = this.sent.findLast((item) => item.to === to)
    if (!message) {
      throw new Error(`no code was sent to ${to}`)
    }
    return message.code
  }
}

export type TestApp = {
  app: INestApplication
  outbox: Outbox
  /** Direct SQL on the test database, for setting up states the API cannot reach (expired codes). */
  sql: Pool['query']
  http: () => ReturnType<typeof request>
  close: () => Promise<void>
}

/** Counts nothing, so suites can exceed the per-minute auth limits; `throttle: true` keeps the real one. */
const unlimited = {
  increment: async () => ({ totalHits: 1, timeToExpire: 60, isBlocked: false, timeToBlockExpire: 0 })
}

export type TestAppOptions = {
  throttle?: boolean
  elevenlabs?: Partial<ElevenLabsConfig>
  llm?: Partial<LlmConfig>
  quota?: Partial<QuotaConfig>
}

export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const database = await createTestDatabase()
  const outbox = new Outbox()
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DatabaseConfig)
    .useValue(Object.assign(new DatabaseConfig(), { url: database.url }))
    .overrideProvider(Mailer)
    .useValue(outbox)
  // Fresh copies of the test environment's config (setup.ts; the .env file is ignored) with this app's patches.
  const loaded = validateConfig(dotenvLoader({ separator: '__', keyTransformer: configKey, ignoreEnvFile: true })())
  builder = builder
    .overrideProvider(ElevenLabsConfig)
    .useValue(Object.assign(new ElevenLabsConfig(), loaded.elevenlabs, options.elevenlabs))
    .overrideProvider(LlmConfig)
    .useValue(Object.assign(new LlmConfig(), loaded.llm, options.llm))
    .overrideProvider(QuotaConfig)
    .useValue(Object.assign(new QuotaConfig(), loaded.quota, options.quota))
  if (!options.throttle) {
    builder = builder.overrideProvider(ThrottlerStorage).useValue(unlimited)
  }
  const moduleRef = await builder.compile()
  const app = moduleRef.createNestApplication({ logger: ['error', 'warn'] })
  configureApp(app)
  await app.init()
  return {
    app,
    outbox,
    sql: database.query,
    http: () => request(app.getHttpServer()),
    close: async () => {
      await app.close()
      await database.drop()
    }
  }
}

export const PASSWORD = 'correct horse battery staple'

/** Register, verify with the emailed code, and log in: a ready session. */
export async function signUp(t: TestApp, email: string, deviceName = 'Test Mac'): Promise<TokenResponse> {
  await t.http().post('/v1/auth/register').send({ email, password: PASSWORD, name: 'Test User' }).expect(201)
  await t.http().post('/v1/auth/verify-email').send({ email, code: t.outbox.lastCode(email) }).expect(200)
  return await login(t, email, deviceName)
}

export async function login(t: TestApp, email: string, deviceName = 'Test Mac'): Promise<TokenResponse> {
  const response = await t
    .http()
    .post('/v1/auth/login')
    .send({ email, password: PASSWORD, device_name: deviceName, platform: 'macos' })
    .expect(200)
  return response.body
}

export function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` }
}
