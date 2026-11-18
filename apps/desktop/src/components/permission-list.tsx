import type { ComponentType, SVGProps } from "react";
import { motion } from "motion/react";
import { toast } from "sonner";
import type { PermissionState, SettingsPaneKind } from "@comma/shared/ipc";
import { Badge } from "@multica/ui/components/ui/badge";
import { Button } from "@multica/ui/components/ui/button";
import { Check, Keyboard, Mic } from "@multica/ui/icons";
import { cn } from "@multica/ui/lib/utils";
import { invoke } from "../lib/ipc";
import { usePermissions } from "../lib/queries";
import { StatusDot } from "./status-dot";

const ROWS: {
  kind: SettingsPaneKind;
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

export function PermissionList({ className }: { className?: string }) {
  const { data } = usePermissions();

  return (
    <ul className={cn("flex flex-col divide-y divide-border overflow-hidden rounded-card border border-surface-border bg-surface", className)}>
      {ROWS.map(({ kind, title, description, icon: Icon }) => {
        const state = data?.[kind];
        const granted = state === "granted";
        const onClick = () => {
          const run = kind === "microphone" && state === "not_determined"
            ? requestMicrophone()
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
            </div>
            {granted ? null : (
              <Button variant="outline" size="sm" onClick={onClick} disabled={state === "restricted"}>
                {kind === "microphone" && state === "not_determined" ? "Allow" : "Open Settings"}
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
