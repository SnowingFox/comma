import { z } from 'zod'

export const MAILER_DRIVERS = ['console', 'smtp'] as const
export type MailerDriver = (typeof MAILER_DRIVERS)[number]

export class ServerConfig {
  production: boolean
  port: number
  /** Express `trust proxy`, so rate limits see the client IP behind a load balancer. */
  trustProxy: string
}

export class DatabaseConfig {
  url: string
}

export class JwtConfig {
  /** HS256 key of the access tokens; also keys the email-code hashes. */
  secret: string
}

export class AuthConfig {
  refreshTtlDays: number
}

export class MailerConfig {
  driver: MailerDriver
  /** Lets the console mailer print codes; never in production. */
  devPrintCodes: boolean
  from: string
  smtpUrl?: string
}

export const LLM_PROVIDERS = ['openai-compatible', 'deepseek'] as const
export type LlmProvider = (typeof LLM_PROVIDERS)[number]

export const REASONING_EFFORTS = ['off', 'low', 'medium', 'high', 'default'] as const
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

/** Comma's own speech-to-text account. Voice runs answer 503 `provider_not_configured` without a key. */
export class ElevenLabsConfig {
  apiKey?: string
  baseUrl: string
  model: string
}

/**
 * Comma's own LLM for the rewrite. Voice runs need a key and a model, and a base URL for `openai-compatible`
 * (DeepSeek defaults to its official API).
 */
export class LlmConfig {
  provider: LlmProvider
  baseUrl?: string
  apiKey?: string
  model?: string
  /** `off` sends `reasoning_effort: "none"`, `default` omits the field. */
  reasoningEffort: ReasoningEffort
}

/** Weekly allowance of Comma credits per plan, in seconds of audio. */
export class QuotaConfig {
  freeWeeklySeconds: number
}

/** Loaded by nest-typed-config from `SECTION__KEY` env vars; every section is injectable by class. */
export class AppConfig {
  server: ServerConfig
  database: DatabaseConfig
  jwt: JwtConfig
  auth: AuthConfig
  mailer: MailerConfig
  elevenlabs: ElevenLabsConfig
  llm: LlmConfig
  quota: QuotaConfig
}

const flag = z
  .enum(['1', '0', 'true', 'false'])
  .optional()
  .transform((value) => value === '1' || value === 'true')

const optionalString = z
  .string()
  .optional()
  .transform((value) => (value === '' ? undefined : value))

const rawSchema = z
  .object({
    nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
    server: z
      .object({
        port: z.coerce.number().int().min(1).max(65_535).default(8787),
        trustProxy: z.string().min(1).default('loopback')
      })
      .prefault({}),
    database: z.object({ url: z.string().min(1) }),
    jwt: z.object({ secret: z.string().min(32, 'must be at least 32 characters') }),
    auth: z.object({ refreshTtlDays: z.coerce.number().int().min(1).max(365).default(30) }).prefault({}),
    mailer: z
      .object({
        driver: z.enum(MAILER_DRIVERS).default('console'),
        devPrintCodes: flag,
        from: z.string().min(3).default('Comma <no-reply@localhost>'),
        smtpUrl: optionalString.pipe(z.url({ protocol: /^smtps?$/ }).optional())
      })
      .prefault({}),
    elevenlabs: z
      .object({
        apiKey: optionalString,
        baseUrl: z.url({ protocol: /^https?$/ }).default('https://api.elevenlabs.io'),
        model: z.string().min(1).default('scribe_v3')
      })
      .prefault({}),
    llm: z
      .object({
        provider: z.enum(LLM_PROVIDERS).default('openai-compatible'),
        baseUrl: optionalString.pipe(z.url({ protocol: /^https?$/ }).optional()),
        apiKey: optionalString,
        model: optionalString,
        reasoningEffort: z.enum(REASONING_EFFORTS).default('off')
      })
      .prefault({}),
    quota: z
      .object({ freeWeeklySeconds: z.coerce.number().int().min(0).default(30 * 60) })
      .prefault({})
  })
  .superRefine((raw, ctx) => {
    const issue = (path: string[], message: string) => ctx.addIssue({ code: 'custom', path, message })
    if (raw.nodeEnv === 'production') {
      if (raw.mailer.driver !== 'smtp') issue(['mailer', 'driver'], 'must be smtp in production')
      if (raw.mailer.devPrintCodes) issue(['mailer', 'devPrintCodes'], 'not allowed in production')
    }
    if (raw.mailer.driver === 'smtp' && !raw.mailer.smtpUrl) {
      issue(['mailer', 'smtpUrl'], 'required with MAILER__DRIVER=smtp')
    }
  })

/** `MAILER__DEV_PRINT_CODES` -> `mailer__devPrintCodes`, which the loader nests as `mailer.devPrintCodes`. */
export function configKey(key: string): string {
  return key
    .split('__')
    .map((part) => part.toLowerCase().replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase()))
    .join('__')
}

/** nest-typed-config `validate` hook: zod parses the raw env, then the typed classes are built. */
export function validateConfig(raw: Record<string, unknown>): AppConfig {
  const parsed = rawSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`)
  }
  const { nodeEnv, server, database, jwt, auth, mailer, elevenlabs, llm, quota } = parsed.data
  return Object.assign(new AppConfig(), {
    server: Object.assign(new ServerConfig(), { production: nodeEnv === 'production', ...server }),
    database: Object.assign(new DatabaseConfig(), database),
    jwt: Object.assign(new JwtConfig(), jwt),
    auth: Object.assign(new AuthConfig(), auth),
    mailer: Object.assign(new MailerConfig(), mailer),
    elevenlabs: Object.assign(new ElevenLabsConfig(), elevenlabs),
    llm: Object.assign(new LlmConfig(), llm),
    quota: Object.assign(new QuotaConfig(), quota)
  })
}
