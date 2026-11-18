/** The signed-in caller, resolved from a verified access token. */
export interface AuthUser {
  userId: string
  /** The device (sign-in) the access token belongs to. */
  deviceId: string
}

/** Verified claims of a Comma access token. */
export interface AccessClaims {
  sub: string
  did: string
  iat: number
  exp: number
}

declare module '@nestjs/authentication' {
  interface AuthenticationTypes {
    user: AuthUser
    session: AccessClaims
  }
}
