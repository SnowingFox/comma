import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { AUTH_THROTTLE } from '@/modules/auth/auth.controller'
import { createTestApp, type TestApp } from './test-app'

describe('auth rate limits', () => {
  let t: TestApp

  beforeAll(async () => {
    t = await createTestApp({ throttle: true })
  })
  afterAll(async () => {
    await t.close()
  })

  test('login is limited per client per minute', async () => {
    const attempt = () => t.http().post('/v1/auth/login').send({ email: 'ada@example.com', password: 'guess' })
    for (let i = 0; i < AUTH_THROTTLE.login; i++) {
      await attempt().expect(401)
    }
    const limited = await attempt().expect(429)
    expect(limited.body.code).toBe('rate_limited')
  })

  test('verify-email is limited too', async () => {
    const attempt = () => t.http().post('/v1/auth/verify-email').send({ email: 'ada@example.com', code: '123456' })
    for (let i = 0; i < AUTH_THROTTLE.verify; i++) {
      await attempt().expect(400)
    }
    await attempt().expect(429)
  })
})
