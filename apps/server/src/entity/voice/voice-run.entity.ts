import type { VoiceDelivery, VoiceMode } from '@comma/shared'
import { sql } from 'drizzle-orm'
import { boolean, doublePrecision, index, integer, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core'
import { devices } from '../device/device.entity'
import { users } from '../user/user.entity'

export type VoiceRunStatus = 'running' | 'ok' | 'error'

/**
 * One voice run on Comma's credits. Metrics only: `raw_text` and `refined_text` stay null unless the user turns
 * on history sync. A `running` row is the per-user lock (partial unique index); only `ok` rows count as usage.
 */
export const voiceRuns = pgTable(
  'voice_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
    mode: varchar('mode', { length: 16 }).$type<VoiceMode>().notNull(),
    status: varchar('status', { length: 16 }).$type<VoiceRunStatus>().notNull().default('running'),
    /** `ErrorCode` of a failed run. */
    errorCode: varchar('error_code', { length: 40 }),
    delivery: varchar('delivery', { length: 16 }).$type<VoiceDelivery>(),
    detectedLanguage: varchar('detected_language', { length: 16 }),
    sttRetried: boolean('stt_retried').notNull().default(false),
    /** Measured from the upload before the providers are called; billed only when `status` is `ok`. */
    audioSeconds: doublePrecision('audio_seconds').notNull(),
    sttMs: integer('stt_ms'),
    llmTtftMs: integer('llm_ttft_ms'),
    llmTotalMs: integer('llm_total_ms'),
    totalMs: integer('total_ms'),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    sttCostUsd: doublePrecision('stt_cost_usd').notNull().default(0),
    rawText: text('raw_text'),
    refinedText: text('refined_text'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' })
  },
  (table) => [
    uniqueIndex('voice_runs_one_running_idx').on(table.userId).where(sql`${table.status} = 'running'`),
    index('voice_runs_user_created_idx').on(table.userId, table.createdAt)
  ]
)

export type VoiceRunRow = typeof voiceRuns.$inferSelect
