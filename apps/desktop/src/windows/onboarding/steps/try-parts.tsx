import type { ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { match } from "ts-pattern";
import { Button } from "@multica/ui/components/ui/button";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@multica/ui/components/ui/tabs";
import { CircleAlert, KeyRound } from "@multica/ui/icons";
import { cn } from "@multica/ui/lib/utils";
import { Keycaps } from "../../../components/keycaps";
import { formatMs } from "../../../lib/format";
import { useSecretStatus, useSettings, useUpdateSettings } from "../../../lib/queries";
import type { VoicePhase } from "../../../lib/use-voice-run";
import { useFlow } from "../flow";

/** Whether a try-it run can work here, and if not, why. */
export function useTryReady(): { ready: boolean; missing: "account" | "stt" | "llm" | null } {
  const settings = useSettings().data;
  const secrets = useSecretStatus().data;
  if (!settings || !secrets) return { ready: false, missing: null };
  if (settings.mode === "account") return { ready: true, missing: null };
  if (!secrets.elevenlabs) return { ready: false, missing: "stt" };
  if (!settings.llm.model) return { ready: false, missing: "llm" };
  return { ready: true, missing: null };
}

/** Shown instead of the sample when a key is missing. Skip stays available in the footer. */
export function NeedsKeys({ missing }: { missing: "account" | "stt" | "llm" }) {
  const { goTo } = useFlow();
  const update = useUpdateSettings();
  const text = match(missing)
    .with("stt", () => "Trying a mode needs an ElevenLabs key, so Comma can hear you.")
    .with("llm", () => "Trying a mode needs a language model, so Comma can clean up what you said.")
    .with("account", () => "Runs through a Comma server are not available in this version yet. Use your own keys to try the modes here.")
    .exhaustive();
  return (
    <div className="flex flex-col items-start gap-3 rounded-2xl border border-dashed border-border bg-surface/60 p-5">
      <span className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <KeyRound className="size-4.5" />
      </span>
      <p className="text-body">{text}</p>
      <p className="text-label text-muted-foreground">Go back to add it, or skip this step and try it later from the menu bar.</p>
      <Button
        variant="outline"
        onClick={() => (missing === "account" ? update.mutate({ mode: "local" }, { onSuccess: () => goTo("keys") }) : goTo("keys"))}
      >
        {missing === "account" ? "Use my own keys" : "Back to Keys"}
      </Button>
    </div>
  );
}

/** Ten bars from the live level, like the floating bar. */
function MiniWave({ level }: { level: number }) {
  const shape = [0.5, 0.8, 1, 0.7, 0.9, 0.6, 1, 0.75, 0.55, 0.85];
  return (
    <span className="flex h-5 items-center gap-[3px]" aria-hidden>
      {shape.map((s, i) => (
        <motion.span key={i} className="w-[3px] rounded-full bg-brand" animate={{ height: 4 + level * s * 16 }} transition={{ duration: 0.08 }} />
      ))}
    </span>
  );
}

/**
 * One line under the sample: what to press, what is happening, or what went wrong. `hold` is a
 * hold-to-talk mode (Dictate); otherwise `finish` names the key that finishes (Fn, spec 2.3.2) and
 * `listening` can say more while it records.
 */
export function RunStatus({
  phase,
  level,
  accel,
  hold = true,
  finish = "Fn",
  idle,
  listening,
}: {
  phase: VoicePhase;
  level: number;
  accel: string;
  hold?: boolean;
  finish?: string;
  idle?: ReactNode;
  listening?: string;
}) {
  const content = match(phase)
    .with({ kind: "idle" }, () => (
      <>
        <span>{hold ? "Hold" : "Press"}</span>
        <Keycaps accel={accel} size="sm" />
        <span>{idle ?? (hold ? "and speak, then let go." : `to start, then press ${finish} when you are done.`)}</span>
      </>
    ))
    .with({ kind: "recording" }, ({ handsFree }) => (
      <>
        <MiniWave level={level} />
        <span className="font-medium text-foreground">
          {hold && handsFree
            ? `Hands-free. Press ${finish} once more when you are done.`
            : hold
              ? "Listening. Let go when you are done."
              : handsFree || !listening
                ? `Listening. Press ${finish} when you are done.`
                : listening}
        </span>
        <span className="text-faint-foreground">Esc cancels</span>
      </>
    ))
    .with({ kind: "processing" }, () => (
      <>
        <Spinner className="size-3.5" />
        <span>Turning speech into text and cleaning it up…</span>
      </>
    ))
    .with({ kind: "done" }, ({ result }) => (
      <>
        <span className="text-success">Done.</span>
        <span>
          Speech {formatMs(result.stt_ms)}, rewrite {formatMs(result.llm_total_ms)}. Try again any time.
        </span>
      </>
    ))
    .with({ kind: "empty" }, ({ message }) => <span>{message}</span>)
    .with({ kind: "error" }, ({ message }) => (
      <span className="flex items-start gap-1.5 text-destructive">
        <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
        <span className="selectable">{message}</span>
      </span>
    ))
    .exhaustive();
  return (
    <div className="min-h-8" aria-live="polite">
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={phase.kind}
          initial={{ opacity: 0, y: 3 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.14 }}
          className="flex flex-wrap items-center gap-2 text-label text-muted-foreground"
        >
          {content}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

/**
 * Inserted text with a left-to-right highlight sweep (600 ms, spec 2.4). Under reduced motion the
 * highlight only fades.
 */
export function Sweep({ children, className, id }: { children: ReactNode; className?: string; id: string | number }) {
  const reduced = useReducedMotion();
  return (
    <span className={cn("relative", className)}>
      <motion.span
        key={id}
        aria-hidden
        className="pointer-events-none absolute -inset-x-0.5 -inset-y-px origin-left rounded-[3px] bg-brand/25 [box-decoration-break:clone]"
        initial={reduced ? { opacity: 1 } : { scaleX: 0, opacity: 1 }}
        animate={reduced ? { opacity: 0 } : { scaleX: [0, 1, 1], opacity: [1, 1, 0] }}
        transition={{ duration: reduced ? 0.6 : 1.1, times: reduced ? undefined : [0, 0.55, 1], ease: "easeOut" }}
      />
      <span className="relative">{children}</span>
    </span>
  );
}

/** Refined or raw, for comparing the cleanup with what was heard. */
export function RawToggle({ value, onChange }: { value: "refined" | "raw"; onChange: (v: "refined" | "raw") => void }) {
  return (
    <Tabs value={value} onValueChange={(v) => onChange(v === "raw" ? "raw" : "refined")}>
      <TabsList className="h-7">
        <TabsTrigger value="refined" className="px-2 text-caption">
          Refined
        </TabsTrigger>
        <TabsTrigger value="raw" className="px-2 text-caption">
          What you said
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}
