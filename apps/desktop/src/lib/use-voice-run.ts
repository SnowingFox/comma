import { useCallback, useEffect, useRef, useState } from "react";
import { match } from "ts-pattern";
import type { RunMode, RunResult } from "@comma/shared/ipc";
import { encodeClip, Recorder } from "./audio/recorder";
import { errorMessage, inTauri, invoke, IpcError } from "./ipc";
import { useSettings } from "./queries";
import { useShortcutHold } from "./shortcut";
import { useCaptureShortcuts, useShortcutEvents } from "./shortcut-events";

export type VoicePhase =
  | { kind: "idle" }
  | { kind: "recording"; startedAt: number; handsFree: boolean }
  | { kind: "processing" }
  | { kind: "done"; result: RunResult }
  /** Silence or a press too short to hold speech: a soft note, not an error (spec 2.1). */
  | { kind: "empty"; message: string }
  | { kind: "error"; message: string };

export type RunContext = { selected_text?: string; target_language?: string };

const MAX_SECS = 120;
/** Peak below this (about -46 dBFS) is treated as silence. */
export const SILENCE_PEAK = 0.005;
export const MIN_SECS = 0.3;

/**
 * Try-it runs inside the onboarding window. The real shortcuts drive it: while this window is
 * focused, Rust sends the shortcut events here instead of the bar. The microphone is open only
 * while recording; the clip goes through `pipeline_run` (your keys or the Comma account) and is
 * never pasted. Esc cancels.
 */
export function useVoiceRun({
  mode,
  accel,
  enabled = true,
  context,
}: {
  mode: RunMode;
  /** Only for the in-browser dev stand-in; the app uses the configured shortcuts. */
  accel: string;
  enabled?: boolean;
  /** Read when recording starts: the selection for Ask Anything, the target for Translate. */
  context?: () => RunContext;
}) {
  const [phase, setPhase] = useState<VoicePhase>({ kind: "idle" });
  const [level, setLevel] = useState(0);
  const recorder = useRef<Recorder | null>(null);
  const opening = useRef<Promise<void> | null>(null);
  const stopRequested = useRef(false);
  const ctx = useRef<RunContext>({});
  const startedAt = useRef(0);
  const generation = useRef(0);
  const contextFn = useRef(context);
  contextFn.current = context;
  const microphoneId = useSettings().data?.audio.microphone_id || undefined;
  useCaptureShortcuts(enabled);

  const close = useCallback(() => {
    recorder.current?.close();
    recorder.current = null;
    setLevel(0);
  }, []);

  const finish = useCallback(async () => {
    const rec = recorder.current;
    if (!rec) return;
    const run = generation.current;
    const recordMs = Date.now() - startedAt.current;
    const { samples, peak } = rec.stopSamples();
    close();
    const secs = samples.length / 16_000;
    if (secs < MIN_SECS || peak < SILENCE_PEAK) {
      setPhase({ kind: "empty", message: secs < MIN_SECS ? "Hold the keys while you speak" : "Didn't catch that. Try speaking a little louder" });
      return;
    }
    setPhase({ kind: "processing" });
    try {
      const clip = await encodeClip(samples);
      const result = await invoke("pipeline_run", {
        mode,
        audio_base64: clip.base64,
        audio_secs: clip.durationSecs,
        source: "onboarding",
        record_ms: Math.max(0, recordMs),
        ...(ctx.current.selected_text ? { selected_text: ctx.current.selected_text } : {}),
        ...(ctx.current.target_language ? { target_language: ctx.current.target_language } : {}),
      });
      if (run !== generation.current) return;
      setPhase({ kind: "done", result });
    } catch (err) {
      if (run !== generation.current) return;
      if (err instanceof IpcError && err.code === "no_speech") setPhase({ kind: "empty", message: "Didn't catch that" });
      else if (err instanceof IpcError && err.code === "cancelled") setPhase({ kind: "idle" });
      else setPhase({ kind: "error", message: errorMessage(err) });
    }
  }, [close, mode]);

  const start = useCallback(() => {
    if (recorder.current || opening.current) return;
    generation.current += 1;
    stopRequested.current = false;
    ctx.current = contextFn.current?.() ?? {};
    startedAt.current = Date.now();
    setPhase({ kind: "recording", startedAt: Date.now(), handsFree: false });
    opening.current = Recorder.open(microphoneId)
      .then((rec) => {
        recorder.current = rec;
        rec.onLevel = setLevel;
        rec.start();
        if (stopRequested.current) void finish();
      })
      .catch((err: unknown) => {
        setPhase({
          kind: "error",
          message:
            err instanceof DOMException && err.name === "NotAllowedError"
              ? "Comma can't use the microphone. Allow it in the Permissions step"
              : errorMessage(err),
        });
      })
      .finally(() => {
        opening.current = null;
      });
  }, [finish, microphoneId]);

  const stop = useCallback(() => {
    if (opening.current) {
      stopRequested.current = true;
      return;
    }
    void finish();
  }, [finish]);

  const cancel = useCallback(() => {
    generation.current += 1;
    stopRequested.current = false;
    close();
    setPhase({ kind: "idle" });
    void invoke("pipeline_cancel").catch(() => {});
  }, [close]);

  const recording = phase.kind === "recording";
  const busy = phase.kind === "processing";

  // The real shortcuts, from Rust. Any mode's shortcut starts a run of this step's mode.
  useShortcutEvents(
    {
      onDown: () => !busy && start(),
      onUp: () => stop(),
      onCancel: () => cancel(),
      onSwitch: (_mode, handsFree) => setPhase((p) => (p.kind === "recording" ? { ...p, handsFree } : p)),
    },
    enabled && inTauri,
  );

  // In a plain browser (dev), the window's own key events stand in for the shortcut.
  const toggle = mode === "ask";
  const held = useShortcutHold(accel.startsWith("Fn") ? "" : accel, {
    enabled: enabled && !inTauri,
    onDown: () => (toggle && recording ? stop() : start()),
    onUp: () => (toggle ? undefined : stop()),
  });

  // Esc cancels in the browser; a long recording stops by itself.
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && cancel();
    if (!inTauri) window.addEventListener("keydown", onKey);
    const limit = setTimeout(stop, MAX_SECS * 1000);
    return () => {
      window.removeEventListener("keydown", onKey);
      clearTimeout(limit);
    };
  }, [recording, cancel, stop]);

  useEffect(() => () => cancel(), [cancel]);

  return {
    phase,
    level,
    held,
    busy: match(phase.kind)
      .with("processing", () => true)
      .otherwise(() => false),
    reset: cancel,
  };
}
