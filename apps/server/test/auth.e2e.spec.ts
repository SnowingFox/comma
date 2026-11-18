import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { ApiError, RegisterResponse, TokenResponse } from '@comma/shared'
import { bearer, createTestApp, login, PASSWORD, signUp, type TestApp } from './test-app'

describe('auth', () => {
  let t: TestApp

  beforeAll(async () => {
    t = await createTestApp()
  })
  afterAll(async () => {
    await t.close()
  })

  test('register creates an unverified user and emails a 6-digit code', async () => {
    const response = await t
      .http()
      .post('/v1/auth/register')
      .send({ email: '  Ada@Example.com ', password: PASSWORD, name: 'Ada' })
      .expect(201)
    const body = RegisterResponse.parse(response.body)
    expect(body.user.email).toBe('ada@example.com')
    expect(body.user.email_verified).toBe(false)
    expect(body.user.plan).toBe('free')
    expect(t.outbox.lastCode('ada@example.com')).toMatch(/^\d{6}$/)
    const [row] = (await t.sql('select password_hash from users where id = $1', [body.user.id])).rows
    expect(row.password_hash).toStartWith('$argon2id$')
    const [code] = (await t.sql('select code_hash from email_codes where user_id = $1', [body.user.id])).rows
    expect(code.code_hash).not.toContain(t.outbox.lastCode('ada@example.com'))
  })

  test('register refuses a taken email and invalid input', async () => {
    const taken = await t.http().post('/v1/auth/register').send({ email: 'ADA@example.com', password: PASSWORD, name: 'Ada' }).expect(409)
    expect(ApiError.parse(taken.body).code).toBe('email_taken')
    const invalid = await t.http().post('/v1/auth/register').send({ email: 'not-an-email', password: 'short', name: '' }).expect(400)
    expect(ApiError.parse(invalid.body).code).toBe('validation_failed')
    expect(invalid.body.message).toContain('email')
    expect(invalid.body.message).toContain('password')
  })

  test('login needs a verified email, and the code verifies it', async () => {
    const unverified = await t.http().post('/v1/auth/login').send({ email: 'ada@example.com', password: PASSWORD }).expect(403)
    expect(unverified.body).toEqual({ code: 'email_not_verified', message: expect.any(String) })

    const code = t.outbox.lastCode('ada@example.com')
    const wrong = code === '000000' ? '111111' : '000000'
    const miss = await t.http().post('/v1/auth/verify-email').send({ email: 'ada@example.com', code: wrong }).expect(400)
    expect(miss.body.code).toBe('invalid_code')
    await t.http().post('/v1/auth/verify-email').send({ email: 'ada@example.com', code }).expect(200, { ok: true })
    // A retried request after success still succeeds.
    await t.http().post('/v1/auth/verify-email').send({ email: 'ada@example.com', code }).expect(200, { ok: true })

    const session = TokenResponse.parse((await t.http().post('/v1/auth/login').send({ email: 'ada@example.com', password: PASSWORD }).expect(200)).body)
    expect(session.expires_in).toBe(900)
    expect(session.user.email_verified).toBe(true)
    expect(Buffer.from(session.refresh_token, 'base64url')).toHaveLength(32)
    const claims = JSON.parse(Buffer.from(session.access_token.split('.')[1] ?? '', 'base64url').toString())
    expect(claims).toMatchObject({ sub: session.user.id, did: expect.any(String) })
    expect(claims.exp - claims.iat).toBe(900)
    await t.http().get('/v1/me').set(bearer(session.access_token)).expect(200)
  })

  test('wrong email and wrong password get the same answer', async () => {
    const wrongPassword = await t.http().post('/v1/auth/login').send({ email: 'ada@example.com', password: 'nope' }).expect(401)
    const unknownEmail = await t.http().post('/v1/auth/login').send({ email: 'nobody@example.com', password: 'nope' }).expect(401)
    expect(wrongPassword.body).toEqual(unknownEmail.body)
    expect(wrongPassword.body.code).toBe('invalid_credentials')
  })

  test('five wrong codes use up the code; a resent one works', async () => {
    const email = 'grace@example.com'
    await t.http().post('/v1/auth/register').send({ email, password: PASSWORD, name: 'Grace' }).expect(201)
    const code = t.outbox.lastCode(email)
    const wrong = code === '000000' ? '111111' : '000000'
    const codes: string[] = []
    for (let i = 0; i < 5; i++) {
      codes.push((await t.http().post('/v1/auth/verify-email').send({ email, code: wrong }).expect(400)).body.code)
    }
    expect(codes).toEqual(['invalid_code', 'invalid_code', 'invalid_code', 'invalid_code', 'too_many_attempts'])
    const locked = await t.http().post('/v1/auth/verify-email').send({ email, code }).expect(400)
    expect(locked.body.code).toBe('too_many_attempts')

    // Resend has a 60 s cooldown from the last send.
    const early = await t.http().post('/v1/auth/verify-email/resend').send({ email }).expect(429)
    expect(early.body.code).toBe('resend_cooldown')
    await t.sql(`update email_codes set sent_at = now() - interval '61 seconds'`)
    await t.http().post('/v1/auth/verify-email/resend').send({ email }).expect(200, { ok: true })
    const fresh = t.outbox.lastCode(email)
    await t.http().post('/v1/auth/verify-email').send({ email, code: fresh }).expect(200)
  })

  test('an expired code is refused', async () => {
    const email = 'linus@example.com'
    await t.http().post('/v1/auth/register').send({ email, password: PASSWORD, name: 'Linus' }).expect(201)
    await t.sql(`update email_codes set expires_at = now() - interval '1 second'`)
    const expired = await t.http().post('/v1/auth/verify-email').send({ email, code: t.outbox.lastCode(email) }).expect(400)
    expect(expired.body.code).toBe('code_expired')
  })

  test('resend does not reveal unknown or verified addresses', async () => {
    const before = t.outbox.sent.length
    await t.http().post('/v1/auth/verify-email/resend').send({ email: 'nobody@example.com' }).expect(200, { ok: true })
    await t.http().post('/v1/auth/verify-email/resend').send({ email: 'ada@example.com' }).expect(200, { ok: true })
    expect(t.outbox.sent.length).toBe(before)
    const unknown = await t.http().post('/v1/auth/verify-email').send({ email: 'nobody@example.com', code: '123456' }).expect(400)
    expect(unknown.body.code).toBe('invalid_code')
  })

  test('refresh rotates; replaying a spent token signs the device out', async () => {
    const session = await signUp(t, 'barbara@example.com')
    const rotated = TokenResponse.parse(
      (await t.http().post('/v1/auth/refresh').send({ refresh_token: session.refresh_token }).expect(200)).body
    )
    expect(rotated.refresh_token).not.toBe(session.refresh_token)
    expect(rotated.user.id).toBe(session.user.id)
    await t.http().get('/v1/me').set(bearer(rotated.access_token)).expect(200)

    const replay = await t.http().post('/v1/auth/refresh').send({ refresh_token: session.refresh_token }).expect(401)
    expect(replay.body.code).toBe('refresh_token_reused')
    // The whole device is gone: its newest refresh token and its access tokens too.
    const after = await t.http().post('/v1/auth/refresh').send({ refresh_token: rotated.refresh_token }).expect(401)
    expect(after.body.code).toBe('invalid_refresh_token')
    const me = await t.http().get('/v1/me').set(bearer(rotated.access_token)).expect(401)
    expect(me.body.code).toBe('invalid_token')
  })

  test('logout signs the device out; other devices stay signed in', async () => {
    const first = await login(t, 'barbara@example.com', 'Laptop')
    const second = await login(t, 'barbara@example.com', 'Desktop')
    await t.http().post('/v1/auth/logout').send({ refresh_token: first.refresh_token }).expect(200, { ok: true })
    await t.http().get('/v1/me').set(bearer(first.access_token)).expect(401)
    await t.http().post('/v1/auth/refresh').send({ refresh_token: first.refresh_token }).expect(401)
    await t.http().get('/v1/me').set(bearer(second.access_token)).expect(200)
    // Unknown tokens are accepted quietly.
    await t.http().post('/v1/auth/logout').send({ refresh_token: 'unknown' }).expect(200)
  })

  test('refresh refuses unknown and expired tokens', async () => {
    const unknown = await t.http().post('/v1/auth/refresh').send({ refresh_token: 'not-a-token' }).expect(401)
    expect(unknown.body.code).toBe('invalid_refresh_token')
    const session = await login(t, 'barbara@example.com')
    await t.sql(`update refresh_tokens set expires_at = now() - interval '1 second' where used_at is null`)
    const expired = await t.http().post('/v1/auth/refresh').send({ refresh_token: session.refresh_token }).expect(401)
    expect(expired.body.code).toBe('invalid_refresh_token')
  })

  test('protected routes need a valid bearer token', async () => {
    const none = await t.http().get('/v1/me').expect(401)
    expect(ApiError.parse(none.body).code).toBe('unauthorized')
    const garbage = await t.http().get('/v1/me').set(bearer('not-a-jwt')).expect(401)
    expect(garbage.body.code).toBe('invalid_token')
    await t.http().get('/v1/me').set({ authorization: 'Basic abc' }).expect(401)
  })
})
