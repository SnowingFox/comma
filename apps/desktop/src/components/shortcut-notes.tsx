import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { isFnAccelerator } from "@comma/shared/ipc";
import { Button } from "@multica/ui/components/ui/button";
import { CircleAlert, Keyboard } from "@multica/ui/icons";
import { cn } from "@multica/ui/lib/utils";
import { errorMessage, invoke } from "../lib/ipc";
import { queryKeys, usePermissions, useSettings } from "../lib/queries";
import { acceleratorWords } from "../lib/shortcut";
import { useShortcutsStatus } from "../lib/shortcut-events";

/**
 * On a click: asks macOS for Input Monitoring (the prompt shows at most once per process), and
 * opens its pane in System Settings when it is not in effect.
 */
export async function allowInputMonitoring() {
  const granted = await invoke("input_monitoring_request");
  if (!granted) await invoke("open_settings_pane", { kind: "input_monitoring" });
}

export const relaunch = () => void invoke("app_restart").catch((e: unknown) => toast.error(errorMessage(e)));

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
  const relaunchButton = (primary: boolean) => (
    <Button size="sm" variant={primary ? "outline" : "ghost"} onClick={relaunch}>
      Relaunch Comma
    </Button>
  );
  if (status.restart_required || status.input_monitoring) {
    return (
      <Note icon={CircleAlert} tone="warn" className={className} action={relaunchButton(true)}>
        Input Monitoring is allowed, but Comma needs a relaunch to use it.{meanwhile}
      </Note>
    );
  }
  if (status.requested) {
    // Asked already in this run: another request would not prompt. Relaunch is the next step.
    return (
      <Note
        icon={CircleAlert}
        tone="warn"
        className={className}
        action={
          <div className="flex items-center gap-1">
            <Button size="sm" variant="ghost" onClick={() => void invoke("open_settings_pane", { kind: "input_monitoring" }).catch(() => {})}>
              Open Settings
            </Button>
            {relaunchButton(true)}
          </div>
        }
      >
        Turned on Input Monitoring for Comma? Relaunch it to use Fn+Space.{meanwhile}
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
          {relaunchButton(false)}
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
      Fn shortcuts need Input Monitoring.{meanwhile} Already allowed? Relaunch Comma.
    </Note>
  );
}

/**
 * While Accessibility is missing, Comma can only copy the text: one line that stays until it is
 * allowed, with the button to its pane (the bar says it once per launch, after a copy).
 */
export function AccessibilityNote({ className }: { className?: string }) {
  const accessibility = usePermissions().data?.accessibility;
  if (!accessibility || accessibility === "granted") return null;
  return (
    <Note
      icon={CircleAlert}
      tone="warn"
      className={className}
      action={
        <Button size="sm" variant="outline" onClick={() => void invoke("open_settings_pane", { kind: "accessibility" }).catch((e: unknown) => toast.error(errorMessage(e)))}>
          Allow Accessibility
        </Button>
      }
    >
      Comma copies your text instead of pasting it. Allow Accessibility so it can paste for you.
    </Note>
  );
}

/**
 * macOS still runs its own Globe key action (emoji, input source, dictation) when Fn is pressed; a
 * listen-only tap cannot stop it. Read-only: Comma never changes the setting, it links to it.
 */
export function GlobeKeyNote({ className }: { className?: string }) {
  const status = useShortcutsStatus().data;
  const shortcuts = useSettings().data?.shortcuts;
  const usesFn = !!shortcuts && (isFnAccelerator(shortcuts.dictate) || isFnAccelerator(shortcuts.ask) || isFnAccelerator(shortcuts.translate));
  if (!status || !usesFn || status.globe_key === "none" || status.globe_key === "unknown" || status.swallow === "on") return null;
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
      Fn also {what}. In Keyboard settings, set “Press 🌐 key to” to Do Nothing.
    </Note>
  );
}
