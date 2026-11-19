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

/**
 * A shortcut. Two kinds:
 * - Fn-based, matched by Comma's modifier listener (needs Input Monitoring): `Fn` alone, or `Fn+<key>` with one of
 *   `FN_KEYS` (`Fn+Space`, `Fn+ShiftLeft`).
 * - An ordinary accelerator for the global-shortcut plugin: modifiers `Control`, `Alt`, `Shift`, `Super`, then one key
 *   (`Alt+Shift+Space`).
 */
export const Accelerator = z.string().min(1).max(64).regex(/^\S+$/, "no spaces");

/** Keys that can follow `Fn+`. Side-specific modifiers use the `KeyboardEvent.code` names. */
export const FN_KEYS = [
  "Space",
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
] as const;

export function isFnAccelerator(accel: string): boolean {
  return accel === "Fn" || accel.startsWith("Fn+");
}

export const ShortcutSettings = z.object({
  dictate: Accelerator,
  ask: Accelerator,
  translate: Accelerator,
  /** Pastes the most recent result again (spec 2.3.2). An ordinary accelerator, never Fn; empty turns it off. */
  paste_last: z.union([z.literal(""), Accelerator]),
});
export type ShortcutSettings = z.infer<typeof ShortcutSettings>;

/** The shortcuts that start a mode (everything in `ShortcutSettings` but Paste last result). */
export type ModeShortcut = "dictate" | "ask" | "translate";
export const MODE_SHORTCUTS: readonly ModeShortcut[] = ["dictate", "ask", "translate"];

/** What a run may read from other apps (spec section 1): nothing, the focused app's name, or that plus the selection for Ask Anything. */
export const ContextLevel = z.enum(["off", "app", "app_and_selection"]);
export type ContextLevel = z.infer<typeof ContextLevel>;

/** Sounds, the idle bar and the bar hints (spec 2.1, 2.3.1). */
export const FeedbackSettings = z.object({
  /** Soft synthesised ticks at start and finish. */
  sounds: z.boolean(),
  /** A 6 px dot at the bottom centre while Comma is idle. */
  show_idle_bar: z.boolean(),
  /** The short teaching hints next to the bar. */
  hints: z.boolean(),
  /** Lower the Mac's output volume while recording, so other audio stays out of the dictation. */
  duck_audio: z.boolean(),
});
export type FeedbackSettings = z.infer<typeof FeedbackSettings>;

/** History retention choices in days; 0 keeps everything. */
export const HISTORY_DAYS = [0, 7, 30, 90] as const;

export const PrivacySettings = z.object({
  /** Keep each run's WAV next to its history entry. Off by default. */
  keep_audio: z.boolean(),
  /** Runs older than this many days are deleted; 0 keeps them. */
  history_days: z.number().int().min(0).max(3650),
});
export type PrivacySettings = z.infer<typeof PrivacySettings>;

export const AudioSettings = z.object({
  /** `MediaDeviceInfo.deviceId` of the microphone to use; empty for the system default. */
  microphone_id: z.string().max(256),
});
export type AudioSettings = z.infer<typeof AudioSettings>;

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
  context_level: ContextLevel,
  feedback: FeedbackSettings,
  privacy: PrivacySettings,
  audio: AudioSettings,
  /** How often each bar hint has been shown (spec 2.3.1). Written by Rust only. */
  hint_counts: z.record(z.string(), z.number().int().nonnegative()),
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
    context_level: ContextLevel.optional(),
    feedback: FeedbackSettings.partial().strict().optional(),
    privacy: PrivacySettings.partial().strict().optional(),
    audio: AudioSettings.partial().strict().optional(),
  })
  .strict();
export type SettingsPatch = z.infer<typeof SettingsPatch>;

/** Magpie, the local gateway Comma looks for first. */
export const MAGPIE_BASE_URL = "http://127.0.0.1:3425/v1";

/** A Comma server run locally with `docker compose up`. */
export const DEFAULT_SERVER_URL = "http://127.0.0.1:8787";

/** Spec 2.3.2: Fn held, Fn+Space pressed, Fn+Left Shift pressed or held, Ctrl+Cmd+V pastes the last result. */
export const DEFAULT_SHORTCUTS: ShortcutSettings = {
  dictate: "Fn",
  ask: "Fn+Space",
  translate: "Fn+ShiftLeft",
  paste_last: "Control+Super+V",
};

/** Used for an Fn-based shortcut while Input Monitoring is not allowed. */
export const FALLBACK_SHORTCUTS: Record<ModeShortcut, string> = {
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
  context_level: "app_and_selection",
  feedback: { sounds: true, show_idle_bar: false, hints: true, duck_audio: true },
  privacy: { keep_audio: false, history_days: 0 },
  audio: { microphone_id: "" },
  hint_counts: {},
};
