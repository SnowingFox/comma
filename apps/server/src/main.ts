import 'reflect-metadata'
import { ConsoleLogger, type INestApplication, VersioningType } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { ServerConfig } from './app.config'
import { AppModule } from './app.module'

/** Shared with the e2e tests so both run the same HTTP pipeline. */
export function configureApp(app: INestApplication): void {
  app.useSecurityHeaders()
  app.enableVersioning({ type: VersioningType.URI })
  app.enableShutdownHooks()
}

async function bootstrap(): Promise<void> {
  const production = process.env.NODE_ENV === 'production'
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: production ? new ConsoleLogger({ json: true, logLevels: ['log', 'warn', 'error', 'fatal'] }) : undefined
  })
  configureApp(app)
  const server = app.get(ServerConfig)
  app.set('trust proxy', server.trustProxy)
  await app.listen(server.port)
}

if (import.meta.main) {
  await bootstrap()
}
