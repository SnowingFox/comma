import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { isFnAccelerator } from "@comma/shared/ipc";
import { Button } from "@multica/ui/components/ui/button";
import { CircleAlert, Keyboard } from "@multica/ui/icons";
import { cn } from "@multica/ui/lib/utils";
import { errorMessage, invoke } from "../lib/ipc";
import { queryKeys, useSettings } from "../lib/queries";
import { acceleratorWords } from "../lib/shortcut";
import { useShortcutsStatus } from "../lib/shortcut-events";

/** Asks macOS for Input Monitoring; opens its pane when the prompt was already answered. */
export async function allowInputMonitoring() {
  const granted = await invoke("input_monitoring_request");
  if (!granted) await invoke("open_settings_pane", { kind: "input_monitoring" });
}

function Note({ icon: Icon, tone, children, action, className }: {
  icon: typeof Keyboard;
  tone: "warn" | "info";
  children: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      role="status"
      className={cn(
        "flex items-center gap-2.5 rounded-lg border px-3 py-2 text-label",
        tone === "warn" ? "border-warning/40 bg-warning/8" : "border-border bg-muted/50",
        className,
      )}
    >
      <Icon className={cn("size-4 shrink-0", tone === "warn" ? "text-warning" : "text-muted-foreground")} />
      <span className="min-w-0 flex-1">{children}</span>
      {action}
    </div>
  );
}

/**
 * One line when an Fn shortcut cannot work yet because Input Monitoring is missing (or allowed but
 * not applied to this process yet), with the fallback that works meanwhile and the fix. Nothing
 * otherwise.
 */
export function InputMonitoringNote({ className }: { className?: string }) {
  const qc = useQueryClient();
  const status = useShortcutsStatus().data;
  const shortcuts = useSettings().data?.shortcuts;
  if (!status || !shortcuts || status.listener !== "fallback") return null;
  const usesFn = isFnAccelerator(shortcuts.dictate) || isFnAccelerator(shortcuts.ask) || isFnAccelerator(shortcuts.translate);
  if (!usesFn) return null;
  const fallback = status.active.dictate;
  const meanwhile = fallback ? ` Until then, use ${acceleratorWords(fallback)}.` : "";
  const restart = (
    <Button size="sm" variant={status.restart_required ? "outline" : "ghost"} onClick={() => void invoke("app_restart").catch((e: unknown) => toast.error(errorMessage(e)))}>
      Restart Comma
    </Button>
  );
  if (status.restart_required) {
    return (
      <Note icon={CircleAlert} tone="warn" className={className} action={restart}>
        Input Monitoring is allowed, but Comma needs a restart to use Fn.{meanwhile}
      </Note>
    );
  }
  return (
    <Note
      icon={CircleAlert}
      tone="warn"
      className={className}
      action={
        <div className="flex items-center gap-1">
          {restart}
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void allowInputMonitoring()
                .then(() => qc.invalidateQueries({ queryKey: ["shortcuts_status"] }))
                .then(() => qc.invalidateQueries({ queryKey: queryKeys.permissions }))
                .catch((e: unknown) => toast.error(errorMessage(e)))
            }
          >
            Allow
          </Button>
        </div>
      }
    >
      Fn shortcuts need Input Monitoring.{meanwhile} Already allowed? Restart Comma.
    </Note>
  );
}

/** macOS still runs its own Globe key action (emoji, input source, dictation) when Fn is pressed. */
export function GlobeKeyNote({ className }: { className?: string }) {
  const status = useShortcutsStatus().data;
  if (!status || status.globe_key === "none" || status.globe_key === "unknown" || status.listener !== "fn") return null;
  const what = { input_source: "switches the input source", emoji: "opens the emoji picker", dictation: "starts macOS dictation" }[status.globe_key];
  return (
    <Note
      icon={Keyboard}
      tone="info"
      className={className}
      action={
        <Button size="sm" variant="ghost" onClick={() => void invoke("open_settings_pane", { kind: "keyboard" }).catch(() => {})}>
          Keyboard Settings
        </Button>
      }
    >
      Fn also {what}. Set “Press Globe key to” to Do Nothing.
    </Note>
  );
}
