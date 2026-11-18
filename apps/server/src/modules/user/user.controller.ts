import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Patch } from '@nestjs/common'
import { DeleteMeRequest, type MeResponse, UpdateMeRequest } from '@comma/shared'
import type { AuthUser } from '@/app'
import { User } from '@/decorator/user.decorator'
import { ApiException } from '@/filter/api-error.filter'
import { presentUser } from './internal/user.presenter'
import { UserService } from './user.service'

@Controller({ path: '/me', version: '1' })
export class UserController {
  @Inject()
  private readonly users: UserService

  @Get()
  async me(@User() caller: AuthUser): Promise<MeResponse> {
    return { user: presentUser(await this.users.getUser(caller.userId)) }
  }

  @Patch()
  async update(@User() caller: AuthUser, @Body({ schema: UpdateMeRequest }) body: UpdateMeRequest): Promise<MeResponse> {
    return { user: presentUser(await this.users.update(caller.userId, body)) }
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(@User() caller: AuthUser, @Body({ schema: DeleteMeRequest }) body: DeleteMeRequest): Promise<void> {
    const user = await this.users.getUser(caller.userId)
    if (!(await Bun.password.verify(body.password, user.passwordHash))) {
      throw new ApiException(HttpStatus.FORBIDDEN, 'invalid_credentials', 'Wrong password')
    }
    await this.users.delete(user.id)
  }
}
