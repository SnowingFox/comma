import { Controller, Get, Inject, Query } from '@nestjs/common'
import { type CreditsResponse, type UsageDailyResponse, UsageQuery, type UsageSummaryResponse } from '@comma/shared'
import type { AuthUser } from '@/app'
import { User } from '@/decorator/user.decorator'
import { UserService } from '@/modules/user/user.service'
import { UsageService } from './usage.service'

@Controller({ path: '/usage', version: '1' })
export class UsageController {
  @Inject()
  private readonly usage: UsageService

  @Get('/summary')
  summary(@User() caller: AuthUser, @Query({ schema: UsageQuery }) query: UsageQuery): Promise<UsageSummaryResponse> {
    return this.usage.summary(caller.userId, query.range)
  }

  @Get('/daily')
  daily(@User() caller: AuthUser, @Query({ schema: UsageQuery }) query: UsageQuery): Promise<UsageDailyResponse> {
    return this.usage.daily(caller.userId, query.range)
  }
}

/** `GET /v1/me/credits`: lives here with the metering it reports. */
@Controller({ path: '/me/credits', version: '1' })
export class CreditsController {
  @Inject()
  private readonly usage: UsageService

  @Inject()
  private readonly users: UserService

  @Get()
  async credits(@User() caller: AuthUser): Promise<CreditsResponse> {
    const user = await this.users.getUser(caller.userId)
    return this.usage.credits(user.id, user.plan)
  }
}
