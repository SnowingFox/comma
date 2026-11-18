import { z } from "zod";
import { AppErrorCode } from "./errors";

export const RunMode = z.enum(["dictate", "ask", "translate"]);
export type RunMode = z.infer<typeof RunMode>;

export const RunStage = z.enum(["stt", "llm", "paste"]);
export type RunStage = z.infer<typeof RunStage>;

/** `shortcut://down` starts a recording, `up` ends it, `cancel` drops it (Esc, or a stray key during a short press). */
export const ShortcutPayload = z.object({ mode: RunMode });
export type ShortcutPayload = z.infer<typeof ShortcutPayload>;

/** `shortcut://switch`: the running recording changed mode (Fn then Space) or locked hands-free (Fn pressed twice). */
export const ShortcutSwitchPayload = z.object({ mode: RunMode, hands_free: z.boolean() });
export type ShortcutSwitchPayload = z.infer<typeof ShortcutSwitchPayload>;

/**
 * `shortcut://keys`: which keys of the configured shortcuts are held, for the onboarding keyboard test. Only ever
 * names configured keys (`Fn`, `Space`, `ShiftLeft`, `Alt`...), never any other key.
 */
export const ShortcutKeysPayload = z.object({ held: z.array(z.string().max(32)).max(8) });
export type ShortcutKeysPayload = z.infer<typeof ShortcutKeysPayload>;

/** How the shortcuts are listened for right now (`shortcuts_status`, `shortcut://status`). */
export const ShortcutsStatus = z.object({
  /**
   * `fn`: the Fn tap runs and Input Monitoring is allowed. `fallback`: an Fn shortcut cannot be trusted yet, so the
   * ordinary fallbacks are registered (the tap may still run next to them).
   */
  listener: z.enum(["fn", "fallback"]),
  /** The shortcut each mode answers to now: the configured one, or its fallback while Fn cannot be used. */
  active: z.object({ dictate: z.string(), ask: z.string(), translate: z.string() }),
  /** Modes whose shortcut could not be registered (taken by another app), with the reason. */
  errors: z.array(z.object({ mode: RunMode, message: z.string() })),
  /**
   * System Settings > Keyboard > "Press Globe key to". Comma cannot stop that action, so anything but `none` also
   * opens the emoji picker, switches input source or starts macOS dictation when Fn is pressed.
   */
  globe_key: z.enum(["none", "input_source", "emoji", "dictation", "unknown"]),
  /** The Fn tap. macOS creates one even without Input Monitoring, so `running` alone proves nothing. */
  tap: z.enum(["running", "off", "failed"]),
  tap_error: z.string().nullable(),
  /** Some keyboard event reached the tap since it started. */
  tap_delivered: z.boolean(),
  /** The Input Monitoring preflight, as this process sees it. */
  input_monitoring: z.boolean(),
  /** Allowed, but the tap does not start: macOS applies it after Comma restarts. */
  restart_required: z.boolean(),
  /** Everything registered now: Fn bindings on the tap, ordinary shortcuts through the plugin. */
  registered: z.array(z.object({ mode: RunMode, shortcut: z.string(), via: z.enum(["fn", "plugin"]) })),
});
export type ShortcutsStatus = z.infer<typeof ShortcutsStatus>;

/** `shortcut://action`, to every window: what the shortcut state machine decided. Names only configured shortcuts. */
export const ShortcutActionPayload = z.object({
  action: z.enum(["start", "switch", "stop", "cancel", "hint"]),
  mode: RunMode,
  hands_free: z.boolean().optional(),
  /** `fn`: the Fn tap; `plugin`: an ordinary registered shortcut. */
  source: z.enum(["fn", "plugin"]),
  /** Where the down, up, cancel and switch events went. */
  target: z.enum(["bar", "onboarding", "hub"]),
});
export type ShortcutActionPayload = z.infer<typeof ShortcutActionPayload>;

export const RunStagePayload = z.object({
  id: z.string(),
  stage: RunStage,
  ms: z.number().nonnegative(),
});
export type RunStagePayload = z.infer<typeof RunStagePayload>;

export const RunDeltaPayload = z.object({ id: z.string(), text: z.string() });
export type RunDeltaPayload = z.infer<typeof RunDeltaPayload>;

/** Where the result went: `insert` at the cursor, `replace` the selection, or an `answer` card (never inserted). */
export const RunDelivery = z.enum(["insert", "replace", "answer"]);
export type RunDelivery = z.infer<typeof RunDelivery>;

