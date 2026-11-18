import { z } from "zod";
import { HintKind, RunMode, RunOutput, RunResult, ShortcutsStatus } from "./events";
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
  /** CGPreflightListenEventAccess, for the Fn shortcuts: `granted` or `denied`. */
  input_monitoring: PermissionState,
});
export type PermissionsStatus = z.infer<typeof PermissionsStatus>;

/** The System Settings Privacy pane to open. */
export const SettingsPaneKind = z.enum(["microphone", "accessibility", "input_monitoring", "keyboard"]);
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

export const RunSource = z.enum(["bar", "onboarding"]);
export type RunSource = z.infer<typeof RunSource>;

/** One run in the local history (spec 3.2 `runs`). Times are milliseconds, `ts` is Unix ms. */
export const RunRecord = z.object({
  id: z.string(),
  ts: z.number().int(),
  mode: RunMode,
  /** `local` (your keys) or `comma` (account credits). */
  provider: z.enum(["local", "comma"]),
  app: z.string().nullable(),
  raw_text: z.string(),
  refined_text: z.string(),
  language: z.string().nullable(),
  model: z.string().nullable(),
  audio_secs: z.number().nonnegative(),
  stt_ms: Ms.nullable(),
  llm_ttft_ms: Ms.nullable(),
  llm_total_ms: Ms.nullable(),
  total_ms: Ms.nullable(),
  prompt_tokens: z.number().int().nonnegative().nullable(),
  completion_tokens: z.number().int().nonnegative().nullable(),
  stt_cost_usd: z.number().nonnegative().nullable(),
  words: z.number().int().nonnegative(),
  ok: z.boolean(),
  error: z.string().nullable(),
  output: z.string().nullable(),
  has_audio: z.boolean(),
});
export type RunRecord = z.infer<typeof RunRecord>;

