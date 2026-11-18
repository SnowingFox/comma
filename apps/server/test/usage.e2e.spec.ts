import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { CreditsResponse, UsageDailyResponse, UsageSummaryResponse } from '@comma/shared'
import { bearer, createTestApp, signUp, type TestApp } from './test-app'

describe('usage and credits', () => {
  let t: TestApp

  beforeAll(async () => {
    t = await createTestApp({ quota: { freeWeeklySeconds: 900 } })
  })
  afterAll(async () => {
    await t.close()
  })

  test('summary and daily count only successful runs in the range', async () => {
    const session = await signUp(t, 'usage@example.com')
    const auth = bearer(session.access_token)
    const insert = (mode: string, status: string, seconds: number, daysAgo: number) =>
      t.sql(
        `insert into voice_runs (user_id, mode, status, audio_seconds, prompt_tokens, completion_tokens, stt_cost_usd, created_at)
         values ($1, $2, $3, $4, 100, 10, 0.001, now() - make_interval(days => $5))`,
        [session.user.id, mode, status, seconds, daysAgo]
      )
    await insert('dictate', 'ok', 10, 0)
    await insert('ask', 'ok', 5, 0)
    await insert('dictate', 'error', 7, 0)
    await insert('translate', 'ok', 20, 3)
    await insert('dictate', 'ok', 30, 40)

    const today = UsageSummaryResponse.parse((await t.http().get('/v1/usage/summary?range=today').set(auth).expect(200)).body)
    expect(today.totals).toEqual({ runs: 2, audio_seconds: 15, prompt_tokens: 200, completion_tokens: 20, stt_cost_usd: 0.002 })
    expect(today.by_mode.translate.runs).toBe(0)

    const week = UsageSummaryResponse.parse((await t.http().get('/v1/usage/summary').set(auth).expect(200)).body)
    expect(week.range).toBe('7d')
    expect(week.totals.runs).toBe(3)
    expect(week.by_mode.translate.audio_seconds).toBe(20)

    const daily = UsageDailyResponse.parse((await t.http().get('/v1/usage/daily?range=30d').set(auth).expect(200)).body)
    expect(daily.days).toHaveLength(30)
    expect(daily.days.at(-1)).toMatchObject({ date: new Date().toISOString().slice(0, 10), runs: 2, audio_seconds: 15 })
    expect(daily.days.reduce((sum, day) => sum + day.runs, 0)).toBe(3)

    await t.http().get('/v1/usage/summary?range=1y').set(auth).expect(400)
    await t.http().get('/v1/usage/summary').expect(401)
  })

  test('credits report the ISO week and the configured allowance', async () => {
    const session = await signUp(t, 'credits@example.com')
    const credits = CreditsResponse.parse((await t.http().get('/v1/me/credits').set(bearer(session.access_token)).expect(200)).body)
    expect(credits).toMatchObject({ plan: 'free', used_seconds: 0, limit_seconds: 900 })
    const start = new Date(credits.period_start)
    expect(start.getUTCDay()).toBe(1)
    expect(new Date(credits.period_end).getTime() - start.getTime()).toBe(7 * 86_400_000)
  })

  test('provider_mode is a synced setting, own by default', async () => {
    const session = await signUp(t, 'mode@example.com')
    const auth = bearer(session.access_token)
    expect(session.user.settings.provider_mode).toBe('own')
    const patched = await t.http().patch('/v1/me').set(auth).send({ settings: { provider_mode: 'comma' } }).expect(200)
    expect(patched.body.user.settings.provider_mode).toBe('comma')
    await t.http().patch('/v1/me').set(auth).send({ settings: { provider_mode: 'other' } }).expect(400)
  })
})
