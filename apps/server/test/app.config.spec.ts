import { describe, expect, test } from 'bun:test'
import { configKey, validateConfig } from '@/app.config'

const base = {
  database: { url: 'postgres://localhost/comma' },
  jwt: { secret: 'x'.repeat(32) }
}

describe('config', () => {
  test('env names map to nested camelCase keys', () => {
    expect(configKey('MAILER__DEV_PRINT_CODES')).toBe('mailer__devPrintCodes')
    expect(configKey('AUTH__REFRESH_TTL_DAYS')).toBe('auth__refreshTtlDays')
  })

  test('defaults fill in everything but the database and the JWT secret', () => {
    const config = validateConfig(base)
    expect(config.server).toMatchObject({ production: false, port: 8787 })
    expect(config.auth.refreshTtlDays).toBe(30)
    expect(config.mailer).toMatchObject({ driver: 'console', devPrintCodes: false })
    expect(() => validateConfig({ database: base.database })).toThrow(/jwt/)
    expect(() => validateConfig({ ...base, jwt: { secret: 'short' } })).toThrow(/at least 32/)
  })

  test('production requires SMTP and refuses printed codes', () => {
    expect(() => validateConfig({ ...base, nodeEnv: 'production' })).toThrow(/must be smtp in production/)
    expect(() =>
      validateConfig({
        ...base,
        nodeEnv: 'production',
        mailer: { driver: 'smtp', smtpUrl: 'smtp://mail.example.com:587', devPrintCodes: '1' }
      })
    ).toThrow(/not allowed in production/)
    const config = validateConfig({
      ...base,
      nodeEnv: 'production',
      mailer: { driver: 'smtp', smtpUrl: 'smtps://user:pass@mail.example.com:465' }
    })
    expect(config.server.production).toBe(true)
    expect(() => validateConfig({ ...base, mailer: { driver: 'smtp' } })).toThrow(/MAILER__DRIVER=smtp/)
    expect(() => validateConfig({ ...base, mailer: { driver: 'smtp', smtpUrl: 'https://x' } })).toThrow()
  })
})
