import type { MockHandlers } from "./types";

/** Shortcut, bar, pipeline and output commands. */
export const RUNTIME_HANDLERS: MockHandlers = {
  // `localStorage["comma-dev-listener"] = "fallback"` shows the state without Input Monitoring.
  shortcuts_status: () =>
    localStorage.getItem("comma-dev-listener") === "fallback"
      ? { listener: "fallback", active: { dictate: "Alt+Space", ask: "Alt+Shift+Space", translate: "Alt+Control+Space" }, errors: [], globe_key: "none" }
      : { listener: "fn", active: { dictate: "Fn", ask: "Fn+Space", translate: "Fn+ShiftLeft" }, errors: [], globe_key: "emoji" },
  shortcuts_capture: () => null,
  shortcuts_suspend: () => null,
  hints_reset: () => null,
  input_monitoring_request: () => true,
  bar_layout: () => null,
  bar_menu: () => null,
  hint_take: () => true,
  clipboard_copy: () => null,
  output_insert: () => "pasted",
  pipeline_cancel: () => null,
  account_credits: () => ({ plan: "free", period_end: new Date(Date.now() + 3 * 86_400_000).toISOString(), used_seconds: 742, limit_seconds: 1800 }),
};
