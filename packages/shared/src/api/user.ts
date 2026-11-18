import { z } from 'zod'

/** A language tag such as `en`, `zh-Hans` or `pt-BR`. */
export const LanguageTag = z
  .string()
  .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/, 'expected a language tag such as en or pt-BR')

/** What the app may read from other apps during a run (spec section 1, Context). */
export const ContextLevel = z.enum(['off', 'app', 'app_and_selection'])
export type ContextLevel = z.infer<typeof ContextLevel>

/** Whose provider keys the desktop app uses: the user's own (Keychain) or Comma's credits through this server. */
export const ProviderMode = z.enum(['own', 'comma'])
export type ProviderMode = z.infer<typeof ProviderMode>

/** Settings that follow the account across devices. */
export const UserSettings = z.object({
  /** Preferred spoken languages, most preferred first. */
  languages: z.array(LanguageTag).max(10),
  /** Translate mode targets; the first one is used. */
  translate_targets: z.array(LanguageTag).max(3),
  context_level: ContextLevel,
  provider_mode: ProviderMode
})
export type UserSettings = z.infer<typeof UserSettings>

export const DEFAULT_USER_SETTINGS: UserSettings = {
  languages: [],
  translate_targets: [],
  context_level: 'app_and_selection',
  provider_mode: 'own'
}

export const Plan = z.enum(['free'])
export type Plan = z.infer<typeof Plan>

/** Display name as typed by the user. */
export const UserName = z.string().trim().min(1).max(100)

export const User = z.object({
  id: z.uuid(),
  email: z.email(),
  name: z.string(),
  email_verified: z.boolean(),
  plan: Plan,
  settings: UserSettings,
  /** ISO 8601. */
  created_at: z.iso.datetime()
})
export type User = z.infer<typeof User>

/** `GET /v1/me` and `PATCH /v1/me`. */
export const MeResponse = z.object({ user: User })
export type MeResponse = z.infer<typeof MeResponse>

/** `PATCH /v1/me`: any subset; `settings` fields are merged into the stored ones. */
export const UpdateMeRequest = z
  .object({
    name: UserName.optional(),
    settings: UserSettings.partial().strict().optional()
  })
  .strict()
  .refine((body) => body.name !== undefined || body.settings !== undefined, 'nothing to update')
export type UpdateMeRequest = z.infer<typeof UpdateMeRequest>

/** `DELETE /v1/me`: the password again, so a stolen access token alone cannot delete the account. */
export const DeleteMeRequest = z.object({ password: z.string().min(1).max(256) })
export type DeleteMeRequest = z.infer<typeof DeleteMeRequest>
