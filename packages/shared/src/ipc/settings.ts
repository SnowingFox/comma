import { z } from "zod";

/** How the app runs the pipeline: with the user's own keys, or through a Comma server. */
export const AppMode = z.enum(["local", "account"]);
export type AppMode = z.infer<typeof AppMode>;

export const ThemePreference = z.enum(["system", "light", "dark"]);
export type ThemePreference = z.infer<typeof ThemePreference>;

/**
 * Off maps to `"none"` on the wire; Default omits the field (spec 3.2).
 */
export const ReasoningEffort = z.enum(["off", "low", "medium", "high", "default"]);
export type ReasoningEffort = z.infer<typeof ReasoningEffort>;

export const LlmBaseUrl = z.url({ protocol: /^https?$/, message: "Enter an http or https URL" }).max(2048);

export const SttSettings = z.object({
  /** ElevenLabs model id. */
  model_id: z.string().min(1).max(100),
});
export type SttSettings = z.infer<typeof SttSettings>;

export const LlmSettings = z.object({
  /** OpenAI-compatible base URL, without the `/chat/completions` suffix. */
  base_url: LlmBaseUrl,
  /** Model id; empty until the user picks one. */
  model: z.string().max(200),
  reasoning_effort: ReasoningEffort,
});
export type LlmSettings = z.infer<typeof LlmSettings>;

/** A language tag such as `en`, `zh-Hans` or `pt-BR` (same shape as the server's `LanguageTag`). */
export const LanguageTag = z
  .string()
  .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/, "expected a language tag such as en or pt-BR");

export const LanguageSettings = z.object({
  /** Languages the user speaks, most preferred first; the first is the fallback when detection is unsure. */
  spoken: z.array(LanguageTag).max(10),
  auto_detect: z.boolean(),
  /** Translate targets, at most three; the first one is used. */
  translate_targets: z.array(LanguageTag).max(3),
});
export type LanguageSettings = z.infer<typeof LanguageSettings>;

/** An accelerator such as `Alt+Shift+Space` (modifiers `Control`, `Alt`, `Shift`, `Super`, then one key). */
export const Accelerator = z.string().min(1).max(64).regex(/^\S+$/, "no spaces");

export const ShortcutSettings = z.object({
  dictate: Accelerator,
  ask: Accelerator,
  translate: Accelerator,
});
export type ShortcutSettings = z.infer<typeof ShortcutSettings>;

/** The Comma server and who is signed in. Tokens live in the Keychain, never here. */
export const AccountSettings = z.object({
  server_url: LlmBaseUrl,
  email: z.string().max(320),
  name: z.string().max(200),
  /** Unix seconds when the stored access token expires; 0 when signed out. */
  access_expires_at: z.number().int().nonnegative(),
});
export type AccountSettings = z.infer<typeof AccountSettings>;

/** Non-secret settings, stored as JSON in the app config dir. Secrets live in the Keychain. */
export const Settings = z.object({
  version: z.literal(1),
  mode: AppMode,
  theme: ThemePreference,
  onboarding_completed: z.boolean(),
  /** Onboarding step to resume at (see `OnboardingStep`); empty for the first one. */
  onboarding_step: z.string().max(32),
  stt: SttSettings,
  llm: LlmSettings,
  languages: LanguageSettings,
  shortcuts: ShortcutSettings,
  account: AccountSettings,
});
export type Settings = z.infer<typeof Settings>;

/** A partial update for `settings_set`; nested objects merge one level deep. */
export const SettingsPatch = z
  .object({
    mode: AppMode.optional(),
    theme: ThemePreference.optional(),
    onboarding_completed: z.boolean().optional(),
    onboarding_step: z.string().max(32).optional(),
    stt: SttSettings.partial().strict().optional(),
    llm: LlmSettings.partial().strict().optional(),
    languages: LanguageSettings.partial().strict().optional(),
    shortcuts: ShortcutSettings.partial().strict().optional(),
    /** Only `server_url` is meant to be set from the UI; the rest follows sign-in. */
    account: AccountSettings.pick({ server_url: true }).partial().strict().optional(),
  })
  .strict();
export type SettingsPatch = z.infer<typeof SettingsPatch>;

/** Magpie, the local gateway Comma looks for first. */
export const MAGPIE_BASE_URL = "http://127.0.0.1:3425/v1";

/** A Comma server run locally with `docker compose up`. */
export const DEFAULT_SERVER_URL = "http://127.0.0.1:8787";

export const DEFAULT_SHORTCUTS: ShortcutSettings = {
  dictate: "Alt+Space",
  ask: "Alt+Shift+Space",
  translate: "Alt+Control+Space",
};

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  mode: "local",
  theme: "system",
  onboarding_completed: false,
  onboarding_step: "",
  stt: { model_id: "scribe_v3" },
  llm: { base_url: MAGPIE_BASE_URL, model: "", reasoning_effort: "default" },
  languages: { spoken: [], auto_detect: true, translate_targets: [] },
  shortcuts: DEFAULT_SHORTCUTS,
  account: { server_url: DEFAULT_SERVER_URL, email: "", name: "", access_expires_at: 0 },
};
