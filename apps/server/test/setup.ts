// nest-typed-config reads the environment when app.module.ts is imported; each test app then
// overrides DatabaseConfig with its own database.
process.env.NODE_ENV = 'test'
process.env.TEST_DATABASE_URL ??= 'postgres://comma:comma@localhost:55432/comma'
process.env.DATABASE__URL = process.env.TEST_DATABASE_URL
process.env.JWT__SECRET = 'test-secret-that-is-at-least-32-characters-long'
process.env.MAILER__DRIVER = 'console'
