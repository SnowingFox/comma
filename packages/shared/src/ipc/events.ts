import { z } from "zod";
import { AppErrorCode } from "./errors";

export const RunMode = z.enum(["dictate", "ask", "translate"]);
export type RunMode = z.infer<typeof RunMode>;

export const RunStage = z.enum(["stt", "llm", "paste"]);
export type RunStage = z.infer<typeof RunStage>;

export const ShortcutPayload = z.object({ mode: RunMode });
export type ShortcutPayload = z.infer<typeof ShortcutPayload>;

export const RunStagePayload = z.object({
  id: z.string(),
  stage: RunStage,
  ms: z.number().nonnegative(),
});
export type RunStagePayload = z.infer<typeof RunStagePayload>;

export const RunDeltaPayload = z.object({ id: z.string(), text: z.string() });
export type RunDeltaPayload = z.infer<typeof RunDeltaPayload>;

/** Result of `pipeline_run` (phase 2), carried by `run://done`. */
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
});
export type RunResult = z.infer<typeof RunResult>;

export const RunDonePayload = z.object({ id: z.string(), result: RunResult });
export type RunDonePayload = z.infer<typeof RunDonePayload>;

export const RunErrorPayload = z.object({
  id: z.string(),
  code: z.union([AppErrorCode, z.string()]),
  message: z.string(),
});
export type RunErrorPayload = z.infer<typeof RunErrorPayload>;

/** Visual states of the floating bar (spec 2.1). */
export const BarState = z.enum(["idle", "recording", "processing", "done", "error"]);
export type BarState = z.infer<typeof BarState>;

/** Dev-only preview, hub -> bar window, from Settings > Developer. */
export const BarPreviewPayload = z.object({
  state: BarState,
  mode: RunMode.optional(),
  message: z.string().optional(),
});
export type BarPreviewPayload = z.infer<typeof BarPreviewPayload>;

/** Events, Rust -> frontend (spec 3.3), plus the dev-only bar preview. */
export const events = {
  "shortcut://down": ShortcutPayload,
  "shortcut://up": ShortcutPayload,
  "shortcut://cancel": ShortcutPayload,
  "run://stage": RunStagePayload,
  "run://delta": RunDeltaPayload,
  "run://done": RunDonePayload,
  "run://error": RunErrorPayload,
  "bar://preview": BarPreviewPayload,
} as const;

export type Events = typeof events;
export type EventName = keyof Events;
export type EventPayload<N extends EventName> = z.output<Events[N]>;
