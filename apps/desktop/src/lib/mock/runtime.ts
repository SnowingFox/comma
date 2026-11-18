import type { MockHandlers } from "./types";

/** Shortcut, bar, pipeline and output commands. */
export const RUNTIME_HANDLERS: MockHandlers = {
  shortcuts_status: () => ({ listener: "fn", active: { dictate: "Fn", ask: "Fn+Space", translate: "Fn+ShiftLeft" }, errors: [], globe_key: "none" }),
  shortcuts_capture: () => null,
  input_monitoring_request: () => true,
  bar_layout: () => null,
  bar_menu: () => null,
  hint_take: () => true,
  clipboard_copy: () => null,
  output_insert: () => "pasted",
  pipeline_cancel: () => null,
  account_credits: () => ({ plan: "free", period_end: new Date(Date.now() + 3 * 86_400_000).toISOString(), used_seconds: 742, limit_seconds: 1800 }),
};
