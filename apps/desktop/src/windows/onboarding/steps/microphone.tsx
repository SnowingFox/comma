import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { match } from "ts-pattern";
import type { Transcription } from "@comma/shared/ipc";
import { Button } from "@multica/ui/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@multica/ui/components/ui/select";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { CircleAlert, Mic, Square } from "@multica/ui/icons";
import { cn } from "@multica/ui/lib/utils";
import { listMicrophones, Recorder } from "../../../lib/audio/recorder";
import { formatMs, formatSecs } from "../../../lib/format";
import { errorMessage, invoke } from "../../../lib/ipc";
import { detectedLanguageName } from "../../../lib/languages";
import { useSecretStatus } from "../../../lib/queries";
import { useFlow, useStepControls } from "../flow";
import { Split } from "./layout";

const MAX_SECS = 12;
const BARS = 28;

type Take =
  | { kind: "idle" }
  | { kind: "recording"; startedAt: number }
  | { kind: "transcribing" }
  | { kind: "done"; result: Transcription }
  | { kind: "silent" }
  | { kind: "error"; message: string };

/** Live level as a row of bars; the newest value enters on the right. */
function LevelMeter({ history, active }: { history: number[]; active: boolean }) {
  return (
    <div className="flex h-24 items-center justify-center gap-[3px]" aria-hidden>
      {history.map((v, i) => (
        <motion.span
          key={i}
          className={cn("w-1.5 rounded-full", active ? "bg-brand" : "bg-foreground/70")}
          animate={{ height: 6 + v * 84, opacity: 0.35 + v * 0.65 }}
          transition={{ duration: 0.08, ease: "linear" }}
        />
      ))}
    </div>
  );
}

