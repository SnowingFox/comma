import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Patch, Post } from '@nestjs/common'
import {
  DictionaryImportRequest,
  type DictionaryImportResponse,
  type DictionaryListResponse,
  DictionaryTermIdParam,
  DictionaryTermRequest,
  type DictionaryTermResponse
} from '@comma/shared'
import type { AuthUser } from '@/app'
import { User } from '@/decorator/user.decorator'
import { DictionaryService } from './dictionary.service'

@Controller({ path: '/dictionary', version: '1' })
export class DictionaryController {
  @Inject()
  private readonly dictionary: DictionaryService

  @Get()
  async list(@User() caller: AuthUser): Promise<DictionaryListResponse> {
    return { terms: await this.dictionary.list(caller.userId) }
  }

  @Post()
  async add(@User() caller: AuthUser, @Body({ schema: DictionaryTermRequest }) body: DictionaryTermRequest): Promise<DictionaryTermResponse> {
    return { term: await this.dictionary.add(caller.userId, body.term) }
  }

  @Post('/import')
  @HttpCode(HttpStatus.OK)
  import(@User() caller: AuthUser, @Body({ schema: DictionaryImportRequest }) body: DictionaryImportRequest): Promise<DictionaryImportResponse> {
    return this.dictionary.import(caller.userId, body.csv)
  }

  @Patch('/:id')
  async update(
    @User() caller: AuthUser,
    @Param('id', { schema: DictionaryTermIdParam }) id: DictionaryTermIdParam,
    @Body({ schema: DictionaryTermRequest }) body: DictionaryTermRequest
  ): Promise<DictionaryTermResponse> {
    return { term: await this.dictionary.update(caller.userId, id, body.term) }
  }

  @Delete('/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@User() caller: AuthUser, @Param('id', { schema: DictionaryTermIdParam }) id: DictionaryTermIdParam): Promise<void> {
    await this.dictionary.remove(caller.userId, id)
  }
}
