import { HttpStatus, Inject, Injectable } from '@nestjs/common'
import { InjectDrizzle } from '@nestjs/drizzle'
import type { Plan, VoiceMode } from '@comma/shared'
import { and, eq, lt } from 'drizzle-orm'
import { type VoiceRunRow, voiceRuns } from '@/entity'
import { ApiException } from '@/filter/api-error.filter'
import { creditPeriod, UsageService } from '@/modules/usage/usage.service'
import type { Database } from '@/utils/database'

/** A `running` row older than this is from a crashed process and no longer holds the lock. */
export const STALE_RUN_MS = 10 * 60_000

/** Seconds of headroom for float sums, so a run that lands exactly on the limit is allowed. */
const EPSILON = 1e-6

function isUniqueViolation(error: unknown): boolean {
  const err = error as { code?: string; cause?: { code?: string } }
  return (err?.code ?? err?.cause?.code) === '23505'
}

export type RunMetrics = Partial<
  Pick<
    VoiceRunRow,
    | 'delivery'
    | 'detectedLanguage'
    | 'sttRetried'
    | 'sttMs'
    | 'llmTtftMs'
    | 'llmTotalMs'
    | 'totalMs'
    | 'promptTokens'
    | 'completionTokens'
    | 'sttCostUsd'
  >
>

/** The `voice_runs` rows: the one-run-per-user lock, the quota check, and the metrics of each run. */
@Injectable()
export class VoiceRunStore {
  @InjectDrizzle()
  private readonly db: Database

  @Inject()
  private readonly usage: UsageService

  /**
   * Takes the user's run lock and checks the weekly credits in one transaction: 429 `run_in_progress` when another
   * run is active, 402 `quota_exceeded` (lock released) when this run's audio would go past the limit.
   */
  async begin(input: { userId: string; deviceId: string; plan: Plan; mode: VoiceMode; audioSeconds: number }): Promise<string> {
    const now = new Date()
    const period = creditPeriod(now)
    const limit = this.usage.limitSeconds(input.plan)
    await this.db
      .update(voiceRuns)
      .set({ status: 'error', errorCode: 'internal_error', finishedAt: now })
      .where(
        and(
          eq(voiceRuns.userId, input.userId),
          eq(voiceRuns.status, 'running'),
          lt(voiceRuns.createdAt, new Date(now.getTime() - STALE_RUN_MS))
        )
      )
    try {
      return await this.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(voiceRuns)
          .values({ userId: input.userId, deviceId: input.deviceId, mode: input.mode, audioSeconds: input.audioSeconds })
          .returning({ id: voiceRuns.id })
        const used = await this.usage.usedSeconds(input.userId, period.start, tx)
        if (used + input.audioSeconds > limit + EPSILON) {
          throw new ApiException(
            HttpStatus.PAYMENT_REQUIRED,
            'quota_exceeded',
            `This run needs ${Math.ceil(input.audioSeconds)} s of audio and ${Math.max(0, Math.floor(limit - used))} s of this week's Comma credits are left`,
            { resets_at: period.end.toISOString() }
          )
        }
        return row!.id
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiException(HttpStatus.TOO_MANY_REQUESTS, 'run_in_progress', 'Another voice run is still in progress')
      }
      throw error
    }
  }

  /** Releases the lock. `ok` runs count against the credits. */
  async finish(id: string, status: 'ok' | 'error', metrics: RunMetrics & { errorCode?: string }): Promise<void> {
    await this.db
      .update(voiceRuns)
      .set({ ...metrics, status, finishedAt: new Date() })
      .where(eq(voiceRuns.id, id))
  }
}
