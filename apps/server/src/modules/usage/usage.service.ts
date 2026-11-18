import { Inject, Injectable } from '@nestjs/common'
import { InjectDrizzle } from '@nestjs/drizzle'
import {
  type CreditsResponse,
  type Plan,
  type UsageDailyResponse,
  type UsageRange,
  type UsageSummaryResponse,
  type UsageTotals,
  VoiceMode
} from '@comma/shared'
import { and, eq, gte, lt, sql } from 'drizzle-orm'
import { QuotaConfig } from '@/app.config'
import { voiceRuns } from '@/entity'
import type { Database } from '@/utils/database'

const DAY_MS = 86_400_000

/** The credit period containing `now`: the ISO week in UTC, Monday 00:00 to the next Monday. */
export function creditPeriod(now: Date): { start: Date; end: Date } {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const sinceMonday = (now.getUTCDay() + 6) % 7
  const start = new Date(midnight - sinceMonday * DAY_MS)
  return { start, end: new Date(start.getTime() + 7 * DAY_MS) }
}

/** UTC days: `today`, or the last 7 / 30 days including today. */
export function rangeBounds(range: UsageRange, now: Date): { from: Date; to: Date; days: number } {
  const days = range === 'today' ? 1 : range === '7d' ? 7 : 30
  const tomorrow = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + DAY_MS
  return { from: new Date(tomorrow - days * DAY_MS), to: new Date(tomorrow), days }
}

const totalsColumns = {
  runs: sql<number>`count(*)::int`,
  audioSeconds: sql<number>`coalesce(sum(${voiceRuns.audioSeconds}), 0)::float8`,
  promptTokens: sql<number>`coalesce(sum(${voiceRuns.promptTokens}), 0)::int`,
  completionTokens: sql<number>`coalesce(sum(${voiceRuns.completionTokens}), 0)::int`,
  sttCostUsd: sql<number>`coalesce(sum(${voiceRuns.sttCostUsd}), 0)::float8`
}

type TotalsRow = { runs: number; audioSeconds: number; promptTokens: number; completionTokens: number; sttCostUsd: number }

function totals(row: TotalsRow | undefined): UsageTotals {
  return {
    runs: row?.runs ?? 0,
    audio_seconds: Math.round((row?.audioSeconds ?? 0) * 100) / 100,
    prompt_tokens: row?.promptTokens ?? 0,
    completion_tokens: row?.completionTokens ?? 0,
    stt_cost_usd: Math.round((row?.sttCostUsd ?? 0) * 1e6) / 1e6
  }
}

/** Metering of voice runs on Comma's credits. Only `ok` runs count. */
@Injectable()
export class UsageService {
  @InjectDrizzle()
  private readonly db: Database

  @Inject()
  private readonly quota: QuotaConfig

  limitSeconds(_plan: Plan): number {
    return this.quota.freeWeeklySeconds
  }

  /** Billed audio seconds since `from`; `db` lets the voice lock read inside its transaction. */
  async usedSeconds(userId: string, from: Date, db: Pick<Database, 'select'> = this.db): Promise<number> {
    const [row] = await db
      .select({ value: sql<number>`coalesce(sum(${voiceRuns.audioSeconds}), 0)::float8` })
      .from(voiceRuns)
      .where(and(eq(voiceRuns.userId, userId), eq(voiceRuns.status, 'ok'), gte(voiceRuns.createdAt, from)))
    return row?.value ?? 0
  }

  async credits(userId: string, plan: Plan, now = new Date()): Promise<CreditsResponse> {
    const period = creditPeriod(now)
    return {
      plan,
      period_start: period.start.toISOString(),
      period_end: period.end.toISOString(),
      used_seconds: Math.round((await this.usedSeconds(userId, period.start)) * 100) / 100,
      limit_seconds: this.limitSeconds(plan)
    }
  }

  async summary(userId: string, range: UsageRange, now = new Date()): Promise<UsageSummaryResponse> {
    const { from, to } = rangeBounds(range, now)
    const rows = await this.db
      .select({ mode: voiceRuns.mode, ...totalsColumns })
      .from(voiceRuns)
      .where(this.okBetween(userId, from, to))
      .groupBy(voiceRuns.mode)
    const byMode = Object.fromEntries(
      VoiceMode.options.map((mode) => [mode, totals(rows.find((row) => row.mode === mode))])
    ) as UsageSummaryResponse['by_mode']
    // Summed before rounding, so the totals match the credits.
    const all = totals(
      rows.reduce<TotalsRow>(
        (sum, row) => ({
          runs: sum.runs + row.runs,
          audioSeconds: sum.audioSeconds + row.audioSeconds,
          promptTokens: sum.promptTokens + row.promptTokens,
          completionTokens: sum.completionTokens + row.completionTokens,
          sttCostUsd: sum.sttCostUsd + row.sttCostUsd
        }),
        { runs: 0, audioSeconds: 0, promptTokens: 0, completionTokens: 0, sttCostUsd: 0 }
      )
    )
    return { range, from: from.toISOString(), to: to.toISOString(), totals: all, by_mode: byMode }
  }

  async daily(userId: string, range: UsageRange, now = new Date()): Promise<UsageDailyResponse> {
    const { from, to, days } = rangeBounds(range, now)
    const day = sql<string>`to_char(${voiceRuns.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`
    const rows = await this.db
      .select({ day, ...totalsColumns })
      .from(voiceRuns)
      .where(this.okBetween(userId, from, to))
      .groupBy(day)
    return {
      range,
      days: Array.from({ length: days }, (_, index) => {
        const date = new Date(from.getTime() + index * DAY_MS).toISOString().slice(0, 10)
        return { date, ...totals(rows.find((row) => row.day === date)) }
      })
    }
  }

  private okBetween(userId: string, from: Date, to: Date) {
    return and(eq(voiceRuns.userId, userId), eq(voiceRuns.status, 'ok'), gte(voiceRuns.createdAt, from), lt(voiceRuns.createdAt, to))
  }
}