/** What Comma did with it: pasted, only copied (no Accessibility or no text field), shown as an answer, or nothing (onboarding). */
export const RunOutput = z.enum(["pasted", "copied", "answer", "none"]);
export type RunOutput = z.infer<typeof RunOutput>;

/** Bar hints (spec 2.3.1). */
export const HintKind = z.enum(["ask_hold", "hands_free", "copied", "microphone", "input_monitoring", "accessibility", "microphone_denied", "signed_out"]);
export type HintKind = z.infer<typeof HintKind>;

/** Result of `pipeline_run`, also carried by `run://done`. */
export const RunResult = z.object({
  id: z.string(),
  mode: RunMode,
  raw_text: z.string(),
  refined_text: z.string(),
  audio_secs: z.number().nonnegative(),
  stt_ms: z.number().nonnegative(),
  llm_ttft_ms: z.number().nonnegative().nullable(),
  llm_total_ms: z.number().nonnegative(),
  total_ms: z.number().nonnegative(),
  delivery: RunDelivery,
  output: RunOutput,
  /** A hint the bar should show with the result (already counted). */
  hint: HintKind.nullable(),
  /** Focused app name, when context allowed it. */
  app: z.string().nullable(),
});
export type RunResult = z.infer<typeof RunResult>;

export const RunDonePayload = z.object({ id: z.string(), result: RunResult });
export type RunDonePayload = z.infer<typeof RunDonePayload>;

export const RunErrorPayload = z.object({
  id: z.string(),
  code: z.union([AppErrorCode, z.string()]),
  message: z.string(),
  /** Upstream reason such as `quota_exceeded`. */
  reason: z.string().optional(),
});
export type RunErrorPayload = z.infer<typeof RunErrorPayload>;

/** Visual states of the floating bar (spec 2.1). `empty` is the soft "Didn't catch that". */
export const BarState = z.enum(["idle", "recording", "processing", "done", "empty", "error"]);
export type BarState = z.infer<typeof BarState>;

/** Preview, hub -> bar window, from Settings > Developer and the devtool. `idle` ends the preview. */
export const BarPreviewPayload = z.object({
  state: BarState,
  mode: RunMode.optional(),
  message: z.string().optional(),
  hands_free: z.boolean().optional(),
  done_label: z.string().max(40).optional(),
  hint: z.string().max(200).optional(),
  hint_actions: z.array(z.string().max(24)).max(3).optional(),
  answer: z.string().max(2000).optional(),
});
export type BarPreviewPayload = z.infer<typeof BarPreviewPayload>;

/** `bar://hint`, Rust -> bar: show a hint (already counted against its limit). */
export const BarHintPayload = z.object({ kind: HintKind });
export type BarHintPayload = z.infer<typeof BarHintPayload>;

/** `history://changed`: a run was added, changed or deleted; the hub refetches. */
export const HistoryChangedPayload = z.object({ id: z.string().optional() });
export type HistoryChangedPayload = z.infer<typeof HistoryChangedPayload>;

/** Settings, hub -> onboarding: start over, or open one step (an `OnboardingStep` id). */
export const OnboardingRestartPayload = z.object({ step: z.string().max(32).optional() });
export type OnboardingRestartPayload = z.infer<typeof OnboardingRestartPayload>;

/** Events, Rust -> frontend (spec 3.3), plus window-to-window messages (bar preview, onboarding restart). */
export const events = {
  "shortcut://down": ShortcutPayload,
  "shortcut://up": ShortcutPayload,
  "shortcut://cancel": ShortcutPayload,
  "shortcut://switch": ShortcutSwitchPayload,
  "shortcut://keys": ShortcutKeysPayload,
  "shortcut://action": ShortcutActionPayload,
  "shortcut://status": ShortcutsStatus,
  "run://stage": RunStagePayload,
  "run://delta": RunDeltaPayload,
  "run://done": RunDonePayload,
  "run://error": RunErrorPayload,
  "bar://preview": BarPreviewPayload,
  "bar://hint": BarHintPayload,
  "history://changed": HistoryChangedPayload,
  /** Bar -> hub: open a page (and section, e.g. a run id in History). */
  "hub://open": z.object({ page: z.enum(["home", "history", "dictionary", "usage", "settings"]), section: z.string().max(64).optional() }),
  /** Any window changed settings; the others refetch. */
  "settings://changed": z.object({}),
  "onboarding://restart": OnboardingRestartPayload,
} as const;

export type Events = typeof events;
export type EventName = keyof Events;
export type EventPayload<N extends EventName> = z.output<Events[N]>;
