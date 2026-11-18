import { z } from 'zod'
import { Plan } from './user'
import { VoiceMode } from './voice'

/** Calendar days in UTC: `today`, or the last 7 / 30 days including today. */
export const UsageRange = z.enum(['today', '7d', '30d'])
export type UsageRange = z.infer<typeof UsageRange>

/** Query of `GET /v1/usage/summary` and `GET /v1/usage/daily`. */
export const UsageQuery = z.object({ range: UsageRange.default('7d') })
export type UsageQuery = z.infer<typeof UsageQuery>

/** Totals over successful runs. */
export const UsageTotals = z.object({
  runs: z.number().int().nonnegative(),
  audio_seconds: z.number().nonnegative(),
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  stt_cost_usd: z.number().nonnegative()
})
export type UsageTotals = z.infer<typeof UsageTotals>

/** `GET /v1/usage/summary?range=`. */
export const UsageSummaryResponse = z.object({
  range: UsageRange,
  /** ISO 8601, inclusive. */
  from: z.iso.datetime(),
  /** ISO 8601, exclusive. */
  to: z.iso.datetime(),
  totals: UsageTotals,
  by_mode: z.record(VoiceMode, UsageTotals)
})
export type UsageSummaryResponse = z.infer<typeof UsageSummaryResponse>

/** `GET /v1/usage/daily?range=`: one entry per UTC day in the range, oldest first, days without runs included. */
export const UsageDailyResponse = z.object({
  range: UsageRange,
  days: z.array(UsageTotals.extend({ date: z.iso.date() }))
})
export type UsageDailyResponse = z.infer<typeof UsageDailyResponse>

/**
 * `GET /v1/me/credits`: Comma's own provider credits this week. The period is the ISO week in UTC (Monday 00:00 to
 * the next Monday); runs are refused with 402 `quota_exceeded` when their audio would go past `limit_seconds`.
 */
export const CreditsResponse = z.object({
  plan: Plan,
  period_start: z.iso.datetime(),
  period_end: z.iso.datetime(),
  used_seconds: z.number().nonnegative(),
  limit_seconds: z.number().nonnegative()
})
export type CreditsResponse = z.infer<typeof CreditsResponse>
