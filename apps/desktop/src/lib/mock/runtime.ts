import type { ShortcutsStatus } from "@comma/shared/ipc";
import type { MockHandlers } from "./types";

/**
 * `localStorage["comma-dev-listener"]`: `fallback` (no Input Monitoring, tap running but nothing delivered),
 * `restart` (allowed, tap fails until a restart), anything else the working Fn listener.
 */
function shortcutsStatus(): ShortcutsStatus {
  const knob = localStorage.getItem("comma-dev-listener");
  if (knob === "fallback" || knob === "restart") {
    const restart = knob === "restart";
    return {
      listener: "fallback",
      active: { dictate: "Alt+Space", ask: "Alt+Shift+Space", translate: "Alt+Control+Space" },
      errors: [],
      globe_key: "emoji",
      tap: restart ? "failed" : "running",
      tap_error: restart ? "Comma needs the Input Monitoring permission to use Fn shortcuts" : null,
      tap_delivered: !restart,
      tap_keys: false,
      requested: restart,
      swallow: "off",
      input_monitoring: restart,
      restart_required: restart,
      registered: [
        ...(restart
          ? []
          : ([
              { mode: "dictate", shortcut: "Fn", via: "fn" },
              { mode: "ask", shortcut: "Fn+Space", via: "fn" },
              { mode: "translate", shortcut: "Fn+ShiftLeft", via: "fn" },
            ] as const)),
        { mode: "dictate", shortcut: "Alt+Space", via: "plugin" },
        { mode: "ask", shortcut: "Alt+Shift+Space", via: "plugin" },
        { mode: "translate", shortcut: "Alt+Control+Space", via: "plugin" },
      ],
    };
  }
  return {
    listener: "fn",
    active: { dictate: "Fn", ask: "Fn+Space", translate: "Fn+ShiftLeft" },
    errors: [],
    globe_key: "emoji",
    tap: "running",
    tap_error: null,
    tap_delivered: true,
    tap_keys: true,
    requested: false,
    swallow: "off",
    input_monitoring: true,
    restart_required: false,
    registered: [
      { mode: "dictate", shortcut: "Fn", via: "fn" },
      { mode: "ask", shortcut: "Fn+Space", via: "fn" },
      { mode: "translate", shortcut: "Fn+ShiftLeft", via: "fn" },
    ],
  };
}

const LOG = [
  "[2026-11-18][21:42:43][INFO][comma_lib] Comma 0.1.0 starting (debug build, pid 28605, /Applications/Comma.app/Contents/MacOS/comma)",
  "[2026-11-18][21:42:43][INFO][comma_lib] settings: mode Local, onboarding done, shortcuts Fn / Fn+Space / Fn+ShiftLeft",
  "[2026-11-18][21:42:43][INFO][comma_lib::shortcuts] shortcuts: listener fn, tap running, nothing delivered yet, input monitoring allowed, registered [dictate=fn (fn), ask=fn+space (fn), translate=fn+shiftleft (fn)]",
  "[2026-11-18][21:42:43][INFO][comma_lib::shortcuts] permissions: microphone Granted, accessibility Granted, input monitoring Granted",
  "[2026-11-18][21:43:07][INFO][comma_lib::shortcuts] Fn listener: listener fn, tap running, delivering, input monitoring allowed",
  '[2026-11-18][21:43:07][INFO][comma_lib::shortcuts] shortcut: "start" "dictate" via "fn" to "bar"',
  '[2026-11-18][21:43:09][INFO][comma_lib::shortcuts] shortcut: "stop" "dictate" via "fn" to "bar"',
  "[2026-11-18][21:43:09][INFO][comma_lib::run] run 5d1e: dictate from bar, 38 KB of audio",
  "[2026-11-18][21:43:10][INFO][comma_lib::run] run 5d1e: stt done after 612.4 ms",
  "[2026-11-18][21:43:10][INFO][comma_lib::run] run 5d1e: llm done after 420.1 ms",
  "[2026-11-18][21:43:10][INFO][comma_lib::run] run 5d1e: ok in 1180.2 ms (stt 612.4 ms, llm first token 210.3 ms, llm 420.1 ms), 2.4 s audio, output pasted",
];

/** Shortcut, bar, pipeline and output commands. */
export const RUNTIME_HANDLERS: MockHandlers = {
  shortcuts_status: shortcutsStatus,
  shortcuts_restart: shortcutsStatus,
  shortcuts_probe: shortcutsStatus,
  shortcuts_set_swallow: shortcutsStatus,
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
  log_tail: () => ({ path: "~/Library/Logs/app.comma.desktop/comma.log", lines: LOG }),
  log_write: (args) => {
    console.info(`[mock log] ${String(args.scope)}: ${String(args.message)}`);
    return null;
  },
  app_restart: () => {
    window.location.reload();
    return null;
  },
  account_credits: () => ({ plan: "free", period_end: new Date(Date.now() + 3 * 86_400_000).toISOString(), used_seconds: 742, limit_seconds: 1800 }),
};
