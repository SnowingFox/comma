import { Inject, Injectable } from '@nestjs/common'
import { InjectDrizzle } from '@nestjs/drizzle'
import { HealthIndicatorService } from '@nestjs/terminus'
import { sql } from 'drizzle-orm'
import type { Database } from '@/utils/database'

/** Terminus ships no Drizzle indicator; a `select 1` on the pool is the check. */
@Injectable()
export class DrizzleHealthIndicator {
  @Inject()
  private readonly health: HealthIndicatorService

  @InjectDrizzle()
  private readonly db: Database

  check(key: string) {
    return this.health
      .check(key)
      .attempt(async () => {
        await this.db.execute(sql`select 1`)
      })
      .withTimeout(3000)
  }
}
