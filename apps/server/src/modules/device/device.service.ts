import { HttpStatus, Injectable } from '@nestjs/common'
import { InjectDrizzle } from '@nestjs/drizzle'
import type { Device } from '@comma/shared'
import { and, desc, eq } from 'drizzle-orm'
import { type DeviceRow, devices } from '@/entity'
import { ApiException } from '@/filter/api-error.filter'
import type { Database } from '@/utils/database'

@Injectable()
export class DeviceService {
  @InjectDrizzle()
  private readonly db: Database

  async create(input: { userId: string; name: string; platform: string }): Promise<DeviceRow> {
    const [device] = await this.db.insert(devices).values(input).returning()
    if (!device) {
      throw new Error('device insert returned no row')
    }
    return device
  }

  /** Whether the device is still signed in for this user; checked on every authenticated request. */
  async isActive(userId: string, deviceId: string): Promise<boolean> {
    const device = await this.db.query.devices.findFirst({
      columns: { id: true },
      where: and(eq(devices.id, deviceId), eq(devices.userId, userId))
    })
    return device !== undefined
  }

  async list(userId: string, currentDeviceId: string): Promise<Device[]> {
    const rows = await this.db.query.devices.findMany({
      where: eq(devices.userId, userId),
      orderBy: [desc(devices.lastSeenAt)]
    })
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      platform: row.platform,
      created_at: row.createdAt.toISOString(),
      last_seen_at: row.lastSeenAt.toISOString(),
      current: row.id === currentDeviceId
    }))
  }

  /** Signs the device out: its refresh tokens go with the row, and its access tokens fail `isActive`. */
  async revoke(userId: string, deviceId: string): Promise<void> {
    const deleted = await this.db
      .delete(devices)
      .where(and(eq(devices.id, deviceId), eq(devices.userId, userId)))
      .returning({ id: devices.id })
    if (deleted.length === 0) {
      throw new ApiException(HttpStatus.NOT_FOUND, 'not_found', 'Device not found')
    }
  }

  /** For refresh-token reuse and logout, where the device is known from a token row. */
  async remove(deviceId: string): Promise<void> {
    await this.db.delete(devices).where(eq(devices.id, deviceId))
  }
}
