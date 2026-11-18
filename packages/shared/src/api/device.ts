import { z } from 'zod'

/** One signed-in app install. */
export const Device = z.object({
  id: z.uuid(),
  name: z.string(),
  platform: z.string(),
  /** ISO 8601. */
  created_at: z.iso.datetime(),
  /** ISO 8601: the last sign-in or refresh. */
  last_seen_at: z.iso.datetime(),
  /** Whether this is the device the request came from. */
  current: z.boolean()
})
export type Device = z.infer<typeof Device>

/** `GET /v1/devices`, most recently seen first. */
export const DeviceListResponse = z.object({ devices: z.array(Device) })
export type DeviceListResponse = z.infer<typeof DeviceListResponse>

/** `DELETE /v1/devices/:id` -> 204. Signs that device out. */
export const DeviceIdParam = z.uuid()
export type DeviceIdParam = z.infer<typeof DeviceIdParam>
