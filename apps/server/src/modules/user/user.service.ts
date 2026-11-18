import { HttpStatus, Injectable } from '@nestjs/common'
import { InjectDrizzle } from '@nestjs/drizzle'
import type { UpdateMeRequest } from '@comma/shared'
import { eq, sql } from 'drizzle-orm'
import { type UserRow, users } from '@/entity'
import { ApiException } from '@/filter/api-error.filter'
import type { Database } from '@/utils/database'

@Injectable()
export class UserService {
  @InjectDrizzle()
  private readonly db: Database

  /** `undefined` when the address is taken. */
  async create(input: { email: string; passwordHash: string; name: string }): Promise<UserRow | undefined> {
    const [user] = await this.db.insert(users).values(input).onConflictDoNothing({ target: users.email }).returning()
    return user
  }

  async findByEmail(email: string): Promise<UserRow | undefined> {
    return await this.db.query.users.findFirst({ where: eq(users.email, email) })
  }

  async getUser(userId: string): Promise<UserRow> {
    const user = await this.db.query.users.findFirst({ where: eq(users.id, userId) })
    if (!user) {
      throw new ApiException(HttpStatus.NOT_FOUND, 'not_found', 'User not found')
    }
    return user
  }

  /** Settings keys are merged into the stored object in the same statement, so concurrent patches keep each other's keys. */
  async update(userId: string, patch: UpdateMeRequest): Promise<UserRow> {
    const [user] = await this.db
      .update(users)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.settings !== undefined
          ? { settings: sql`${users.settings} || ${JSON.stringify(patch.settings)}::jsonb` }
          : {}),
        updatedAt: new Date()
      })
      .where(eq(users.id, userId))
      .returning()
    if (!user) {
      throw new ApiException(HttpStatus.NOT_FOUND, 'not_found', 'User not found')
    }
    return user
  }

  /** Devices, refresh tokens and email codes go with it (`on delete cascade`). */
  async delete(userId: string): Promise<void> {
    await this.db.delete(users).where(eq(users.id, userId))
  }
}
