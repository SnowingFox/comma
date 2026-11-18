import { useCallback, useEffect, useRef, useState } from "react";
import { BarState, RunMode, type BarPreviewPayload, type HintKind, type RunResult } from "@comma/shared/ipc";
import { mountWindow } from "../../components/providers";
import { allowInputMonitoring } from "../../components/shortcut-notes";
import { OpusStream } from "../../lib/audio/ogg-opus";
import { encodeClip, listMicrophones, Recorder } from "../../lib/audio/recorder";
import { emitTo, errorMessage, inTauri, invoke, IpcError, listen } from "../../lib/ipc";
import { devtoolsEnabled } from "../../lib/devtool-store";
import { useSettings, useUpdateSettings } from "../../lib/queries";
import { acceleratorWords } from "../../lib/shortcut";
import { useSettingsSync, useShortcutEvents } from "../../lib/shortcut-events";
import { playTick } from "../../lib/sounds";
import { MIN_SECS, SILENCE_PEAK } from "../../lib/use-voice-run";
import { BarView, type BarAnswer, type BarHint } from "./bar-view";
import { betterMicrophone } from "./microphones";
import { createFakeLevel } from "./waveform";

/** Spec 2.1 timings. */
const DONE_MS = 600;
const EMPTY_MS = 1400;
const ERROR_MS = 4000;
const CLOSE_MS = 260;
const HINT_MS = 7000;
const MAX_RECORDING_MS = 6 * 60_000;

type View =
  | { state: "idle" }
  | { state: "recording"; mode: RunMode; handsFree: boolean }
  | { state: "processing"; mode: RunMode }
  | { state: "done"; label?: string }
  | { state: "empty"; message: string }
  | { state: "error"; message: string; runId?: string; settings?: string };

/** A line in the app log: states and error names only, never what was said. */
function logLine(level: "info" | "warn" | "error", message: string) {
  if (inTauri) void invoke("log_write", { level, scope: "bar", message }).catch(() => {});
}

/** The Settings section that fixes a `pipeline_check` failure. */
const FIX_SECTION: Record<string, string> = { missing_elevenlabs_key: "speech", missing_llm_model: "llm" };

/**
 * Dev: `bar.html?state=recording&mode=translate` opens straight into a state; `hands=1`, `done=Copied`,
 * `hint=<text>`, `actions=A,B` and `answer=<text>` add the rest of what the bar can show.
 */
function devInitial(): BarPreviewPayload | null {
  if (!import.meta.env.DEV || inTauri) return null;
  const params = new URLSearchParams(window.location.search);
  if (!params.get("state")) return null;
  return {
    state: BarState.catch("idle").parse(params.get("state")),
    mode: RunMode.catch("dictate").parse(params.get("mode")),
    message: params.get("message") ?? undefined,
    hands_free: params.get("hands") === "1",
    done_label: params.get("done") ?? undefined,
    hint: params.get("hint") ?? undefined,
    hint_actions: params.get("actions")?.split(","),
    answer: params.get("answer") ?? undefined,
  };
}

