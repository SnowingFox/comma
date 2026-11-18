import { useCallback, useEffect, useRef, useState } from "react";
import { match } from "ts-pattern";
import type { RefineResult, RunMode, Transcription } from "@comma/shared/ipc";
import { Recorder } from "./audio/recorder";
import { errorMessage, invoke } from "./ipc";
import { useShortcutHold } from "./shortcut";

export type VoicePhase =
  | { kind: "idle" }
  | { kind: "recording"; startedAt: number }
  | { kind: "transcribing" }
  | { kind: "refining"; raw: Transcription }
  | { kind: "done"; raw: Transcription; refined: RefineResult }
  /** Silence or a press too short to hold speech: a soft note, not an error (spec 2.1). */
  | { kind: "empty"; message: string }
  | { kind: "error"; message: string };

export type RunContext = { selected_text?: string; target_language?: string };

const MAX_SECS = 60;
/** Peak below this (about -46 dBFS) is treated as silence. */
const SILENCE_PEAK = 0.005;

/**
 * Try-it runs inside the onboarding window: the configured shortcut, held (or tapped twice for
 * Ask Anything), records from the microphone, then `stt_transcribe` and `refine_text` run.
 * The microphone is open only while recording. Esc cancels.
 */
export function useVoiceRun({
  mode,
  accel,
  toggle = false,
  enabled = true,
  context,
}: {
  mode: RunMode;
  accel: string;
  toggle?: boolean;
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
  const generation = useRef(0);
  const contextFn = useRef(context);
  contextFn.current = context;

  const close = useCallback(() => {
    recorder.current?.close();
    recorder.current = null;
    setLevel(0);
  }, []);

  const finish = useCallback(async () => {
    const rec = recorder.current;
    if (!rec) return;
    const run = generation.current;
    const clip = rec.stop();
    close();
    if (clip.durationSecs < 0.4 || clip.peak < SILENCE_PEAK) {
      setPhase({ kind: "empty", message: clip.durationSecs < 0.4 ? "Hold the keys while you speak" : "Didn't catch that. Try speaking a little louder" });
      return;
    }
    setPhase({ kind: "transcribing" });
    try {
      const raw = await invoke("stt_transcribe", { wav_base64: clip.wavBase64 });
      if (run !== generation.current) return;
      if (!raw.text.trim()) {
        setPhase({ kind: "empty", message: "Didn't catch that" });
        return;
      }
      setPhase({ kind: "refining", raw });
      const refined = await invoke("refine_text", { mode, text: raw.text, ...ctx.current });
      if (run !== generation.current) return;
      setPhase({ kind: "done", raw, refined });
    } catch (err) {
      if (run === generation.current) setPhase({ kind: "error", message: errorMessage(err) });
    }
  }, [close, mode]);

  const start = useCallback(() => {
    if (recorder.current || opening.current) return;
    generation.current += 1;
    stopRequested.current = false;
    ctx.current = contextFn.current?.() ?? {};
    setPhase({ kind: "recording", startedAt: Date.now() });
    opening.current = Recorder.open()
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
  }, [finish]);

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
  }, [close]);

  const recording = phase.kind === "recording";
  const held = useShortcutHold(accel, {
    enabled,
    onDown: () => (toggle && recording ? stop() : start()),
    onUp: () => (toggle ? undefined : stop()),
  });

  // Esc cancels a recording; a long one stops by itself.
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && cancel();
    window.addEventListener("keydown", onKey);
    const limit = setTimeout(stop, MAX_SECS * 1000);
    return () => {
      window.removeEventListener("keydown", onKey);
      clearTimeout(limit);
    };
  }, [recording, cancel, stop]);

  useEffect(() => () => cancel(), [cancel]);

  const busy = match(phase.kind)
    .with("transcribing", "refining", () => true)
    .otherwise(() => false);

  return { phase, level, held, busy, reset: cancel };
}
