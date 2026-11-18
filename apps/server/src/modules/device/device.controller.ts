import { Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param } from '@nestjs/common'
import { DeviceIdParam, type DeviceListResponse } from '@comma/shared'
import type { AuthUser } from '@/app'
import { User } from '@/decorator/user.decorator'
import { DeviceService } from './device.service'

@Controller({ path: '/devices', version: '1' })
export class DeviceController {
  @Inject()
  private readonly devices: DeviceService

  @Get()
  async list(@User() caller: AuthUser): Promise<DeviceListResponse> {
    return { devices: await this.devices.list(caller.userId, caller.deviceId) }
  }

  @Delete('/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(@User() caller: AuthUser, @Param('id', { schema: DeviceIdParam }) id: DeviceIdParam): Promise<void> {
    await this.devices.revoke(caller.userId, id)
  }
}