function useBarLoop() {
  const settings = useSettings().data;
  const update = useUpdateSettings();
  const [view, setView] = useState<View>({ state: "idle" });
  const [closing, setClosing] = useState(false);
  const [shake, setShake] = useState(0);
  const [hint, setHint] = useState<BarHint | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);
  const level = useRef(0);
  const recorder = useRef<Recorder | null>(null);
  /** Encodes while the user talks; null without WebCodecs Opus. */
  const encoder = useRef<OpusStream | null>(null);
  const opening = useRef<Promise<void> | null>(null);
  const stopRequested = useRef(false);
  const startedAt = useRef(0);
  const modeRef = useRef<RunMode>("dictate");
  const generation = useRef(0);
  const timers = useRef<number[]>([]);
  const hintTimer = useRef<number | undefined>(undefined);
  const lastErrorId = useRef<string | undefined>(undefined);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const viewRef = useRef(view);
  viewRef.current = view;

  const sounds = () => settingsRef.current?.feedback.sounds ?? true;
  const idleLayout = () => (settingsRef.current?.feedback.show_idle_bar ? "dot" : "hidden");

  const later = (ms: number, fn: () => void) => {
    timers.current.push(window.setTimeout(fn, ms));
  };
  const clearTimers = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };

  const layout = useCallback((l: "hidden" | "dot" | "full", interactive: boolean, escape = false) => {
    if (inTauri) void invoke("bar_layout", { layout: l, interactive, escape }).catch(() => {});
  }, []);

  /** Shrink to the dot (or away), then drop to the idle layout. */
  const settle = useCallback(() => {
    setClosing(true);
    later(CLOSE_MS, () => {
      setClosing(false);
      setView({ state: "idle" });
      if (!hintTimer.current) layout(idleLayout(), idleLayout() === "dot");
    });
  }, [layout]);

  const closeRecorder = (keepEncoder = false) => {
    recorder.current?.close();
    recorder.current = null;
    if (!keepEncoder) {
      encoder.current?.close();
      encoder.current = null;
    }
    level.current = 0;
  };

  const showHint = useCallback(
    (kind: HintKind, extra?: { device?: { id: string; label: string } }) => {
      const s = settingsRef.current;
      const dictate = s?.shortcuts.dictate ?? "Fn";
      const dismiss = () => {
        window.clearTimeout(hintTimer.current);
        hintTimer.current = undefined;
        setHint(null);
        if (viewRef.current.state === "idle") layout(idleLayout(), idleLayout() === "dot");
      };
      const openHub = (page: "settings", section: string) => {
        dismiss();
        void emitTo("hub", "hub://open", { page, section }).catch(() => {});
        void invoke("window_show", { label: "hub" }).catch(() => {});
      };
      const texts: Record<HintKind, Omit<BarHint, "onDismiss">> = {
        ask_hold: { text: "No need to hold. Press once, speak, press again." },
        hands_free: {
          text: dictate.startsWith("Fn") ? "Press Fn twice to keep talking hands-free." : `Press ${acceleratorWords(dictate)} twice to keep talking hands-free.`,
        },
        copied: { text: "Copied. Paste it with Cmd+V." },
        microphone: {
          text: `Switch to ${extra?.device?.label ?? "the other microphone"}?`,
          actions: [
            {
              label: "Switch",
              primary: true,
              onClick: () => {
                if (extra?.device) update.mutate({ audio: { microphone_id: extra.device.id } });
                dismiss();
              },
            },
            { label: "Not now", onClick: dismiss },
          ],
        },
        input_monitoring: {
          text: "Fn+Space and Esc need Input Monitoring.",
          actions: [{ label: "Allow", primary: true, onClick: () => void allowInputMonitoring().finally(dismiss) }],
        },
        relaunch: {
          text: "Relaunch Comma to finish turning on Input Monitoring.",
          actions: [
            { label: "Relaunch", primary: true, onClick: () => void invoke("app_restart").finally(dismiss) },
            { label: "Not now", onClick: dismiss },
          ],
        },
        accessibility: {
          text: "Comma needs Accessibility to paste. Until then it copies.",
          actions: [{ label: "Open Settings", primary: true, onClick: () => void invoke("open_settings_pane", { kind: "accessibility" }).finally(dismiss) }],
        },
        microphone_denied: {
          text: "Comma can't use the microphone.",
          actions: [{ label: "Open Settings", primary: true, onClick: () => void invoke("open_settings_pane", { kind: "microphone" }).finally(dismiss) }],
        },
        signed_out: {
          text: "You're signed out of Comma.",
          actions: [{ label: "Sign in", primary: true, onClick: () => openHub("settings", "general") }],
        },
      };
      window.clearTimeout(hintTimer.current);
      setHint({ ...texts[kind], onDismiss: dismiss });
      layout("full", true, viewRef.current.state === "recording");
      hintTimer.current = window.setTimeout(dismiss, HINT_MS);
    },
    [layout, update],
  );

  const fail = useCallback(
    (message: string, runId?: string, settings?: string) => {
      clearTimers();
      logLine("warn", `error card: ${runId ? `run ${runId}` : settings ? `needs settings > ${settings}` : "no run"}`);
      setView({ state: "error", message, runId, settings });
      layout("full", true);
      later(ERROR_MS, settle);
    },
    [layout, settle],
  );

  const process = useCallback(async () => {
    const rec = recorder.current;
    if (!rec) return;
    const run = generation.current;
    const recordMs = performance.now() - startedAt.current;
    const { samples, peak } = rec.stopSamples();
    const stream = encoder.current;
    encoder.current = null;
    closeRecorder(true);
    const mode = modeRef.current;
    const secs = samples.length / 16_000;
    if (secs < MIN_SECS || peak < SILENCE_PEAK) stream?.close();
    if (secs < MIN_SECS) {
      // A tap, not a dictation: go away quietly.
      settle();
      return;
    }
    if (peak < SILENCE_PEAK) {
      setView({ state: "empty", message: "Didn't catch that" });
      later(EMPTY_MS, settle);
      return;
    }
    setView({ state: "processing", mode });
    try {
      const clip = await encodeClip(samples, stream);
      const result: RunResult = await invoke("pipeline_run", {
        mode,
        audio_base64: clip.base64,
        audio_secs: clip.durationSecs,
        source: "bar",
        record_ms: Math.round(recordMs),
      });
      if (run !== generation.current) return;
      if (import.meta.env.DEV) console.info(`[bar] ${clip.format} ${clip.bytes} B in ${clip.encodeMs.toFixed(0)} ms, run ${result.total_ms} ms`);
      if (result.output === "answer") {
        setView({ state: "idle" });
        setAnswer(result.refined_text);
        layout("full", true, true);
        return;
      }
      if (sounds()) playTick("done");
      setView({ state: "done", label: result.output === "copied" ? "Copied" : undefined });
      if (result.hint) showHint(result.hint);
      later(result.output === "copied" ? DONE_MS * 2 : DONE_MS, settle);
    } catch (err) {
      if (run !== generation.current) return;
      const e = err instanceof IpcError ? err : undefined;
      if (e?.code === "no_speech") {
        setView({ state: "empty", message: "Didn't catch that" });
        later(EMPTY_MS, settle);
      } else if (e?.code === "cancelled") {
        settle();
      } else if (e?.reason === "signed_out") {
        settle();
        showHint("signed_out");
      } else {
        fail(errorMessage(err), lastErrorId.current);
      }
    }
  }, [fail, layout, settle, showHint]);

  const start = useCallback(
    (mode: RunMode) => {
      if (viewRef.current.state === "processing" || recorder.current || opening.current) return;
      clearTimers();
      setClosing(false);
      setAnswer(null);
      generation.current += 1;
      stopRequested.current = false;
      modeRef.current = mode;
      startedAt.current = performance.now();
      setView({ state: "recording", mode, handsFree: false });
      layout("full", !!hint, true);
      if (sounds()) playTick("start");
      const deviceId = settingsRef.current?.audio.microphone_id || undefined;
      const run = generation.current;
      // In parallel with opening the microphone: a missing key or session shows at once, not after
      // the recording (and a quick press still says what is wrong).
      void invoke("pipeline_check", { mode }).catch((err: unknown) => {
        if (run !== generation.current) return;
        generation.current += 1;
        closeRecorder();
        const e = err instanceof IpcError ? err : undefined;
        if (e?.reason === "signed_out") {
          settle();
          showHint("signed_out");
          return;
        }
        fail(errorMessage(err), undefined, e?.reason ? (FIX_SECTION[e.reason] ?? "general") : undefined);
      });
      const opened = Recorder.open(deviceId).catch((err: unknown) => {
        // A saved device that is gone falls back to the default one.
        if (deviceId && err instanceof DOMException && err.name === "OverconstrainedError") return Recorder.open();
        throw err;
      });
      opening.current = Promise.all([opened, OpusStream.create().catch(() => null)])
        .then(async ([rec, stream]) => {
          if (run !== generation.current) {
            // Cancelled while the microphone was opening.
            rec.close();
            stream?.close();
            return;
          }
          recorder.current = rec;
          encoder.current = stream;
          rec.onLevel = (l) => {
            level.current = l;
          };
          rec.onSamples = stream ? (s) => stream.push(s) : undefined;
          rec.start();
          if (stopRequested.current) void process();
          const better = betterMicrophone(rec.deviceLabel, await listMicrophones().catch(() => []));
          if (better && (await invoke("hint_take", { kind: "microphone" }).catch(() => false))) showHint("microphone", { device: better });
        })
        .catch((err: unknown) => {
          closeRecorder();
          logLine("warn", `microphone did not open: ${err instanceof DOMException ? err.name : "error"}`);
          if (run !== generation.current) return;
          if (err instanceof DOMException && err.name === "NotAllowedError") {
            settle();
            showHint("microphone_denied");
          } else {
            fail(errorMessage(err));
          }
        })
        .finally(() => {
          opening.current = null;
        });
      later(MAX_RECORDING_MS, () => void stop());
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fail, hint, layout, process, settle, showHint],
  );

  const stop = useCallback(() => {
    if (viewRef.current.state !== "recording") return;
    if (opening.current) {
      stopRequested.current = true;
      return;
    }
    void process();
  }, [process]);

  const cancel = useCallback((quiet = false) => {
    if (answer !== null) {
      setAnswer(null);
      settle();
      return;
    }
    const s = viewRef.current.state;
    if (s !== "recording" && s !== "processing") return;
    generation.current += 1;
    closeRecorder();
    if (s === "processing") void invoke("pipeline_cancel").catch(() => {});
    if (quiet) {
      // A tap, not a deliberate cancel: just go away.
      clearTimers();
      settle();
      return;
    }
    if (sounds()) playTick("cancel");
    setShake((n) => n + 1);
    clearTimers();
    later(80, settle);
  }, [answer, settle]);

  useShortcutEvents({
    onDown: start,
    onUp: stop,
    onCancel: (_mode, quiet) => cancel(quiet),
    onSwitch: (mode, handsFree) => {
      modeRef.current = mode;
      setView((v) => (v.state === "recording" ? { ...v, mode, handsFree } : v));
    },
  });

  // Hints from Rust (Ask held like Dictate, a permission to fix, signed out).
  useEffect(() => {
    const off = listen("bar://hint", (p) => showHint(p.kind));
    const offErr = listen("run://error", (p) => {
      lastErrorId.current = p.id;
    });
    return () => {
      void off.then((f) => f());
      void offErr.then((f) => f());
    };
  }, [showHint]);

  // The idle dot follows the setting.
  const showIdle = settings?.feedback.show_idle_bar;
  useEffect(() => {
    if (showIdle === undefined || viewRef.current.state !== "idle" || answer || hint) return;
    layout(showIdle ? "dot" : "hidden", !!showIdle);
  }, [showIdle, answer, hint, layout]);

  useEffect(() => () => closeRecorder(), []);

  const answerProps: BarAnswer | null = answer
    ? {
        text: answer,
        onCopy: () => {
          void invoke("clipboard_copy", { text: answer });
          setAnswer(null);
          settle();
        },
        onInsert: () => {
          const text = answer;
          setAnswer(null);
          layout(idleLayout(), false);
          void invoke("output_insert", { text }).then((out) => {
            if (out === "copied") showHint("copied");
          });
          settle();
        },
        onClose: () => {
          setAnswer(null);
          settle();
        },
      }
    : null;

  const targets = settings?.languages.translate_targets ?? [];
  return {
    view,
    closing,
    shake,
    hint,
    answer: answerProps,
    level: () => level.current,
    language: (targets[0] ?? "en").split("-")[0]!.toUpperCase(),
    detailsLabel: view.state === "error" && view.settings ? "Settings" : undefined,
    onDetails:
      view.state === "error"
        ? () => {
            const target = view.settings ? { page: "settings" as const, section: view.settings } : { page: "history" as const, section: view.runId };
            void emitTo("hub", "hub://open", target).catch(() => {});
            void invoke("window_show", { label: "hub" }).catch(() => {});
          }
        : undefined,
  };
}

