import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { match } from "ts-pattern";
import type { AppMode, OnboardingStep } from "@comma/shared/ipc";

export type Phase = "setup" | "try" | "done";

export const PHASES: { phase: Phase; label: string }[] = [
  { phase: "setup", label: "Set up" },
  { phase: "try", label: "Try it" },
  { phase: "done", label: "Done" },
];

/** Spec 2.4: eleven steps in three phases. The account path signs in instead of entering keys. */
export function stepsFor(mode: AppMode): OnboardingStep[] {
  return [
    "welcome",
    "mode",
    mode === "account" ? "account" : "keys",
    "permissions",
    "languages",
    "microphone",
    "shortcut",
    "try_dictate",
    "try_ask",
    "try_translate",
    "done",
  ];
}

export function phaseOf(step: OnboardingStep): Phase {
  return match(step)
    .returnType<Phase>()
    .with("try_dictate", "try_ask", "try_translate", () => "try")
    .with("done", () => "done")
    .otherwise(() => "setup");
}

/** What a step lets the footer do. Unset fields keep the defaults (Continue, enabled). */
export type StepControls = {
  primaryLabel?: string;
  canContinue?: boolean;
  /** Runs before advancing; return false to stay. */
  beforeContinue?: () => Promise<boolean> | boolean;
  /** An extra button left of the primary one, e.g. "No" on the shortcut test. */
  secondary?: { label: string; onClick: () => void };
};

type FlowApi = {
  setControls: (controls: StepControls) => void;
  goTo: (step: OnboardingStep) => void;
  next: () => void;
};

const FlowContext = createContext<FlowApi | null>(null);

export function FlowProvider({ value, children }: { value: FlowApi; children: ReactNode }) {
  return <FlowContext.Provider value={value}>{children}</FlowContext.Provider>;
}

export function useFlow(): FlowApi {
  const flow = useContext(FlowContext);
  if (!flow) throw new Error("useFlow outside the onboarding flow");
  return flow;
}

/**
 * Registers the step's footer controls. `beforeContinue` and `secondary.onClick` are read through
 * a ref, so callers can pass fresh closures every render.
 */
export function useStepControls(controls: StepControls) {
  const { setControls } = useFlow();
  const latest = useRef(controls);
  latest.current = controls;
  const { primaryLabel, canContinue } = controls;
  const hasBefore = !!controls.beforeContinue;
  const secondaryLabel = controls.secondary?.label;
  useEffect(() => {
    setControls({
      primaryLabel,
      canContinue,
      beforeContinue: hasBefore ? () => latest.current.beforeContinue?.() ?? true : undefined,
      secondary: secondaryLabel ? { label: secondaryLabel, onClick: () => latest.current.secondary?.onClick() } : undefined,
    });
  }, [setControls, primaryLabel, canContinue, hasBefore, secondaryLabel]);
}
