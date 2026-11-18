import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { RunMode } from "@comma/shared/ipc";
import { inTauri, invoke, listen } from "./ipc";
import { queryKeys } from "./queries";
import { parseAccelerator, useShortcutHold } from "./shortcut";

export type ShortcutHandlers = {
  onDown?: (mode: RunMode) => void;
  onUp?: (mode: RunMode) => void;
  onCancel?: (mode: RunMode) => void;
  onSwitch?: (mode: RunMode, handsFree: boolean) => void;
};

/** `shortcut://down|up|cancel|switch` from Rust while `enabled`. */
export function useShortcutEvents(handlers: ShortcutHandlers, enabled = true) {
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => {
    if (!enabled) return;
    const offs = [
      listen("shortcut://down", (p) => latest.current.onDown?.(p.mode)),
      listen("shortcut://up", (p) => latest.current.onUp?.(p.mode)),
      listen("shortcut://cancel", (p) => latest.current.onCancel?.(p.mode)),
      listen("shortcut://switch", (p) => latest.current.onSwitch?.(p.mode, p.hands_free)),
    ];
    return () => offs.forEach((off) => void off.then((f) => f()));
  }, [enabled]);
}

/**
 * While mounted (and `enabled`), shortcut events go to this window when it is focused instead of
 * the bar, so the onboarding try-it steps run in place and the hub's Fn key test records nothing.
 */
export function useCaptureShortcuts(enabled = true, owner: "onboarding" | "hub" = "onboarding") {
  useEffect(() => {
    if (!enabled || !inTauri) return;
    void invoke("shortcuts_capture", { owner }).catch(() => {});
    return () => void invoke("shortcuts_capture", { owner: null }).catch(() => {});
  }, [enabled, owner]);
}

export const shortcutsStatusKey = ["shortcuts_status"] as const;

/** The listener status: polled, and replaced at once by `shortcut://status`. */
export function useShortcutsStatus() {
  const qc = useQueryClient();
  useEffect(() => {
    const off = listen("shortcut://status", (status) => qc.setQueryData(shortcutsStatusKey, status));
    return () => void off.then((f) => f());
  }, [qc]);
  return useQuery({
    queryKey: shortcutsStatusKey,
    queryFn: () => invoke("shortcuts_status"),
    refetchInterval: 2_000,
    staleTime: 0,
  });
}

/** Refetch settings and shortcut status when another window or Rust changes them. */
export function useSettingsSync() {
  const qc = useQueryClient();
  useEffect(() => {
    const off = listen("settings://changed", () => {
      void qc.invalidateQueries({ queryKey: queryKeys.settings });
      void qc.invalidateQueries({ queryKey: ["shortcuts_status"] });
      void qc.invalidateQueries({ queryKey: queryKeys.permissions });
    });
    return () => void off.then((f) => f());
  }, [qc]);
}

/**
 * Which keys of `accel` are held, for the keyboard test. From Rust's `shortcut://keys` (Fn
 * shortcuts) or, for plugin shortcuts, all keys while it is down. In a plain browser (dev), the
 * window's own key events stand in.
 */
export function useHeldKeys(accel: string, { enabled = true, onPress }: { enabled?: boolean; onPress?: () => void } = {}) {
  const [held, setHeld] = useState<ReadonlySet<string>>(new Set());
  const press = useRef(onPress);
  press.current = onPress;
  const isFn = accel === "Fn" || accel.startsWith("Fn+");
  const all = parseAccelerator(accel).map((c) => c.id);
  const allKey = all.join("+");

  useEffect(() => {
    if (!enabled || !inTauri) return;
    const offs = [
      listen("shortcut://keys", (p) => {
        if (isFn) setHeld(new Set(p.held.filter((k) => allKey.split("+").includes(k))));
      }),
      listen("shortcut://down", () => {
        if (!isFn) setHeld(new Set(allKey.split("+")));
        press.current?.();
      }),
      listen("shortcut://switch", () => press.current?.()),
      listen("shortcut://up", () => !isFn && setHeld(new Set())),
      listen("shortcut://cancel", () => !isFn && setHeld(new Set())),
    ];
    return () => offs.forEach((off) => void off.then((f) => f()));
  }, [enabled, isFn, allKey]);

  const browserHeld = useShortcutHold(isFn ? "" : accel, { enabled: enabled && !inTauri, onDown: () => press.current?.() });
  return inTauri ? held : browserHeld;
}
