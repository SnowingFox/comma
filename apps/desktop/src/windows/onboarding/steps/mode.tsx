import { toast } from "sonner";
import type { AppMode } from "@comma/shared/ipc";
import { Check, KeyRound, UserRound } from "@multica/ui/icons";
import { cn } from "@multica/ui/lib/utils";
import { errorMessage } from "../../../lib/ipc";
import { useSettings, useUpdateSettings } from "../../../lib/queries";
import { useStepControls } from "../flow";
import { ModeIllustration } from "../illustrations";
import { Split } from "./layout";

const OPTIONS: { value: AppMode; title: string; body: string; icon: typeof KeyRound }[] = [
  {
    value: "local",
    title: "Local, with your own keys",
    body: "Your Mac calls ElevenLabs and your language model directly. Keys stay in your Keychain.",
    icon: KeyRound,
  },
  {
    value: "account",
    title: "Comma account",
    body: "Sign in to a Comma server, which holds the keys and runs each request. You can host your own.",
    icon: UserRound,
  },
];

export function ModeStep() {
  const mode = useSettings().data?.mode ?? "local";
  const update = useUpdateSettings();
  useStepControls({});

  return (
    <Split title="How should Comma run?" lead="You can switch later in Settings." art={<ModeIllustration mode={mode} />}>
      <div role="radiogroup" aria-label="How Comma runs" className="flex flex-col gap-2.5">
        {OPTIONS.map(({ value, title, body, icon: Icon }) => {
          const selected = mode === value;
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => update.mutate({ mode: value }, { onError: (e) => toast.error(errorMessage(e)) })}
              className={cn(
                "flex items-start gap-3 rounded-xl border p-4 text-left transition-[border-color,background-color,box-shadow] outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                selected ? "border-foreground/30 bg-surface-selected ring-1 ring-foreground/10" : "border-border bg-surface hover:bg-surface-hover",
              )}
            >
              <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <Icon className="size-4" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="text-body font-medium">{title}</span>
                <span className="text-label text-muted-foreground">{body}</span>
              </span>
              <span
                className={cn(
                  "mt-1 flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors",
                  selected ? "border-foreground bg-foreground text-background" : "border-input",
                )}
              >
                {selected ? <Check className="size-3" /> : null}
              </span>
            </button>
          );
        })}
      </div>
    </Split>
  );
}
