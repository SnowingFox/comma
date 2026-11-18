import { z } from "zod";
import { RunMode } from "./events";
import { LanguageTag, LlmBaseUrl, ReasoningEffort, Settings, SettingsPatch } from "./settings";

/** Keychain entries. Values are write-only from the frontend. */
export const SecretName = z.enum(["elevenlabs", "llm"]);
export type SecretName = z.infer<typeof SecretName>;

/** Which secrets are present. Never carries the values. */
export const SecretStatus = z.object({
  elevenlabs: z.boolean(),
  llm: z.boolean(),
});
export type SecretStatus = z.infer<typeof SecretStatus>;

export const PermissionState = z.enum(["granted", "denied", "restricted", "not_determined"]);
export type PermissionState = z.infer<typeof PermissionState>;

export const PermissionsStatus = z.object({
  /** AVCaptureDevice authorization for audio. */
  microphone: PermissionState,
  /** AXIsProcessTrusted: `granted` or `denied`. */
  accessibility: PermissionState,
});
export type PermissionsStatus = z.infer<typeof PermissionsStatus>;

/** The System Settings Privacy pane to open. */
export const SettingsPaneKind = z.enum(["microphone", "accessibility"]);
export type SettingsPaneKind = z.infer<typeof SettingsPaneKind>;

export const WindowLabel = z.enum(["hub", "onboarding", "bar"]);
export type WindowLabel = z.infer<typeof WindowLabel>;

const NoArgs = z.object({}).strict();
const Unit = z.null();
const Ms = z.number().nonnegative();

/** `llm_test`: one tiny streamed completion. */
export const LlmTestResult = z.object({
  /** The model that answered, as the endpoint reports it. */
  model: z.string(),
  /** Request start to the first content token; null when no content arrived. */
  ttft_ms: Ms.nullable(),
  total_ms: Ms,
  reasoning_tokens: z.number().int().nonnegative().nullable(),
  /** The first characters of the reply. */
  reply: z.string(),
});
export type LlmTestResult = z.infer<typeof LlmTestResult>;

/** `stt_test`: a generated one-second clip sent to ElevenLabs. */
export const SttTestResult = z.object({
  model_id: z.string(),
  total_ms: Ms,
  /** Usually empty: the clip has no speech. */
  text: z.string(),
  language_code: z.string(),
});
export type SttTestResult = z.infer<typeof SttTestResult>;

export const Transcription = z.object({
  text: z.string(),
  /** ISO 639-3 as ElevenLabs reports it, e.g. `eng`. */
  language_code: z.string(),
  language_probability: z.number().nullable(),
  duration_secs: z.number().nonnegative().nullable(),
  /** All ElevenLabs calls, including a language retry. */
  total_ms: Ms,
  /** True when a second call forced the first preferred language. */
  retried: z.boolean(),
});
export type Transcription = z.infer<typeof Transcription>;

export const Delivery = z.enum(["inline", "external"]);
export type Delivery = z.infer<typeof Delivery>;

export const RefineResult = z.object({
  mode: RunMode,
  text: z.string(),
  /** Ask Anything only: `inline` replaces the selection, `external` is shown in a card. */
  delivery: Delivery.nullable(),
  model: z.string(),
  ttft_ms: Ms.nullable(),
  total_ms: Ms,
});
export type RefineResult = z.infer<typeof RefineResult>;

export const AccountStatus = z.object({
  signed_in: z.boolean(),
  email: z.string(),
  name: z.string(),
  server_url: z.string(),
  /** Signed in, but the server could not be reached to renew the session. */
  offline: z.boolean(),
});
export type AccountStatus = z.infer<typeof AccountStatus>;

/** Onboarding steps in order (spec 2.4). `account` replaces `keys` on the account path. */
export const OnboardingStep = z.enum([
  "welcome",
  "mode",
  "keys",
  "account",
  "permissions",
  "languages",
  "microphone",
  "shortcut",
  "try_dictate",
  "try_ask",
  "try_translate",
  "done",
]);
export type OnboardingStep = z.infer<typeof OnboardingStep>;

const Email = z.string().trim().min(3).max(320);

/**
 * Commands, frontend -> Rust (spec 3.3). `args` is what the frontend passes to
 * `invoke` (Tauri maps the top-level keys to the Rust parameter names), `result`
 * is what the command resolves with.
 */
export const commands = {
  settings_get: { args: NoArgs, result: Settings },
  settings_set: { args: z.object({ patch: SettingsPatch }).strict(), result: Settings },
  /** An empty value deletes the entry. */
  secret_set: {
    args: z.object({ name: SecretName, value: z.string().max(4096) }).strict(),
    result: Unit,
  },
  secret_status: { args: NoArgs, result: SecretStatus },
  permissions_status: { args: NoArgs, result: PermissionsStatus },
  open_settings_pane: { args: z.object({ kind: SettingsPaneKind }).strict(), result: Unit },
  window_show: { args: z.object({ label: WindowLabel }).strict(), result: Unit },
  window_hide: { args: z.object({ label: WindowLabel }).strict(), result: Unit },

  /** `GET {base}/models`. Defaults to the saved base URL; short timeout on loopback. */
  llm_models: { args: z.object({ base_url: LlmBaseUrl.optional() }).strict(), result: z.array(z.string()) },
  /** Arguments override the saved settings for this call only. */
  llm_test: {
    args: z
      .object({ base_url: LlmBaseUrl.optional(), model: z.string().max(200).optional(), reasoning_effort: ReasoningEffort.optional() })
      .strict(),
    result: LlmTestResult,
  },
  stt_test: { args: NoArgs, result: SttTestResult },
  /** A 16-bit mono WAV, base64. Uses the saved model and languages (with the one language retry). */
  stt_transcribe: { args: z.object({ wav_base64: z.string().min(1).max(36_000_000) }).strict(), result: Transcription },
  /** Rewrites a transcript with the mode's prompt. `selected_text` is for Ask Anything. */
  refine_text: {
    args: z
      .object({
        mode: RunMode,
        text: z.string().min(1).max(100_000),
        target_language: LanguageTag.optional(),
        selected_text: z.string().max(100_000).optional(),
      })
      .strict(),
    result: RefineResult,
  },

  /** `GET /v1/health` on the given or saved server URL. */
  account_check: { args: z.object({ server_url: LlmBaseUrl.optional() }).strict(), result: Unit },
  account_register: {
    args: z.object({ email: Email, password: z.string().min(8).max(256), name: z.string().trim().min(1).max(100) }).strict(),
    result: Unit,
  },
  account_verify_email: {
    args: z.object({ email: Email, code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code") }).strict(),
    result: Unit,
  },
  account_resend_code: { args: z.object({ email: Email }).strict(), result: Unit },
  /** Stores the tokens in the Keychain and switches the mode to `account`. */
  account_sign_in: { args: z.object({ email: Email, password: z.string().min(1).max(256) }).strict(), result: AccountStatus },
  /** Renews an expired access token with the refresh token. */
  account_status: { args: NoArgs, result: AccountStatus },
  account_sign_out: { args: NoArgs, result: Unit },
} as const;

export type Commands = typeof commands;
export type CommandName = keyof Commands;
export type CommandArgs<N extends CommandName> = z.input<Commands[N]["args"]>;
export type CommandResult<N extends CommandName> = z.output<Commands[N]["result"]>;
