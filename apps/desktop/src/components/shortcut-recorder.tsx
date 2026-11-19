import { useEffect, useState } from "react";
import { toast } from "sonner";
import { DEFAULT_SHORTCUTS, FN_KEYS, isFnAccelerator, type ShortcutSettings } from "@comma/shared/ipc";
import { Button } from "@multica/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { cn } from "@multica/ui/lib/utils";
import { errorMessage, inTauri, invoke } from "../lib/ipc";
import { useSettings, useUpdateSettings } from "../lib/queries";
import { acceleratorFromEvent } from "../lib/shortcut";
import { useShortcutsStatus } from "../lib/shortcut-events";
import { Keycaps } from "./keycaps";

export const MODE_NAMES: Record<keyof ShortcutSettings, string> = {
  dictate: "Dictate",
  ask: "Ask Anything",
  translate: "Translate",
  paste_last: "Paste last result",
};

/** Fn shortcuts to choose from: Fn alone, then Fn with each key Comma's listener can match. */
const FN_CHOICES = ["Fn", ...FN_KEYS.map((k) => `Fn+${k}`)];

/**
 * Picks a new shortcut for one mode: an Fn shortcut from the list (the webview cannot see Fn), or
 * an ordinary combination pressed while the dialog is open. Paste last result takes an ordinary
 * combination only. Comma's own shortcuts are off while it
 * is open, so a combination already in use reaches the dialog. Only key events inside this window
 * are read.
 */
export function ShortcutRecorder({
  mode,
  open,
  onOpenChange,
}: {
  mode: keyof ShortcutSettings;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const settings = useSettings().data;
  const listener = useShortcutsStatus().data?.listener;
  const update = useUpdateSettings();
  const [captured, setCaptured] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setCaptured(null);
    if (inTauri) void invoke("shortcuts_suspend", { suspended: true }).catch(() => {});
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Escape" && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) return; // closes the dialog
      if ((e.target as HTMLElement | null)?.closest("button") && (e.code === "Space" || e.code === "Enter") && !e.altKey && !e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      e.stopPropagation();
      const accel = acceleratorFromEvent(e);
      if (accel) setCaptured(accel);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      if (inTauri) void invoke("shortcuts_suspend", { suspended: false }).catch(() => {});
    };
  }, [open]);

  const current = settings?.shortcuts[mode];
  const withFn = mode !== "paste_last";
  const takenBy = (accel: string) =>
    settings ? (Object.keys(MODE_NAMES) as (keyof ShortcutSettings)[]).find((m) => m !== mode && settings.shortcuts[m] === accel) : undefined;
  const taken = captured ? takenBy(captured) : undefined;

  const save = () => {
    if (!captured || taken) return;
    update.mutate(
      { shortcuts: { [mode]: captured } },
      {
        onSuccess: () => onOpenChange(false),
        onError: (err) => toast.error(errorMessage(err)),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New {MODE_NAMES[mode]} shortcut</DialogTitle>
          <DialogDescription>
            {withFn ? "Pick an Fn shortcut, or press" : "Press"} a combination with at least one of ⌃ ⌥ ⇧ ⌘. Your shortcuts are
            paused while this is open.
          </DialogDescription>
        </DialogHeader>
        <div className={cn("flex flex-col gap-2", !withFn && "hidden")}>
          <span className="text-label font-medium">With Fn</span>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Fn shortcuts">
            {FN_CHOICES.map((accel) => {
              const by = takenBy(accel);
              return (
                <button
                  key={accel}
                  type="button"
                  role="radio"
                  aria-checked={captured === accel}
                  disabled={!!by}
                  title={by ? `${MODE_NAMES[by]} uses this` : undefined}
                  onClick={() => setCaptured(accel)}
                  className={cn(
                    "rounded-lg border p-1 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40",
                    captured === accel ? "border-brand bg-brand/8" : "border-transparent hover:bg-muted",
                  )}
                >
                  <Keycaps accel={accel} size="sm" />
                </button>
              );
            })}
          </div>
          {listener === "fallback" ? (
            <p className="text-caption text-muted-foreground">
              Fn shortcuts work once Comma has Input Monitoring. Until then the ordinary fallback is used.
            </p>
          ) : null}
        </div>
        <div className="flex h-24 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-muted/40">
          {captured ? (
            <Keycaps accel={captured} size="md" />
          ) : (
            <span className="text-body text-muted-foreground">Or press the keys you want…</span>
          )}
          {taken ? <span className="text-caption text-destructive">{MODE_NAMES[taken]} already uses these keys</span> : null}
        </div>
        <DialogFooter className="sm:justify-between">
          <Button
            variant="ghost"
            disabled={current === DEFAULT_SHORTCUTS[mode] || !!takenBy(DEFAULT_SHORTCUTS[mode])}
            onClick={() => setCaptured(DEFAULT_SHORTCUTS[mode])}
          >
            Use the default
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={save} disabled={!captured || !!taken || captured === current || update.isPending}>
              {captured && isFnAccelerator(captured) ? "Use this shortcut" : "Use these keys"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
