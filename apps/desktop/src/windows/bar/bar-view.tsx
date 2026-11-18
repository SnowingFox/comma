import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AnimatePresence, motion, type Transition } from "motion/react";
import type { BarState, RunMode } from "@comma/shared/ipc";
import { AlertCircle, Globe, MessageCircleQuestion, Mic } from "@multica/ui/icons";
import { cn } from "@multica/ui/lib/utils";
import { createFakeLevel, Waveform, type LevelSource } from "./waveform";

/** The pill springs between shapes in about 220 ms (spec 2.1). */
const SPRING: Transition = { type: "spring", stiffness: 520, damping: 38, mass: 0.9 };
const FADE: Transition = { duration: 0.16, ease: "easeOut" };

const SHAPES: Record<BarState, { width: number; height: number; radius: number }> = {
  idle: { width: 6, height: 6, radius: 3 },
  recording: { width: 184, height: 40, radius: 20 },
  processing: { width: 184, height: 40, radius: 20 },
  done: { width: 40, height: 40, radius: 20 },
  empty: { width: 184, height: 40, radius: 20 },
  error: { width: 336, height: 44, radius: 14 },
};

const MODE_ICON = { dictate: Mic, ask: MessageCircleQuestion, translate: Globe } as const;

export type BarViewProps = {
  state: BarState;
  mode?: RunMode;
  /** Error card text, one line. */
  message?: string;
  /** Shown while translating. */
  language?: string;
  /** Mic level; dev builds fall back to a fake signal. */
  level?: LevelSource;
  onDetails?: () => void;
};

/** Seconds since `active` last became true, ticking four times a second. */
function useElapsed(active: boolean) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!active) return;
    const start = performance.now();
    setElapsed(0);
    const id = setInterval(() => setElapsed((performance.now() - start) / 1000), 250);
    return () => clearInterval(id);
  }, [active]);
  return active ? elapsed : 0;
}

function formatTime(secs: number) {
  const s = Math.floor(secs);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function Fade({ id, children, className }: { id: string; children: ReactNode; className?: string }) {
  return (
    <motion.div
      key={id}
      initial={{ opacity: 0, scale: 0.92 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.92 }}
      transition={FADE}
      className={cn("absolute inset-0 flex items-center", className)}
    >
      {children}
    </motion.div>
  );
}

export function BarView({ state, mode = "dictate", message, language = "ES", level, onDetails }: BarViewProps) {
  const shape = SHAPES[state];
  const fallbackLevel = useMemo(() => (import.meta.env.DEV ? createFakeLevel() : undefined), []);
  const recordingFor = useElapsed(state === "recording");
  const processingFor = useElapsed(state === "processing");
  const ModeIcon = MODE_ICON[mode];

  return (
    <div className="flex h-full w-full items-center justify-center">
      <motion.div
        role="status"
        aria-live="polite"
        aria-label={state === "error" ? message : `Comma: ${state}`}
        initial={false}
        animate={{ width: shape.width, height: shape.height, borderRadius: shape.radius }}
        transition={SPRING}
        className={cn(
          "relative overflow-hidden text-white",
          "bg-[oklch(0.2_0.006_286/0.94)] shadow-[0_6px_20px_rgb(0_0_0/0.28),0_1px_3px_rgb(0_0_0/0.2)] ring-1 ring-white/12",
          state === "idle" && "bg-[oklch(0.2_0.006_286/0.7)] shadow-none ring-white/50",
        )}
      >
        <AnimatePresence initial={false}>
          {state === "recording" ? (
            <Fade key="recording" id="recording" className="justify-between gap-2 px-3">
              <span className="flex w-10 items-center gap-1 text-white/80">
                <ModeIcon className="size-4" />
                {mode === "translate" ? (
                  <span className="text-micro font-semibold tracking-wide">{language}</span>
                ) : null}
              </span>
              <Waveform level={level ?? fallbackLevel} />
              <span className="w-10 text-right font-mono text-caption text-white/70 tabular-nums">
                <AnimatePresence>
                  {recordingFor >= 3 ? (
                    <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                      {formatTime(recordingFor)}
                    </motion.span>
                  ) : null}
                </AnimatePresence>
              </span>
            </Fade>
          ) : null}

          {state === "processing" ? (
            <Fade key="processing" id="processing" className="justify-center gap-2.5 px-4">
              <motion.span
                layout
                initial={{ scaleX: 0.4, opacity: 0 }}
                animate={{ scaleX: 1, opacity: 1 }}
                transition={SPRING}
                className="relative h-[3px] overflow-hidden rounded-full bg-white/22"
                style={{ width: processingFor >= 2 ? 44 : 84 }}
              >
                <span className="bar-shimmer absolute inset-y-0 w-1/2 rounded-full bg-gradient-to-r from-transparent via-white to-transparent" />
              </motion.span>
              <AnimatePresence>
                {processingFor >= 2 ? (
                  <motion.span
                    layout
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.4 }}
                    className="text-label whitespace-nowrap text-white/70"
                  >
                    Still working
                  </motion.span>
                ) : null}
              </AnimatePresence>
            </Fade>
          ) : null}

          {state === "done" ? (
            <Fade key="done" id="done" className="justify-center">
              <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <motion.path
                  d="M5 12.5l4.2 4.2L19 7"
                  initial={{ pathLength: 0 }}
                  animate={{ pathLength: 1 }}
                  transition={{ duration: 0.28, ease: "easeOut", delay: 0.06 }}
                />
              </svg>
            </Fade>
          ) : null}

          {state === "error" ? (
            <Fade key="error" id="error" className="gap-2.5 pr-1.5 pl-3.5">
              <AlertCircle className="size-4 shrink-0 text-[oklch(0.74_0.17_25)]" />
              <span className="min-w-0 flex-1 truncate text-label text-white/90">{message ?? "Something went wrong"}</span>
              <button
                type="button"
                onClick={onDetails}
                className="h-7 shrink-0 rounded-[9px] bg-white/10 px-2.5 text-label font-medium text-white transition-colors hover:bg-white/18"
              >
                Details
              </button>
            </Fade>
          ) : null}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}
