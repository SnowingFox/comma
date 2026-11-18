import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { MeResponse } from '@comma/shared'
import { bearer, createTestApp, PASSWORD, signUp, type TestApp } from './test-app'

describe('user', () => {
  let t: TestApp

  beforeAll(async () => {
    t = await createTestApp()
  })
  afterAll(async () => {
    await t.close()
  })

  test('GET /v1/me returns the profile with default settings', async () => {
    const session = await signUp(t, 'ada@example.com')
    const me = MeResponse.parse((await t.http().get('/v1/me').set(bearer(session.access_token)).expect(200)).body)
    expect(me.user).toEqual({ ...session.user })
    expect(me.user.settings).toEqual({ languages: [], translate_targets: [], context_level: 'app_and_selection' })
  })

  test('PATCH /v1/me updates the name and merges settings', async () => {
    const session = await signUp(t, 'grace@example.com')
    const auth = bearer(session.access_token)
    await t.http().patch('/v1/me').set(auth).send({ settings: { languages: ['en', 'zh-Hans'] } }).expect(200)
    const patched = await t
      .http()
      .patch('/v1/me')
      .set(auth)
      .send({ name: '  Grace H. ', settings: { translate_targets: ['fr'], context_level: 'off' } })
      .expect(200)
    expect(MeResponse.parse(patched.body).user).toMatchObject({
      name: 'Grace H.',
      settings: { languages: ['en', 'zh-Hans'], translate_targets: ['fr'], context_level: 'off' }
    })
    expect((await t.http().get('/v1/me').set(auth).expect(200)).body.user.name).toBe('Grace H.')
  })

  test('PATCH /v1/me refuses empty and invalid patches', async () => {
    const session = await signUp(t, 'linus@example.com')
    const auth = bearer(session.access_token)
    const empty = await t.http().patch('/v1/me').set(auth).send({}).expect(400)
    expect(empty.body.code).toBe('validation_failed')
    await t.http().patch('/v1/me').set(auth).send({ settings: { translate_targets: ['en', 'fr', 'de', 'es'] } }).expect(400)
    await t.http().patch('/v1/me').set(auth).send({ settings: { languages: ['not a tag'] } }).expect(400)
    await t.http().patch('/v1/me').set(auth).send({ email: 'other@example.com' }).expect(400)
  })

  test('DELETE /v1/me needs the password, then removes the user and everything under it', async () => {
    const session = await signUp(t, 'barbara@example.com')
    const auth = bearer(session.access_token)
    const wrong = await t.http().delete('/v1/me').set(auth).send({ password: 'wrong' }).expect(403)
    expect(wrong.body.code).toBe('invalid_credentials')
    await t.http().delete('/v1/me').set(auth).send({ password: PASSWORD }).expect(204)

    await t.http().get('/v1/me').set(auth).expect(401)
    await t.http().post('/v1/auth/refresh').send({ refresh_token: session.refresh_token }).expect(401)
    await t.http().post('/v1/auth/login').send({ email: 'barbara@example.com', password: PASSWORD }).expect(401)
    const count = async (table: string) =>
      Number((await t.sql(`select count(*) from ${table} t join users u on u.id = t.user_id where u.id = $1`, [session.user.id])).rows[0].count)
    expect(await count('devices')).toBe(0)
    const tokens = await t.sql('select count(*) from refresh_tokens r join devices d on d.id = r.device_id where d.user_id = $1', [session.user.id])
    expect(Number(tokens.rows[0].count)).toBe(0)
    expect(Number((await t.sql('select count(*) from users where id = $1', [session.user.id])).rows[0].count)).toBe(0)
    // The address is free again.
    await t.http().post('/v1/auth/register').send({ email: 'barbara@example.com', password: PASSWORD, name: 'Barbara' }).expect(201)
  })
})
