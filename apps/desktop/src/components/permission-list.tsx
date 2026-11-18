import { useState, type ComponentType, type SVGProps } from "react";
import { motion } from "motion/react";
import { toast } from "sonner";
import type { PermissionState, PermissionsStatus } from "@comma/shared/ipc";
import { Badge } from "@multica/ui/components/ui/badge";
import { Button } from "@multica/ui/components/ui/button";
import { Check, Keyboard, Mic, RotateCw, Type } from "@multica/ui/icons";
import { cn } from "@multica/ui/lib/utils";
import { errorMessage, invoke } from "../lib/ipc";
import { inputMonitoringState, useRecheckPermission } from "../lib/permissions";
import { usePermissions, useSettings } from "../lib/queries";
import { useShortcutsStatus } from "../lib/shortcut-events";
import { isFnAccelerator } from "@comma/shared/ipc";
import { allowInputMonitoring } from "./shortcut-notes";
import { StatusDot } from "./status-dot";

const ROWS: {
  kind: keyof PermissionsStatus;
  title: string;
  description: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
}[] = [
  {
    kind: "microphone",
    title: "Microphone",
    description: "Hears you while you hold the shortcut. Nothing is recorded otherwise.",
    icon: Mic,
  },
  {
    kind: "accessibility",
    title: "Accessibility",
    description: "Pastes text into the app you are using, and reads the selection for Ask Anything.",
    icon: Type,
  },
  {
    kind: "input_monitoring",
    title: "Input Monitoring",
    description: "Lets Comma notice the Fn key. It only watches your shortcut keys and Esc, and never records anything you type.",
    icon: Keyboard,
  },
];

const STATUS_LABEL: Record<PermissionState, string> = {
  granted: "Allowed",
  denied: "Not allowed",
  restricted: "Blocked by policy",
  not_determined: "Not asked yet",
};

/**
 * macOS lists an app under Privacy > Microphone only after it has asked once, so the
 * first request goes through WebKit, which raises the system prompt.
 */
async function requestMicrophone() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
  } catch {
    await invoke("open_settings_pane", { kind: "microphone" });
  }
}

/**
 * `recheck` adds Check again to each row, and for Input Monitoring says when a restart is needed
 * (macOS applies that permission to a new process).
 */
export function PermissionList({ className, recheck = false }: { className?: string; recheck?: boolean }) {
  const { data } = usePermissions();
  const status = useShortcutsStatus().data;
  const shortcuts = useSettings().data?.shortcuts;
  const usesFn = !!shortcuts && [shortcuts.dictate, shortcuts.ask, shortcuts.translate].some(isFnAccelerator);
  const im = inputMonitoringState(status, usesFn);
  const check = useRecheckPermission();
  const [checking, setChecking] = useState<string | null>(null);

  return (
    <ul className={cn("flex flex-col divide-y divide-border overflow-hidden rounded-card border border-surface-border bg-surface", className)}>
      {ROWS.map(({ kind, title, description, icon: Icon }) => {
        const state = data?.[kind];
        const granted = state === "granted";
        const onClick = () => {
          // Asked once in this run already: open System Settings instead of asking again.
          const run = kind === "microphone" && state === "not_determined"
            ? requestMicrophone()
            : kind === "input_monitoring" && !status?.requested
              ? allowInputMonitoring()
              : invoke("open_settings_pane", { kind });
          run.catch((err: Error) => toast.error(err.message));
        };
        return (
          <li key={kind} className="flex items-center gap-3 px-4 py-3.5">
            {/* Amber to green with a short spring when the permission arrives (spec 2.4). */}
            <motion.span
              key={granted ? "granted" : "waiting"}
              initial={granted ? { scale: 0.7 } : false}
              animate={{ scale: 1 }}
              transition={{ type: "spring", stiffness: 500, damping: 15 }}
              className={cn(
                "flex size-9 shrink-0 items-center justify-center rounded-lg transition-colors duration-300",
                granted ? "bg-success/12 text-success" : "bg-warning/12 text-warning",
              )}
            >
              {granted ? <Check className="size-4.5" /> : <Icon className="size-4.5" />}
            </motion.span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex items-center gap-2">
                <span className="text-body font-medium">{title}</span>
                {state ? (
                  <Badge
                    variant={granted ? "secondary" : "outline"}
                    className={cn(granted ? "text-success" : "text-muted-foreground")}
                  >
                    <StatusDot tone={granted ? "ok" : "warn"} className="-ml-0.5 scale-75" />
                    {STATUS_LABEL[state]}
                  </Badge>
                ) : null}
              </div>
              <p className="text-label text-muted-foreground">{description}</p>
              {recheck && kind === "input_monitoring" && !granted ? (
                <p className="text-label text-muted-foreground">
                  Turned it on already? macOS lets Comma use it after a relaunch.{" "}
                  <button type="button" className="font-medium text-foreground underline underline-offset-2" onClick={() => void invoke("app_restart").catch((e: unknown) => toast.error(errorMessage(e)))}>
                    Relaunch Comma
                  </button>
                </p>
              ) : null}
              {recheck && kind === "input_monitoring" && granted && im === "missing" ? (
                <p className="text-label text-warning">Allowed, but the Fn listener has not picked it up. Check again, or relaunch Comma.</p>
              ) : null}
              {recheck && kind === "input_monitoring" && im === "restart" ? (
                <p className="text-label text-warning">
                  Allowed, but this copy of Comma can't use it yet.{" "}
                  <button type="button" className="font-medium underline underline-offset-2" onClick={() => void invoke("app_restart").catch((e: unknown) => toast.error(errorMessage(e)))}>
                    Relaunch Comma
                  </button>
                </p>
              ) : null}
            </div>
            {recheck ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={checking === kind}
                onClick={() => {
                  setChecking(kind);
                  void check(kind)
                    .catch((e: unknown) => toast.error(errorMessage(e)))
                    .finally(() => setChecking(null));
                }}
              >
                <RotateCw className={cn(checking === kind && "animate-spin")} />
                Check again
              </Button>
            ) : null}
            {granted ? null : (
              <Button variant="outline" size="sm" onClick={onClick} disabled={state === "restricted"}>
                {(kind === "microphone" && state === "not_determined") || (kind === "input_monitoring" && !status?.requested) ? "Allow" : "Open Settings"}
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