function BarApp() {
  useSettingsSync();
  const loop = useBarLoop();
  const [preview, setPreview] = useState<BarPreviewPayload | null>(devInitial);
  const [previewLevel] = useState(createFakeLevel);

  // Previews from Settings > Developer and the devtool (dev builds, or with developer tools on).
  // An idle preview without a hint or answer gives the bar back to the dictation loop.
  useEffect(() => {
    const off = listen("bar://preview", (p) => {
      if (!import.meta.env.DEV && !devtoolsEnabled()) return;
      setPreview(p.state === "idle" && !p.hint && !p.answer ? null : p);
    });
    return () => void off.then((f) => f());
  }, []);

  if (preview) {
    const params = new URLSearchParams(window.location.search);
    const noop = () => {};
    return (
      <BarView
        state={preview.state}
        mode={preview.mode}
        message={preview.message ?? (preview.state === "error" ? "Couldn't reach ElevenLabs" : undefined)}
        handsFree={preview.hands_free}
        level={previewLevel}
        doneLabel={preview.done_label}
        language={params.get("lang") ?? undefined}
        hint={preview.hint ? { text: preview.hint, actions: preview.hint_actions?.map((label, i) => ({ label, primary: i === 0, onClick: noop })), onDismiss: noop } : null}
        answer={preview.answer ? { text: preview.answer, onCopy: noop, onInsert: noop, onClose: noop } : null}
        onDetails={preview.state === "error" ? noop : undefined}
      />
    );
  }
  const v = loop.view;
  return (
    <BarView
      state={v.state}
      mode={v.state === "recording" || v.state === "processing" ? v.mode : undefined}
      handsFree={v.state === "recording" && v.handsFree}
      message={v.state === "error" || v.state === "empty" ? v.message : undefined}
      doneLabel={v.state === "done" ? v.label : undefined}
      language={loop.language}
      level={loop.level}
      shake={loop.shake}
      closing={loop.closing}
      hint={loop.hint}
      answer={loop.answer}
      onDetails={loop.onDetails}
      detailsLabel={loop.detailsLabel}
      onContextMenu={() => void invoke("bar_menu").catch(() => {})}
    />
  );
}

mountWindow(<BarApp />, { toaster: false });
