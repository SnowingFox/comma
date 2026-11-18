import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { ShortcutSettings } from "@comma/shared/ipc";
import { Button } from "@multica/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { errorMessage } from "../lib/ipc";
import { useSettings, useUpdateSettings } from "../lib/queries";
import { acceleratorFromEvent } from "../lib/shortcut";
import { Keycaps } from "./keycaps";

const MODE_NAMES: Record<keyof ShortcutSettings, string> = {
  dictate: "Dictate",
  ask: "Ask Anything",
  translate: "Translate",
};

/**
 * Records a new key combination for one mode while the dialog is open. Only key events inside
 * this window are read.
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
  const update = useUpdateSettings();
  const [captured, setCaptured] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setCaptured(null);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Escape" && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) return; // closes the dialog
      e.preventDefault();
      e.stopPropagation();
      const accel = acceleratorFromEvent(e);
      if (accel) setCaptured(accel);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open]);

  const taken =
    captured && settings
      ? (Object.keys(MODE_NAMES) as (keyof ShortcutSettings)[]).find((m) => m !== mode && settings.shortcuts[m] === captured)
      : undefined;

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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New {MODE_NAMES[mode]} shortcut</DialogTitle>
          <DialogDescription>Press the keys you want, with at least one of ⌃ ⌥ ⇧ ⌘.</DialogDescription>
        </DialogHeader>
        <div className="flex h-28 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-muted/40">
          {captured ? (
            <Keycaps accel={captured} size="md" />
          ) : (
            <span className="text-body text-muted-foreground">Waiting for keys…</span>
          )}
          {taken ? <span className="text-caption text-destructive">{MODE_NAMES[taken]} already uses these keys</span> : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!captured || !!taken || update.isPending}>
            Use these keys
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
