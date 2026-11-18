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

/** Loaded by nest-typed-config from `SECTION__KEY` env vars; every section is injectable by class. */
export class AppConfig {
  server: ServerConfig
  database: DatabaseConfig
  jwt: JwtConfig
  auth: AuthConfig
  mailer: MailerConfig
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
  const { nodeEnv, server, database, jwt, auth, mailer } = parsed.data
  return Object.assign(new AppConfig(), {
    server: Object.assign(new ServerConfig(), { production: nodeEnv === 'production', ...server }),
    database: Object.assign(new DatabaseConfig(), database),
    jwt: Object.assign(new JwtConfig(), jwt),
    auth: Object.assign(new AuthConfig(), auth),
    mailer: Object.assign(new MailerConfig(), mailer)
  })
}