export function MicrophoneStep() {
  const { goTo } = useFlow();
  const hasKey = useSecretStatus().data?.elevenlabs ?? false;
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string | undefined>();
  const [openError, setOpenError] = useState<string | null>(null);
  const [micReady, setMicReady] = useState(false);
  const [history, setHistory] = useState<number[]>(() => Array(BARS).fill(0));
  const [take, setTake] = useState<Take>({ kind: "idle" });
  const [elapsed, setElapsed] = useState(0);
  const recorder = useRef<Recorder | null>(null);
  const smoothed = useRef(0);
  useStepControls({});

  // The microphone stays open while this step is on screen, for the meter.
  useEffect(() => {
    let cancelled = false;
    let rec: Recorder | null = null;
    setOpenError(null);
    Recorder.open(deviceId)
      .then(async (r) => {
        if (cancelled) return r.close();
        rec = r;
        recorder.current = r;
        setMicReady(true);
        r.onLevel = (level) => {
          smoothed.current = smoothed.current * 0.5 + level * 0.5;
          setHistory((h) => [...h.slice(1), smoothed.current]);
        };
        const list = await listMicrophones();
        if (!cancelled) setDevices(list);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setOpenError(
          err instanceof DOMException && err.name === "NotAllowedError"
            ? "Comma can't use the microphone. Allow it in the Permissions step, then come back."
            : err instanceof DOMException && err.name === "NotFoundError"
              ? "No microphone found. Connect one and pick it below."
              : errorMessage(err),
        );
      });
    return () => {
      cancelled = true;
      setMicReady(false);
      rec?.close();
      recorder.current = null;
      setHistory(Array(BARS).fill(0));
    };
  }, [deviceId]);

  const stop = useCallback(async () => {
    const rec = recorder.current;
    if (!rec?.recording) return;
    const clip = rec.stop();
    if (clip.peak < 0.005 || clip.durationSecs < 0.4) {
      setTake({ kind: "silent" });
      return;
    }
    if (!hasKey) {
      setTake({ kind: "error", message: "The microphone works. Add an ElevenLabs key to see the transcript." });
      return;
    }
    setTake({ kind: "transcribing" });
    try {
      setTake({ kind: "done", result: await invoke("stt_transcribe", { wav_base64: clip.wavBase64 }) });
    } catch (err) {
      setTake({ kind: "error", message: errorMessage(err) });
    }
  }, [hasKey]);

  useEffect(() => {
    if (take.kind !== "recording") return;
    const tick = setInterval(() => setElapsed((Date.now() - take.startedAt) / 1000), 100);
    const limit = setTimeout(() => void stop(), MAX_SECS * 1000);
    return () => {
      clearInterval(tick);
      clearTimeout(limit);
    };
  }, [take, stop]);

  const record = () => {
    if (!recorder.current) return;
    recorder.current.start();
    setElapsed(0);
    setTake({ kind: "recording", startedAt: Date.now() });
  };

  const recording = take.kind === "recording";
  const current = devices.find((d) => d.deviceId === deviceId) ?? devices[0];
  const items = devices.map((d, i) => ({ value: d.deviceId, label: d.label || `Microphone ${i + 1}` }));

  return (
    <Split
      title="Check your microphone"
      lead="Pick a microphone, then say a sentence. The raw transcript appears under the meter, before any cleanup."
      art={
        <div className="flex w-full flex-col items-center gap-4">
          <LevelMeter history={history} active={recording} />
          <div className="min-h-24 w-full" aria-live="polite">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={take.kind}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.16 }}
                className="flex flex-col items-center gap-1.5 text-center"
              >
                {match(take)
                  .with({ kind: "idle" }, () => (
                    <p className="text-body text-muted-foreground">{openError ? "" : "Speak to see the meter move."}</p>
                  ))
                  .with({ kind: "recording" }, () => (
                    <p className="text-body font-medium tabular-nums">Listening… {formatSecs(elapsed)}</p>
                  ))
                  .with({ kind: "transcribing" }, () => (
                    <p className="flex items-center gap-2 text-body text-muted-foreground">
                      <Spinner className="size-3.5" /> Transcribing
                    </p>
                  ))
                  .with({ kind: "done" }, ({ result }) => (
                    <>
                      <p className="selectable text-body-lg text-pretty">“{result.text || "…"}”</p>
                      <p className="text-caption text-muted-foreground">
                        {detectedLanguageName(result.language_code)} · {formatMs(result.total_ms)}
                        {result.retried ? " · checked twice" : ""}
                      </p>
                    </>
                  ))
                  .with({ kind: "silent" }, () => <p className="text-body text-muted-foreground">Didn't catch that. Try a little louder.</p>)
                  .with({ kind: "error" }, ({ message }) => (
                    <p className="flex items-start gap-1.5 text-label text-destructive">
                      <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
                      <span className="selectable">{message}</span>
                    </p>
                  ))
                  .exhaustive()}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-1.5">
        <span className="text-label font-medium">Microphone</span>
        <Select items={items} value={current?.deviceId ?? ""} onValueChange={(v) => typeof v === "string" && setDeviceId(v)} disabled={items.length === 0}>
          <SelectTrigger className="w-full" aria-label="Microphone">
            <SelectValue placeholder={openError ? "Not available" : "Looking for microphones…"} />
          </SelectTrigger>
          <SelectContent>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {openError ? (
        <p className="flex items-start gap-1.5 text-label text-destructive">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          {openError}
        </p>
      ) : null}
      <div className="flex items-center gap-3">
        <Button size="lg" variant={recording ? "secondary" : "default"} onClick={() => (recording ? void stop() : record())} disabled={!micReady || take.kind === "transcribing"}>
          {recording ? <Square className="size-3.5 fill-current" /> : <Mic />}
          {recording ? "Stop" : take.kind === "done" ? "Try again" : "Say a sentence"}
        </Button>
        {!hasKey ? (
          <button type="button" className="text-label text-muted-foreground underline underline-offset-2" onClick={() => goTo("keys")}>
            Add an ElevenLabs key for the transcript
          </button>
        ) : null}
      </div>
    </Split>
  );
}
