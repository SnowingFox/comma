import { useQueryClient } from "@tanstack/react-query";
import type { PermissionsStatus, ShortcutsStatus } from "@comma/shared/ipc";
import { invoke } from "./ipc";
import { queryKeys } from "./queries";
import { shortcutsStatusKey } from "./shortcut-events";

export type PermissionKind = keyof PermissionsStatus;

/**
 * Check again: asks macOS now instead of waiting for the next poll. For Input Monitoring it also
 * starts a fresh Fn listener, since a tap created before the permission stays deaf.
 */
export function useRecheckPermission() {
  const qc = useQueryClient();
  return async (kind: PermissionKind) => {
    if (kind === "input_monitoring") qc.setQueryData(shortcutsStatusKey, await invoke("shortcuts_probe"));
    await qc.refetchQueries({ queryKey: queryKeys.permissions });
    await qc.refetchQueries({ queryKey: shortcutsStatusKey });
  };
}

export type InputMonitoringState = "ok" | "missing" | "restart" | "unused";

/**
 * Where Input Monitoring stands for the Fn shortcuts. `restart`: allowed, but this process cannot
 * use it yet (macOS applies the change to a new process).
 */
export function inputMonitoringState(status: ShortcutsStatus | undefined, usesFn: boolean): InputMonitoringState {
  if (!usesFn) return "unused";
  if (!status) return "ok";
  if (status.restart_required) return "restart";
  if (status.listener === "fn") return "ok";
  return "missing";
}
