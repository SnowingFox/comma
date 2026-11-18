import { useEffect, useState } from "react";
import { isFnAccelerator } from "@comma/shared/ipc";
import { Button } from "@multica/ui/components/ui/button";
import { Keyboard } from "@multica/ui/icons";
import { cn } from "@multica/ui/lib/utils";
import { invoke, listen } from "../lib/ipc";
import { useSettings } from "../lib/queries";
import { useCaptureShortcuts, useShortcutsStatus } from "../lib/shortcut-events";

const GLOBE_ACTION = { input_source: "switches the input source", emoji: "opens the emoji picker", dictation: "starts macOS dictation" } as const;

function clock(ms: number) {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/**
 * "Test the Fn key": a light driven by the Fn listener's own events (`shortcut://keys` names only
 * configured keys, `shortcut://action` the shortcut that fired). While it is on screen the hub
 * captures the shortcuts, so pressing Fn here records nothing.
 */
export function FnKeyTest() {
  const status = useShortcutsStatus().data;
  const shortcuts = useSettings().data?.shortcuts;
  const usesFn = !!shortcuts && [shortcuts.dictate, shortcuts.ask, shortcuts.translate].some(isFnAccelerator);
  const [held, setHeld] = useState(false);
  const [last, setLast] = useState<number | null>(null);
  useCaptureShortcuts(usesFn, "hub");

  useEffect(() => {
    const offs = [
      listen("shortcut://keys", (p) => {
        const fn = p.held.includes("Fn");
        setHeld(fn);
        if (fn) setLast(Date.now());
      }),
      listen("shortcut://action", (p) => {
        if (p.source === "fn" && p.action === "start") setLast(Date.now());
      }),
    ];
    return () => offs.forEach((off) => void off.then((f) => f()));
  }, []);

  const globe = status && status.globe_key !== "none" && status.globe_key !== "unknown" ? GLOBE_ACTION[status.globe_key] : null;
  const trusted = status?.listener === "fn";

  return (
    <div className="flex flex-col gap-3 rounded-card border border-surface-border bg-surface p-4 shadow-[var(--surface-shadow)]">
      <div className="flex items-center gap-3">
        <span
          aria-hidden
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-lg transition-colors duration-150",
            held ? "bg-success text-white shadow-[0_0_14px_var(--color-success)]" : "bg-muted text-muted-foreground",
          )}
        >
          <Keyboard className="size-4.5" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-body font-medium">Test the Fn key</span>
          <span className="text-label text-muted-foreground" role="status" aria-live="polite">
            {!usesFn
              ? "None of your shortcuts uses Fn."
              : held
                ? "Fn is down. Comma hears it."
                : last
                  ? `Comma last heard Fn at ${clock(last)}.`
                  : "Press and hold Fn. The light comes on while Comma hears it. Nothing records here."}
          </span>
        </div>
      </div>
      {usesFn && !trusted ? (
        <p className="text-label text-warning">
          Without Input Monitoring, macOS may pass Fn on its own but not Fn+Space or Esc. Allow it above.
        </p>
      ) : null}
      {usesFn && globe ? (
        <div className="flex items-center gap-3 rounded-lg bg-muted/60 px-3 py-2">
          <p className="min-w-0 flex-1 text-label text-muted-foreground">
            Fn is also the Globe key, and macOS {globe} when you press it. Set “Press Globe key to” to Do Nothing in Keyboard
            settings so only Comma reacts.
          </p>
          <Button size="sm" variant="ghost" onClick={() => void invoke("open_settings_pane", { kind: "keyboard" }).catch(() => {})}>
            Keyboard Settings
          </Button>
        </div>
      ) : null}
      {usesFn && status?.globe_key === "unknown" ? (
        <p className="text-label text-muted-foreground">
          If the emoji picker or an input source switch shows up when you press Fn, set “Press Globe key to” to Do Nothing in
          Keyboard settings.
        </p>
      ) : null}
    </div>
  );
}
