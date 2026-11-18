import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { HealthResponse } from '@comma/shared'
import { createTestApp, type TestApp } from './test-app'

describe('health', () => {
  let t: TestApp

  beforeAll(async () => {
    t = await createTestApp()
  })
  afterAll(async () => {
    await t.close()
  })

  test('GET /v1/health is public and checks the database', async () => {
    const response = await t.http().get('/v1/health').expect(200)
    expect(HealthResponse.parse(response.body).details.database?.status).toBe('up')
  })

  test('unknown routes answer with the error shape', async () => {
    const response = await t.http().get('/v1/nope').expect(404)
    expect(response.body).toEqual({ code: 'not_found', message: expect.any(String) })
  })
})
