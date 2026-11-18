import { CurrentUser } from '@nestjs/authentication'

/** The signed-in caller (`AuthUser`), as resolved by `AccessTokenProvider`. */
export const User = CurrentUser
