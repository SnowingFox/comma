import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion, type Transition } from "motion/react";
import type { BarState, RunMode } from "@comma/shared/ipc";
import { AlertCircle, Copy, CornerDownLeft, Globe, LockKeyhole, MessageCircleQuestion, Mic, X } from "@multica/ui/icons";
import { cn } from "@multica/ui/lib/utils";
import { createFakeLevel, Waveform, type LevelSource } from "./waveform";

/** The pill springs between shapes in about 220 ms (spec 2.1). */
const SPRING: Transition = { type: "spring", stiffness: 520, damping: 38, mass: 0.9 };
const FADE: Transition = { duration: 0.16, ease: "easeOut" };

type Shape = { width: number; height: number; radius: number };

function shapeFor(state: BarState, opts: { handsFree: boolean; doneLabel?: string; closing: boolean; message?: string }): Shape {
  if (opts.closing) return { width: 6, height: 6, radius: 3 };
  switch (state) {
    case "idle":
      return { width: 6, height: 6, radius: 3 };
    case "recording":
      return { width: opts.handsFree ? 204 : 184, height: 40, radius: 20 };
    case "processing":
      return { width: 184, height: 40, radius: 20 };
    case "done":
      return opts.doneLabel ? { width: 118, height: 40, radius: 20 } : { width: 40, height: 40, radius: 20 };
    case "empty":
      return { width: 176, height: 40, radius: 20 };
    case "error":
      // Wide enough for one line of most messages; the window is 460 px wide.
      return { width: Math.round(Math.min(440, Math.max(300, 150 + (opts.message?.length ?? 24) * 7.4))), height: 44, radius: 14 };
  }
}

const MODE_ICON = { dictate: Mic, ask: MessageCircleQuestion, translate: Globe } as const;

export type BarHint = {
  text: string;
  actions?: { label: string; primary?: boolean; onClick: () => void }[];
  onDismiss: () => void;
};

export type BarAnswer = { text: string; onCopy: () => void; onInsert: () => void; onClose: () => void };

