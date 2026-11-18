import { toast } from "sonner";
import type { AppMode } from "@comma/shared/ipc";
import { Check, KeyRound, UserRound } from "@multica/ui/icons";
import { cn } from "@multica/ui/lib/utils";
import { useSettings, useUpdateSettings } from "../lib/queries";

const MODES: { value: AppMode; title: string; description: string; icon: typeof KeyRound }[] = [
  {
    value: "local",
    title: "Your own keys",
    description: "Comma calls ElevenLabs and your LLM directly. Keys stay in your Keychain.",
    icon: KeyRound,
  },
  {
    value: "account",
    title: "Comma account",
    description: "A Comma server holds the keys and runs each request. Sign in below.",
    icon: UserRound,
  },
];

export function ModeChoice({ className }: { className?: string }) {
  const { data } = useSettings();
  const update = useUpdateSettings();
  return (
    <div role="radiogroup" aria-label="How Comma runs" className={cn("grid grid-cols-2 gap-2.5", className)}>
      {MODES.map(({ value, title, description, icon: Icon }) => {
        const selected = data?.mode === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => update.mutate({ mode: value }, { onError: (e) => toast.error(e.message) })}
            className={cn(
              "relative flex flex-col gap-2 rounded-lg border p-3.5 text-left transition-[border-color,background-color,box-shadow] outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
              selected
                ? "border-foreground/30 bg-surface-selected ring-1 ring-foreground/10"
                : "border-border bg-surface hover:bg-surface-hover",
            )}
          >
            <span className="flex items-center justify-between">
              <Icon className="size-4.5 text-muted-foreground" />
              <span
                className={cn(
                  "flex size-4 items-center justify-center rounded-full border transition-colors",
                  selected ? "border-foreground bg-foreground text-background" : "border-input",
                )}
              >
                {selected ? <Check className="size-3" /> : null}
              </span>
            </span>
            <span className="text-body font-medium">{title}</span>
            <span className="text-label text-muted-foreground">{description}</span>
          </button>
        );
      })}
    </div>
  );
}
