import { Controller, Get, Inject } from '@nestjs/common'
import { Public } from '@nestjs/authentication'
import { HealthCheck, HealthCheckService } from '@nestjs/terminus'
import { SkipThrottle } from '@nestjs/throttler'
import { DrizzleHealthIndicator } from './drizzle.health'

@Controller({ path: '/health', version: '1' })
@Public()
@SkipThrottle()
export class HealthController {
  @Inject()
  private readonly health: HealthCheckService

  @Inject()
  private readonly database: DrizzleHealthIndicator

  @Get()
  @HealthCheck()
  check() {
    return this.health.check([() => this.database.check('database')])
  }
}