export type BarViewProps = {
  state: BarState;
  mode?: RunMode;
  handsFree?: boolean;
  /** Error card or empty text, one line. */
  message?: string;
  /** Shown next to the check, e.g. "Copied". */
  doneLabel?: string;
  /** Target language code, shown while translating. */
  language?: string;
  /** Mic level; dev builds fall back to a fake signal. */
  level?: LevelSource;
  /** Bumped on cancel: a short shake, then the bar fades out. */
  shake?: number;
  /** The pill is shrinking back to the dot (after done, empty or cancel). */
  closing?: boolean;
  hint?: BarHint | null;
  answer?: BarAnswer | null;
  onDetails?: () => void;
  onContextMenu?: () => void;
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

const SURFACE = "bg-[oklch(0.2_0.006_286/0.94)] text-white shadow-[0_6px_20px_rgb(0_0_0/0.28),0_1px_3px_rgb(0_0_0/0.2)] ring-1 ring-white/12";

function HintBubble({ hint }: { hint: BarHint }) {
  return (
    <motion.div
      role="status"
      initial={{ opacity: 0, y: 6, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 4 }}
      transition={{ type: "spring", stiffness: 460, damping: 34 }}
      className={cn("flex max-w-[420px] items-center gap-2 rounded-[14px] py-1.5 pr-1.5 pl-3.5", SURFACE)}
    >
      <span className="min-w-0 flex-1 text-label leading-snug text-white/90">{hint.text}</span>
      {hint.actions?.map((a) => (
        <button
          key={a.label}
          type="button"
          onClick={a.onClick}
          className={cn(
            "h-7 shrink-0 rounded-[9px] px-2.5 text-label font-medium transition-colors",
            a.primary ? "bg-white text-[oklch(0.2_0.006_286)] hover:bg-white/90" : "bg-white/10 text-white hover:bg-white/18",
          )}
        >
          {a.label}
        </button>
      ))}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={hint.onDismiss}
        className="flex size-7 shrink-0 items-center justify-center rounded-[9px] text-white/60 transition-colors hover:bg-white/10 hover:text-white"
      >
        <X className="size-3.5" />
      </button>
    </motion.div>
  );
}

function AnswerCard({ answer }: { answer: BarAnswer }) {
  return (
    <motion.div
      role="dialog"
      aria-label="Answer"
      initial={{ opacity: 0, y: 10, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 6 }}
      transition={{ type: "spring", stiffness: 420, damping: 32 }}
      className={cn("flex w-[420px] flex-col gap-2 rounded-2xl p-3.5", SURFACE)}
    >
      <p className="selectable scrollbar-slim max-h-48 overflow-y-auto pr-1 text-body leading-relaxed whitespace-pre-wrap text-white/95">{answer.text}</p>
      <div className="flex items-center justify-end gap-1.5">
        <span className="mr-auto text-caption text-white/45">Esc closes</span>
        {(
          [
            { label: "Copy", icon: Copy, onClick: answer.onCopy },
            { label: "Insert", icon: CornerDownLeft, onClick: answer.onInsert },
            { label: "Close", icon: X, onClick: answer.onClose },
          ] as const
        ).map(({ label, icon: Icon, onClick }) => (
          <button
            key={label}
            type="button"
            onClick={onClick}
            className="flex h-7 items-center gap-1.5 rounded-[9px] bg-white/10 px-2.5 text-label font-medium text-white transition-colors hover:bg-white/18 [&_svg]:size-3.5"
          >
            <Icon />
            {label}
          </button>
        ))}
      </div>
    </motion.div>
  );
}

export function BarView({
  state,
  mode = "dictate",
  handsFree = false,
  message,
  doneLabel,
  language = "EN",
  level,
  shake = 0,
  closing = false,
  hint,
  answer,
  onDetails,
  onContextMenu,
}: BarViewProps) {
  const reduced = useReducedMotion();
  const shape = shapeFor(state, { handsFree, doneLabel, closing, message });
  const fallbackLevel = useMemo(() => (import.meta.env.DEV ? createFakeLevel() : undefined), []);
  const recordingFor = useElapsed(state === "recording");
  const processingFor = useElapsed(state === "processing");
  const ModeIcon = MODE_ICON[mode];
  const idle = state === "idle" || closing;

  return (
    <div className="flex h-full w-full flex-col items-center justify-end gap-2 pb-3">
      <AnimatePresence>{answer ? <AnswerCard key="answer" answer={answer} /> : null}</AnimatePresence>
      <AnimatePresence>{hint && !answer ? <HintBubble key={hint.text} hint={hint} /> : null}</AnimatePresence>
      <motion.div
        role="status"
        aria-live="polite"
        aria-label={state === "error" ? message : `Comma: ${state}`}
        initial={false}
        animate={{
          width: shape.width,
          height: shape.height,
          borderRadius: shape.radius,
          x: shake && !reduced ? [0, -7, 6, -4, 3, 0] : 0,
          opacity: closing && state !== "idle" ? 0 : 1,
        }}
        transition={{ ...SPRING, x: { duration: 0.3, ease: "easeOut" }, opacity: { duration: 0.2, delay: shake ? 0.25 : 0.1 } }}
        key={`pill-${shake}`}
        onContextMenu={(e) => {
          e.preventDefault();
          onContextMenu?.();
        }}
        className={cn(
          "relative shrink-0 overflow-hidden",
          SURFACE,
          idle && "bg-[oklch(0.2_0.006_286/0.7)] shadow-none ring-white/50",
        )}
      >
        <AnimatePresence initial={false}>
          {state === "recording" && !closing ? (
            <Fade key="recording" id="recording" className="justify-between gap-2 px-3">
              <span className="flex w-12 items-center gap-1 text-white/80">
                <ModeIcon className="size-4" />
                {mode === "translate" ? <span className="text-micro font-semibold tracking-wide">{language}</span> : null}
                {handsFree ? (
                  <motion.span initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={SPRING} title="Hands-free">
                    <LockKeyhole className="size-3.5 text-white/90" />
                  </motion.span>
                ) : null}
              </span>
              <Waveform level={level ?? fallbackLevel} />
              <span className="w-12 text-right font-mono text-caption text-white/70 tabular-nums">
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

          {state === "processing" && !closing ? (
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

          {state === "done" && !closing ? (
            <Fade key="done" id="done" className="justify-center gap-1.5">
              <svg viewBox="0 0 24 24" className="size-5 shrink-0" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <motion.path d="M5 12.5l4.2 4.2L19 7" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.28, ease: "easeOut", delay: 0.06 }} />
              </svg>
              {doneLabel ? <span className="text-label font-medium whitespace-nowrap text-white/90">{doneLabel}</span> : null}
            </Fade>
          ) : null}

          {state === "empty" && !closing ? (
            <Fade key="empty" id="empty" className="justify-center px-4">
              <span className="text-label whitespace-nowrap text-white/75">{message ?? "Didn't catch that"}</span>
            </Fade>
          ) : null}

          {state === "error" && !closing ? (
            <Fade key="error" id="error" className="gap-2.5 pr-1.5 pl-3.5">
              <AlertCircle className="size-4 shrink-0 text-[oklch(0.74_0.17_25)]" />
              <span className="min-w-0 flex-1 truncate text-label text-white/90" title={message}>
                {message ?? "Something went wrong"}
              </span>
              {onDetails ? (
                <button
                  type="button"
                  onClick={onDetails}
                  className="h-7 shrink-0 rounded-[9px] bg-white/10 px-2.5 text-label font-medium text-white transition-colors hover:bg-white/18"
                >
                  Details
                </button>
              ) : null}
            </Fade>
          ) : null}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}