export const RunsQuery = z
  .object({
    /** Matches raw or refined text and the app name. */
    search: z.string().max(200).optional(),
    /** Unix ms; only runs before it (paging). */
    before: z.number().int().optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict();
export type RunsQuery = z.infer<typeof RunsQuery>;

/** Local calendar days: today, or the last 7 / 30 / 90 days including today. */
export const UsageRange = z.enum(["today", "7d", "30d", "90d"]);
export type UsageRange = z.infer<typeof UsageRange>;

export const UsageTotals = z.object({
  runs: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  words: z.number().int().nonnegative(),
  audio_secs: z.number().nonnegative(),
  stt_cost_usd: z.number().nonnegative(),
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
});
export type UsageTotals = z.infer<typeof UsageTotals>;

export const UsageBreakdown = z.array(UsageTotals.extend({ key: z.string() }));
export type UsageBreakdown = z.infer<typeof UsageBreakdown>;

const Percentiles = z.object({ p50: Ms.nullable(), p95: Ms.nullable() });

export const UsageSummary = z.object({
  range: UsageRange,
  totals: UsageTotals,
  by_mode: UsageBreakdown,
  by_model: UsageBreakdown,
  by_app: UsageBreakdown,
  stages: z.object({ stt: Percentiles, llm_ttft: Percentiles, llm_total: Percentiles, total: Percentiles }),
});
export type UsageSummary = z.infer<typeof UsageSummary>;

/** One entry per local day in the range, oldest first, days without runs included. */
export const UsageDay = UsageTotals.extend({ date: z.string() });
export type UsageDay = z.infer<typeof UsageDay>;

/** A dictionary term, local (Local mode) or on the Comma server (account mode). */
export const DictionaryEntry = z.object({ id: z.string(), term: z.string(), created_at: z.string() });
export type DictionaryEntry = z.infer<typeof DictionaryEntry>;

const Term = z.string().trim().min(1).max(100);

/** `GET /v1/me/credits` for the signed-in account. */
export const Credits = z.object({
  plan: z.string(),
  period_end: z.string(),
  used_seconds: z.number().nonnegative(),
  limit_seconds: z.number().nonnegative(),
});
export type Credits = z.infer<typeof Credits>;

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
  /** This week's Comma credits; fails when signed out. */
  account_credits: { args: NoArgs, result: Credits },

  /** Asks macOS for Input Monitoring (adds Comma to the list and shows the prompt once). Resolves with whether it is allowed. */
  input_monitoring_request: { args: NoArgs, result: z.boolean() },
  shortcuts_status: { args: NoArgs, result: ShortcutsStatus },
  /**
   * While `owner` is focused, shortcut events go only to it (onboarding try steps, the hub's Fn key test) and nothing
   * records; null gives them back to the bar.
   */
  shortcuts_capture: { args: z.object({ owner: z.enum(["onboarding", "hub"]).nullable() }).strict(), result: Unit },
  /** Stops the Fn tap and the ordinary shortcuts and registers everything again. */
  shortcuts_restart: { args: NoArgs, result: ShortcutsStatus },
  /** Re-checks Input Monitoring and tries the Fn tap even when the preflight says no. */
  shortcuts_probe: { args: NoArgs, result: ShortcutsStatus },
  /** While the shortcut recorder is open: nothing is registered or matched, so its keys reach the window. */
  shortcuts_suspend: { args: z.object({ suspended: z.boolean() }).strict(), result: Unit },

  /**
   * A full run: speech to text and the rewrite (your keys, or the Comma server in account mode), then the output
   * (paste, copy, or an answer), saved to history. `bar` uses the context captured when the shortcut went down;
   * `onboarding` passes `selected_text` itself and is never pasted. Emits `run://stage|delta|done|error`.
   */
  pipeline_run: {
    args: z
      .object({
        mode: RunMode,
        /** 16-bit mono WAV, or Ogg/Opus (then `audio_secs` is required), base64. */
        audio_base64: z.string().min(1).max(36_000_000),
        audio_secs: z.number().nonnegative().max(3600).optional(),
        source: RunSource,
        target_language: LanguageTag.optional(),
        selected_text: z.string().max(100_000).optional(),
        /** Milliseconds the window spent recording and encoding. */
        record_ms: z.number().nonnegative().max(3_600_000).optional(),
      })
      .strict(),
    result: RunResult,
  },
  /** Stops the run in flight, if any. */
  pipeline_cancel: { args: NoArgs, result: Unit },
  /**
   * What a run needs before recording: the ElevenLabs key and an LLM model (Local), or a session (account). Rejects
   * with `not_configured` and `reason` `missing_elevenlabs_key`, `missing_llm_model` or `signed_out`.
   */
  pipeline_check: { args: z.object({ mode: RunMode }).strict(), result: Unit },
  /** Pastes `text` into the app that was focused when the run started (answer card Insert). */
  output_insert: { args: z.object({ text: z.string().min(1).max(100_000) }).strict(), result: RunOutput },
  /** Puts `text` on the clipboard. */
  clipboard_copy: { args: z.object({ text: z.string().max(100_000) }).strict(), result: Unit },

  /**
   * Floating bar window: `dot` is a small window for the idle dot, `full` has room for the pill, a hint and the answer
   * card. `interactive` lets it take clicks (cards, hints); `escape` listens for Esc to close a card.
   */
  bar_layout: {
    args: z.object({ layout: z.enum(["hidden", "dot", "full"]), interactive: z.boolean(), escape: z.boolean().optional() }).strict(),
    result: Unit,
  },
  /** The bar's right-click menu: copy last result, output language, open Comma. */
  bar_menu: { args: NoArgs, result: Unit },
  /** Whether hint `kind` may show now (hints on and under its limit); counts it when it may. */
  hint_take: { args: z.object({ kind: HintKind }).strict(), result: z.boolean() },
  /** Forgets how often each hint was shown, so the teaching hints show again. */
  hints_reset: { args: NoArgs, result: Unit },

  /** The last lines of the app log (`~/Library/Logs/app.comma.desktop/comma.log`). */
  log_tail: {
    args: z.object({ lines: z.number().int().min(1).max(1000).optional() }).strict(),
    result: z.object({ path: z.string(), lines: z.array(z.string()) }),
  },
  /** A line from a window: states and error names only, never dictated or typed text. */
  log_write: {
    args: z
      .object({ level: z.enum(["info", "warn", "error"]), scope: z.string().max(32), message: z.string().max(500) })
      .strict(),
    result: Unit,
  },
  /** Quits and relaunches Comma (macOS applies Input Monitoring to a new process). */
  app_restart: { args: NoArgs, result: Unit },

  runs_list: { args: RunsQuery, result: z.array(RunRecord) },
  run_get: { args: z.object({ id: z.string().max(64) }).strict(), result: RunRecord },
  run_delete: { args: z.object({ id: z.string().max(64) }).strict(), result: Unit },
  runs_clear: { args: NoArgs, result: Unit },
  /** Rewrites the stored raw text again with the current LLM settings (Local mode); updates the entry. */
  run_rerun: { args: z.object({ id: z.string().max(64) }).strict(), result: RunRecord },
  /** The kept WAV of a run as base64, when Keep audio was on. */
  run_audio: { args: z.object({ id: z.string().max(64) }).strict(), result: z.string() },

  usage_summary: { args: z.object({ range: UsageRange }).strict(), result: UsageSummary },
  usage_daily: { args: z.object({ range: UsageRange }).strict(), result: z.array(UsageDay) },
  /** Writes the range's runs as CSV to ~/Downloads and resolves with the file path. */
  usage_export_csv: { args: z.object({ range: UsageRange }).strict(), result: z.object({ path: z.string() }) },

  /** Local terms in Local mode, the server's in account mode; oldest first. */
  dictionary_list: { args: NoArgs, result: z.array(DictionaryEntry) },
  dictionary_add: { args: z.object({ term: Term }).strict(), result: DictionaryEntry },
  dictionary_update: { args: z.object({ id: z.string().max(64), term: Term }).strict(), result: DictionaryEntry },
  dictionary_delete: { args: z.object({ id: z.string().max(64) }).strict(), result: Unit },
  /** First column of each row is a term; a `term` header row is skipped; duplicates are skipped. */
  dictionary_import_csv: {
    args: z.object({ csv: z.string().max(200_000) }).strict(),
    result: z.object({ added: z.number().int().nonnegative(), skipped: z.number().int().nonnegative() }),
  },
} as const;

export type Commands = typeof commands;
export type CommandName = keyof Commands;
export type CommandArgs<N extends CommandName> = z.input<Commands[N]["args"]>;
export type CommandResult<N extends CommandName> = z.output<Commands[N]["result"]>;
