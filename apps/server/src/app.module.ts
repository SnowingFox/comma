import { Logger, Module, StandardSchemaValidationPipe } from '@nestjs/common'
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core'
import { AuthenticationModule } from '@nestjs/authentication'
import { DrizzleModule } from '@nestjs/drizzle'
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler'
import { drizzle } from 'drizzle-orm/node-postgres'
import { dotenvLoader, TypedConfigModule } from 'nest-typed-config'
import { AppConfig, configKey, DatabaseConfig, validateConfig } from './app.config'
import * as schema from './entity'
import { ApiErrorFilter, validationException } from './filter/api-error.filter'
import { AuthModule } from './modules/auth/auth.module'
import { DeviceModule } from './modules/device/device.module'
import { DictionaryModule } from './modules/dictionary/dictionary.module'
import { HealthModule } from './modules/health/health.module'
import { UsageModule } from './modules/usage/usage.module'
import { UserModule } from './modules/user/user.module'
import { VoiceModule } from './modules/voice/voice.module'

@Module({
  imports: [
    TypedConfigModule.forRoot({
      schema: AppConfig,
      load: dotenvLoader({ separator: '__', keyTransformer: configKey }),
      validate: validateConfig
    }),
    DrizzleModule.forRootAsync({
      inject: [DatabaseConfig],
      useFactory: (database: DatabaseConfig) => ({
        drizzle,
        connection: { connectionString: database.url, max: 10 },
        schema
      })
    }),
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 120 }]),
    // Only the global guard and `@Public()`: our own provider verifies access tokens, and
    // refresh tokens live on device rows (see AuthModule), so the library issues nothing.
    AuthenticationModule.forRoot({ refreshToken: false }),
    AuthModule,
    UserModule,
    DeviceModule,
    DictionaryModule,
    UsageModule,
    VoiceModule,
    HealthModule
  ],
  providers: [
    Logger,
    // Registered here so rate limiting runs before the authentication guard.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_PIPE, useValue: new StandardSchemaValidationPipe({ exceptionFactory: validationException }) },
    { provide: APP_FILTER, useClass: ApiErrorFilter }
  ]
})
export class AppModule {}
