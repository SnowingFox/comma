import { useState, type ReactNode } from "react";
import { AnimatePresence, motion, type Variants } from "motion/react";
import { toast } from "sonner";
import { Button } from "@multica/ui/components/ui/button";
import {
  Stepper,
  StepperIndicator,
  StepperItem,
  StepperNav,
  StepperSeparator,
  StepperTitle,
} from "@multica/ui/components/ui/stepper";
import { ArrowLeft, ArrowRight, Check } from "@multica/ui/icons";
import { cn } from "@multica/ui/lib/utils";
import { useLlmDraft, type LlmDraft } from "../../components/llm-fields";
import { inTauri, invoke } from "../../lib/ipc";
import { useUpdateSettings } from "../../lib/queries";
import { DoneStep, KeysStep, PermissionsStep, PLACEHOLDERS, PlaceholderStep, WelcomeStep } from "./steps";

type Phase = 1 | 2 | 3;
const PHASES: { phase: Phase; label: string }[] = [
  { phase: 1, label: "Set up" },
  { phase: 2, label: "Try it" },
  { phase: 3, label: "Done" },
];

type StepDef = {
  id: string;
  phase: Phase;
  primary: string;
  render: (ctx: { llm: LlmDraft }) => ReactNode;
};

/** Spec 2.4, in order. Shortcut test, microphone test and Try it are placeholders in phase 1. */
const STEPS: StepDef[] = [
  { id: "welcome", phase: 1, primary: "Get started", render: () => <WelcomeStep /> },
  { id: "keys", phase: 1, primary: "Continue", render: ({ llm }) => <KeysStep llm={llm} /> },
  { id: "permissions", phase: 1, primary: "Continue", render: () => <PermissionsStep /> },
  { id: "shortcut", phase: 1, primary: "Continue", render: () => <PlaceholderStep {...PLACEHOLDERS.shortcut} /> },
  { id: "microphone", phase: 1, primary: "Continue", render: () => <PlaceholderStep {...PLACEHOLDERS.microphone} /> },
  { id: "try", phase: 2, primary: "Continue", render: () => <PlaceholderStep {...PLACEHOLDERS.try} /> },
  { id: "done", phase: 3, primary: "Open Comma", render: () => <DoneStep /> },
];

/** Slide 24 px and fade, 200 ms. MotionConfig drops the slide under reduced motion. */
const variants: Variants = {
  enter: (dir: number) => ({ x: 24 * dir, opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit: (dir: number) => ({ x: -24 * dir, opacity: 0 }),
};

export function OnboardingApp() {
  const [[index, dir], setPos] = useState<[number, number]>([0, 1]);
  const [busy, setBusy] = useState(false);
  const llm = useLlmDraft();
  const update = useUpdateSettings();
  const step = STEPS[index]!;
  const last = index === STEPS.length - 1;

  const go = (next: number) => setPos(([i]) => [next, next > i ? 1 : -1]);

  const finish = async () => {
    await update.mutateAsync({ onboarding_completed: true });
    if (!inTauri) {
      window.location.href = "/hub.html";
      return;
    }
    await invoke("window_show", { label: "hub" });
    await invoke("window_hide", { label: "onboarding" });
  };

  const primary = async () => {
    setBusy(true);
    try {
      if (step.id === "keys" && !(await llm.save())) {
        toast.error(llm.urlError ?? "Check the LLM settings");
        return;
      }
      if (last) await finish();
      else go(index + 1);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col bg-background">
      <header data-tauri-drag-region className="flex h-16 shrink-0 items-center justify-center">
        <Stepper value={step.phase} className="w-auto">
          <StepperNav className="w-[340px]">
            {PHASES.map(({ phase, label }) => (
              <StepperItem key={phase} step={phase} className="gap-2">
                <StepperIndicator className="size-5 text-micro transition-colors">
                  {phase < step.phase ? <Check className="size-3" /> : phase}
                </StepperIndicator>
                <StepperTitle
                  className={cn(
                    "text-label whitespace-nowrap transition-colors",
                    phase === step.phase ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {label}
                </StepperTitle>
                {phase < 3 ? <StepperSeparator className="mx-2 h-px! group-data-[state=completed]/step:bg-primary" /> : null}
              </StepperItem>
            ))}
          </StepperNav>
        </Stepper>
      </header>

      <main className="relative min-h-0 flex-1 overflow-hidden">
        <AnimatePresence initial={false} custom={dir}>
          <motion.div
            key={step.id}
            custom={dir}
            variants={variants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
            className="absolute inset-0 overflow-y-auto pb-4"
            aria-live="polite"
          >
            {step.render({ llm })}
          </motion.div>
        </AnimatePresence>
      </main>

      <footer className="flex h-[72px] shrink-0 items-center justify-between border-t border-border px-8">
        <div className="w-32">
          {index > 0 ? (
            <Button variant="ghost" onClick={() => go(index - 1)} disabled={busy}>
              <ArrowLeft />
              Back
            </Button>
          ) : null}
        </div>
        <ol className="flex items-center gap-1.5" aria-label={`Step ${index + 1} of ${STEPS.length}`}>
          {STEPS.map((s, i) => (
            <li
              key={s.id}
              className={cn(
                "h-1.5 rounded-full transition-all duration-200",
                i === index ? "w-5 bg-foreground" : i < index ? "w-1.5 bg-foreground/40" : "w-1.5 bg-border",
              )}
            />
          ))}
        </ol>
        <div className="flex w-32 justify-end">
          <Button size="lg" onClick={() => void primary()} disabled={busy}>
            {step.primary}
            {last ? null : <ArrowRight />}
          </Button>
        </div>
      </footer>
    </div>
  );
}
