// nest-typed-config reads the environment when app.module.ts is imported; each test app then
// overrides DatabaseConfig with its own database.
process.env.NODE_ENV = 'test'
process.env.TEST_DATABASE_URL ??= 'postgres://comma:comma@localhost:55432/comma'
process.env.DATABASE__URL = process.env.TEST_DATABASE_URL
process.env.JWT__SECRET = 'test-secret-that-is-at-least-32-characters-long'
process.env.MAILER__DRIVER = 'console'
// Set here so the real keys in apps/server/.env can never reach a test (process.env wins over the file).
// Voice tests point the base URLs at a local fake provider (test/fake-providers.ts).
process.env.ELEVENLABS__API_KEY = 'test-elevenlabs-key'
process.env.ELEVENLABS__BASE_URL = 'http://127.0.0.1:9'
process.env.LLM__PROVIDER = 'openai-compatible'
process.env.LLM__BASE_URL = 'http://127.0.0.1:9/v1'
process.env.LLM__API_KEY = 'test-llm-key'
process.env.LLM__MODEL = 'test-model'
process.env.LLM__REASONING_EFFORT = 'off'
process.env.QUOTA__FREE_WEEKLY_SECONDS = '1800'
