import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSettingsSync } from "../../lib/shortcut-events";
import { AnimatePresence, motion, type Variants } from "motion/react";
import { toast } from "sonner";
import { match } from "ts-pattern";
import { DEFAULT_SETTINGS, OnboardingStep } from "@comma/shared/ipc";
import { Button } from "@multica/ui/components/ui/button";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { ArrowLeft, ArrowRight, Check } from "@multica/ui/icons";
import { cn } from "@multica/ui/lib/utils";
import { errorMessage, inTauri, invoke, listen } from "../../lib/ipc";
import { useSettings, useUpdateSettings } from "../../lib/queries";
import { FlowProvider, PHASES, phaseOf, stepsFor, type StepControls } from "./flow";
import { AccountStep } from "./steps/account";
import { DoneStep } from "./steps/done";
import { KeysStep } from "./steps/keys";
import { LanguagesStep } from "./steps/languages";
import { MicrophoneStep } from "./steps/microphone";
import { ModeStep } from "./steps/mode";
import { PermissionsStep } from "./steps/permissions";
import { ShortcutStep } from "./steps/shortcut";
import { TryAskStep, TryDictateStep, TryTranslateStep } from "./steps/try";
import { WelcomeStep } from "./steps/welcome";

/** Slide 24 px and fade, 200 ms ease-out. MotionConfig drops the slide under reduced motion. */
const variants: Variants = {
  enter: (dir: number) => ({ x: 24 * dir, opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit: (dir: number) => ({ x: -24 * dir, opacity: 0 }),
};

function renderStep(step: OnboardingStep) {
  return match(step)
    .with("welcome", () => <WelcomeStep />)
    .with("mode", () => <ModeStep />)
    .with("keys", () => <KeysStep />)
    .with("account", () => <AccountStep />)
    .with("permissions", () => <PermissionsStep />)
    .with("languages", () => <LanguagesStep />)
    .with("microphone", () => <MicrophoneStep />)
    .with("shortcut", () => <ShortcutStep />)
    .with("try_dictate", () => <TryDictateStep />)
    .with("try_ask", () => <TryAskStep />)
    .with("try_translate", () => <TryTranslateStep />)
    .with("done", () => <DoneStep />)
    .exhaustive();
}

export function OnboardingApp() {
  useSettingsSync();
  const settings = useSettings();
  if (!settings.data) {
    return (
      <div className="flex h-full items-center justify-center bg-background">
        <Spinner className="text-muted-foreground" />
      </div>
    );
  }
  return <Flow initialStep={settings.data.onboarding_step} />;
}

function Flow({ initialStep }: { initialStep: string }) {
  const mode = useSettings().data?.mode ?? DEFAULT_SETTINGS.mode;
  const update = useUpdateSettings();
  const steps = useMemo(() => stepsFor(mode), [mode]);

  // Resume at the last unfinished step (spec 2.4).
  const [[step, dir], setPos] = useState<[OnboardingStep, number]>(() => {
    const parsed = OnboardingStep.safeParse(initialStep);
    return [parsed.success && steps.includes(parsed.data) ? parsed.data : "welcome", 1];
  });
  const [controls, setControls] = useState<StepControls>({});
  const [busy, setBusy] = useState(false);
  const index = Math.max(0, steps.indexOf(step));
  const phase = phaseOf(step);
  const last = step === "done";

  const persist = useRef(update.mutate);
  persist.current = update.mutate;
  const current = useRef({ step, mode });
  current.current = { step, mode };

  const goTo = useCallback((target: OnboardingStep) => {
    const { step: from, mode: m } = current.current;
    if (from === target) return;
    const list = stepsFor(m);
    setControls({});
    persist.current({ onboarding_step: target });
    setPos([target, list.indexOf(target) >= list.indexOf(from) ? 1 : -1]);
  }, []);

  // The keys step and the account step swap when the mode changes on step 2.
  useEffect(() => {
    if (!steps.includes(step)) goTo(steps[2]!);
  }, [steps, step, goTo]);

  // Settings > Run setup again starts over.
  useEffect(() => {
    let stop: (() => void) | undefined;
    void listen("onboarding://restart", ({ step: target }) => {
      const parsed = OnboardingStep.safeParse(target);
      goTo(parsed.success ? parsed.data : "welcome");
    }).then((u) => (stop = u));
    return () => stop?.();
  }, [goTo]);

  const finish = async () => {
    await update.mutateAsync({ onboarding_completed: true, onboarding_step: "" });
    if (!inTauri) {
      window.location.href = "/hub.html";
      return;
    }
    await invoke("window_show", { label: "hub" });
    await invoke("window_hide", { label: "onboarding" });
    // The window stays loaded while hidden; a rerun from Settings starts at the top.
    setPos(["welcome", 1]);
  };

  const next = useCallback(() => {
    const following = steps[index + 1];
    if (following) goTo(following);
  }, [steps, index, goTo]);

  const primary = async () => {
    setBusy(true);
    try {
      if (controls.beforeContinue && !(await controls.beforeContinue())) return;
      if (last) await finish();
      else next();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const flow = useMemo(() => ({ setControls, goTo, next }), [goTo, next]);
  const progress = index / (steps.length - 1);

  return (
    <FlowProvider value={flow}>
      <div className="flex h-full flex-col bg-background">
        <header data-tauri-drag-region className="flex h-[68px] shrink-0 flex-col items-center justify-center gap-2.5 pt-1">
          <ol data-tauri-drag-region className="flex items-center gap-2" aria-label="Setup phases">
            {PHASES.map(({ phase: p, label }, i) => {
              const state = p === phase ? "active" : PHASES.findIndex((x) => x.phase === phase) > i ? "done" : "todo";
              return (
                <li key={p} className="flex items-center gap-2" aria-current={state === "active" ? "step" : undefined}>
                  {i > 0 ? <span className="text-faint-foreground" aria-hidden>›</span> : null}
                  <span
                    className={cn(
                      "flex items-center gap-1.5 text-label transition-colors duration-200",
                      state === "active" ? "font-medium text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {state === "done" ? <Check className="size-3.5 text-success" /> : null}
                    {label}
                  </span>
                </li>
              );
            })}
          </ol>
          <div
            className="h-[3px] w-[320px] overflow-hidden rounded-full bg-border"
            role="progressbar"
            aria-label={`Step ${index + 1} of ${steps.length}`}
            aria-valuemin={1}
            aria-valuemax={steps.length}
            aria-valuenow={index + 1}
          >
            <motion.div
              className="h-full rounded-full bg-foreground"
              initial={false}
              animate={{ width: `${Math.max(progress, 0.02) * 100}%` }}
              transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
            />
          </div>
        </header>

        <main className="relative min-h-0 flex-1 overflow-hidden">
          <AnimatePresence initial={false} custom={dir}>
            <motion.div
              key={step}
              custom={dir}
              variants={variants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.2, ease: "easeOut" }}
              className="scrollbar-slim absolute inset-0 overflow-y-auto"
            >
              {renderStep(step)}
            </motion.div>
          </AnimatePresence>
        </main>

        <footer className="relative flex h-[68px] shrink-0 items-center justify-between border-t border-border px-8">
          <div className="w-40">
            {index > 0 ? (
              <Button variant="ghost" onClick={() => goTo(steps[index - 1]!)} disabled={busy}>
                <ArrowLeft />
                Back
              </Button>
            ) : null}
          </div>
          <span className="absolute left-1/2 -translate-x-1/2 text-caption text-muted-foreground tabular-nums">
            {index + 1} of {steps.length}
          </span>
          <div className="flex min-w-40 items-center justify-end gap-2">
            {phase === "try" ? (
              <Button variant="ghost" onClick={next} disabled={busy}>
                Skip
              </Button>
            ) : null}
            {controls.secondary ? (
              <Button variant="outline" onClick={controls.secondary.onClick} disabled={busy}>
                {controls.secondary.label}
              </Button>
            ) : null}
            <Button size="lg" onClick={() => void primary()} disabled={busy || controls.canContinue === false}>
              {busy ? <Spinner className="size-4" /> : null}
              {controls.primaryLabel ?? (last ? "Open Comma" : "Continue")}
              {last || busy ? null : <ArrowRight />}
            </Button>
          </div>
        </footer>
      </div>
    </FlowProvider>
  );
}
