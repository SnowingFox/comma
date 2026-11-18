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

/** Non-secret settings, stored as JSON in the app config dir. Secrets live in the Keychain. */
export const Settings = z.object({
  version: z.literal(1),
  mode: AppMode,
  theme: ThemePreference,
  onboarding_completed: z.boolean(),
  stt: SttSettings,
  llm: LlmSettings,
});
export type Settings = z.infer<typeof Settings>;

/** A partial update for `settings_set`; nested objects merge one level deep. */
export const SettingsPatch = z
  .object({
    mode: AppMode.optional(),
    theme: ThemePreference.optional(),
    onboarding_completed: z.boolean().optional(),
    stt: SttSettings.partial().strict().optional(),
    llm: LlmSettings.partial().strict().optional(),
  })
  .strict();
export type SettingsPatch = z.infer<typeof SettingsPatch>;

/** Magpie, the local gateway Comma looks for first. */
export const MAGPIE_BASE_URL = "http://127.0.0.1:3425/v1";

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  mode: "local",
  theme: "system",
  onboarding_completed: false,
  stt: { model_id: "scribe_v3" },
  llm: { base_url: MAGPIE_BASE_URL, model: "", reasoning_effort: "default" },
};
