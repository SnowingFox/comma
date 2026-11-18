// The devtool's memory of what happened since the hub loaded: shortcut actions, held keys and run
// progress. Built from event payloads that carry no text: actions name only configured shortcuts,
// runs keep stage timings and error messages, never transcripts or results.

import { useSyncExternalStore } from "react";
import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import type { RunDonePayload, RunErrorPayload, RunStagePayload, ShortcutActionPayload } from "@comma/shared/ipc";
import { listen } from "./ipc";

/** How many shortcut actions the devtool keeps. */
export const DEVTOOL_ACTION_LIMIT = 50;
/** How many live runs it keeps. */
export const DEVTOOL_RUN_LIMIT = 20;

export type ActionRecord = ShortcutActionPayload & { seq: number; at: number };

export type LiveRun = {
  id: string;
  /** First event seen for it. */
  at: number;
  stages: Partial<Record<RunStagePayload["stage"], number>>;
  total_ms?: number;
  output?: string;
  error?: { code: string; message: string; reason?: string };
};

type State = {
  actions: readonly ActionRecord[];
  /** Actions since load, including dropped ones. */
  total: number;
  runs: readonly LiveRun[];
  /** `shortcut://keys`: the configured keys held now. */
  held: readonly string[];
  /** When `held` last changed. */
  heldAt: number | null;
};

const initial: State = { actions: [], total: 0, runs: [], held: [], heldAt: null };

export const devtoolStore = createStore<State>(() => initial);

let seq = 1;

/** Newest last, at most `limit`. */
export function pushLimited<T>(list: readonly T[], item: T, limit: number): T[] {
  return [...list, item].slice(-limit);
}

export type RunEvent =
  | { kind: "stage"; payload: RunStagePayload }
  | { kind: "done"; payload: RunDonePayload }
  | { kind: "error"; payload: RunErrorPayload };

/** Folds one run event into the list; only timings, the output kind and errors are kept. */
export function applyRunEvent(runs: readonly LiveRun[], event: RunEvent, at: number, limit = DEVTOOL_RUN_LIMIT): LiveRun[] {
  const id = event.payload.id;
  const existing = runs.find((r) => r.id === id);
  const run: LiveRun = existing ? { ...existing, stages: { ...existing.stages } } : { id, at, stages: {} };
  if (event.kind === "stage") run.stages[event.payload.stage] = event.payload.ms;
  if (event.kind === "done") {
    const r = event.payload.result;
    run.total_ms = r.total_ms;
    run.output = r.output;
    run.stages.stt ??= r.stt_ms;
    run.stages.llm ??= r.llm_total_ms;
  }
  if (event.kind === "error") {
    run.error = { code: String(event.payload.code), message: event.payload.message, reason: event.payload.reason };
  }
  const others = runs.filter((r) => r.id !== id);
  return pushLimited(others, run, limit);
}

export function recordAction(payload: ShortcutActionPayload, at = Date.now()) {
  devtoolStore.setState((s) => ({ actions: pushLimited(s.actions, { ...payload, seq: seq++, at }, DEVTOOL_ACTION_LIMIT), total: s.total + 1 }));
}

export function clearActions() {
  devtoolStore.setState({ actions: [], total: 0 });
}

let started = false;

/** Subscribes once per window; safe to call from several components. */
export function startDevtoolRecording() {
  if (started) return;
  started = true;
  void listen("shortcut://action", (p) => recordAction(p));
  void listen("shortcut://keys", (p) => devtoolStore.setState({ held: p.held, heldAt: Date.now() }));
  const run = (event: RunEvent) => devtoolStore.setState((s) => ({ runs: applyRunEvent(s.runs, event, Date.now()) }));
  void listen("run://stage", (payload) => run({ kind: "stage", payload }));
  // `run://done` carries the texts; applyRunEvent keeps only the timings.
  void listen("run://done", (payload) => run({ kind: "done", payload }));
  void listen("run://error", (payload) => run({ kind: "error", payload }));
}

export function useDevtoolStore<T>(select: (s: State) => T): T {
  return useStore(devtoolStore, select);
}

// ---- enabling -----------------------------------------------------------------------------------

export const DEVTOOLS_KEY = "comma-devtools";
const CHANGE = "comma-devtools-change";

/** On by default in dev builds; in release after Settings > About turned it on. Shared by every window. */
export function devtoolsEnabled(): boolean {
  const stored = localStorage.getItem(DEVTOOLS_KEY);
  return stored === "1" || (import.meta.env.DEV && stored !== "0");
}

export function setDevtoolsEnabled(on: boolean) {
  localStorage.setItem(DEVTOOLS_KEY, on ? "1" : "0");
  window.dispatchEvent(new Event(CHANGE));
}

function subscribe(onChange: () => void) {
  window.addEventListener(CHANGE, onChange);
  // Another window of the app changed it.
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGE, onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function useDevtoolsEnabled(): boolean {
  return useSyncExternalStore(subscribe, devtoolsEnabled, () => false);
}
