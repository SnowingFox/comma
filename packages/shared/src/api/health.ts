import { z } from 'zod'

const Indicators = z.record(z.string(), z.object({ status: z.string() }).loose())

/** `GET /v1/health` -> 200 when every dependency is up; 503 `ApiError` otherwise. */
export const HealthResponse = z.object({
  status: z.literal('ok'),
  info: Indicators.optional(),
  error: Indicators.optional(),
  details: Indicators
})
export type HealthResponse = z.infer<typeof HealthResponse>
