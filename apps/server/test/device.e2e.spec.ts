import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { DeviceListResponse } from '@comma/shared'
import { bearer, createTestApp, login, signUp, type TestApp } from './test-app'

describe('devices', () => {
  let t: TestApp

  beforeAll(async () => {
    t = await createTestApp()
  })
  afterAll(async () => {
    await t.close()
  })

  test('each login is a device; the list marks the current one', async () => {
    const laptop = await signUp(t, 'ada@example.com', 'Laptop')
    const desktop = await login(t, 'ada@example.com', 'Desktop')
    const list = DeviceListResponse.parse(
      (await t.http().get('/v1/devices').set(bearer(desktop.access_token)).expect(200)).body
    )
    expect(list.devices.map((d) => [d.name, d.platform, d.current])).toEqual([
      ['Desktop', 'macos', true],
      ['Laptop', 'macos', false]
    ])
    // A refresh moves the device's last_seen_at.
    await t.http().post('/v1/auth/refresh').send({ refresh_token: laptop.refresh_token }).expect(200)
    const after = DeviceListResponse.parse((await t.http().get('/v1/devices').set(bearer(desktop.access_token)).expect(200)).body)
    expect(after.devices[0]?.name).toBe('Laptop')
  })

  test('revoking a device signs it out at once', async () => {
    const phone = await login(t, 'ada@example.com', 'Other Mac')
    const main = await login(t, 'ada@example.com', 'Main Mac')
    const list = DeviceListResponse.parse((await t.http().get('/v1/devices').set(bearer(main.access_token)).expect(200)).body)
    const target = list.devices.find((d) => d.name === 'Other Mac')
    if (!target) throw new Error('device missing')
    await t.http().delete(`/v1/devices/${target.id}`).set(bearer(main.access_token)).expect(204)
    await t.http().get('/v1/me').set(bearer(phone.access_token)).expect(401)
    await t.http().post('/v1/auth/refresh').send({ refresh_token: phone.refresh_token }).expect(401)
    await t.http().delete(`/v1/devices/${target.id}`).set(bearer(main.access_token)).expect(404)
  })

  test("a user cannot see or revoke another user's devices", async () => {
    const ada = await login(t, 'ada@example.com', 'Ada Mac')
    const eve = await signUp(t, 'eve@example.com', 'Eve Mac')
    const eveList = DeviceListResponse.parse((await t.http().get('/v1/devices').set(bearer(eve.access_token)).expect(200)).body)
    expect(eveList.devices).toHaveLength(1)
    const adaList = DeviceListResponse.parse((await t.http().get('/v1/devices').set(bearer(ada.access_token)).expect(200)).body)
    const adaDevice = adaList.devices.find((d) => d.current)
    if (!adaDevice) throw new Error('device missing')
    const denied = await t.http().delete(`/v1/devices/${adaDevice.id}`).set(bearer(eve.access_token)).expect(404)
    expect(denied.body.code).toBe('not_found')
    await t.http().get('/v1/me').set(bearer(ada.access_token)).expect(200)
  })

  test('the device id must be a UUID', async () => {
    const session = await login(t, 'ada@example.com')
    const bad = await t.http().delete('/v1/devices/not-a-uuid').set(bearer(session.access_token)).expect(400)
    expect(bad.body.code).toBe('validation_failed')
  })
})
