import type { OnboardingStep } from "@comma/shared/ipc";
import { emitTo, inTauri, invoke } from "./ipc";
import { queryClient, queryKeys } from "./queries";

/** Opens the onboarding window at `step` (the first one by default), from Settings. */
export async function openSetup(step: OnboardingStep = "welcome") {
  const settings = await invoke("settings_set", { patch: { onboarding_step: step } });
  queryClient.setQueryData(queryKeys.settings, settings);
  if (!inTauri) {
    window.location.href = "/onboarding.html";
    return;
  }
  await emitTo("onboarding", "onboarding://restart", { step });
  await invoke("window_show", { label: "onboarding" });
}
