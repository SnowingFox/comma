import { describe, expect, test } from "bun:test";
import type { RunResult } from "@comma/shared/ipc";
import { applyRunEvent, DEVTOOL_ACTION_LIMIT, devtoolStore, pushLimited, recordAction } from "./devtool-store";

const result: RunResult = {
  id: "r1",
  mode: "dictate",
  raw_text: "secret words",
  refined_text: "Secret words.",
  audio_secs: 2,
  stt_ms: 600,
  llm_ttft_ms: 200,
  llm_total_ms: 400,
  total_ms: 1100,
  delivery: "insert",
  output: "pasted",
  hint: null,
  app: "Notes",
};

describe("devtool store", () => {
  test("keeps the newest actions up to the limit", () => {
    for (let i = 0; i < DEVTOOL_ACTION_LIMIT + 7; i++) {
      recordAction({ action: i % 2 ? "stop" : "start", mode: "dictate", source: "fn", target: "bar" }, i);
    }
    const { actions, total } = devtoolStore.getState();
    expect(actions.length).toBe(DEVTOOL_ACTION_LIMIT);
    expect(total).toBe(DEVTOOL_ACTION_LIMIT + 7);
    expect(actions.at(-1)!.at).toBe(DEVTOOL_ACTION_LIMIT + 6);
    expect(pushLimited([1, 2, 3], 4, 3)).toEqual([2, 3, 4]);
  });

  test("folds run events into timings and never keeps the text", () => {
    let runs = applyRunEvent([], { kind: "stage", payload: { id: "r1", stage: "stt", ms: 612 } }, 1);
    runs = applyRunEvent(runs, { kind: "stage", payload: { id: "r1", stage: "llm", ms: 420 } }, 2);
    runs = applyRunEvent(runs, { kind: "done", payload: { id: "r1", result } }, 3);
    expect(runs).toEqual([{ id: "r1", at: 1, stages: { stt: 612, llm: 420 }, total_ms: 1100, output: "pasted" }]);
    expect(JSON.stringify(runs)).not.toContain("ecret");

    runs = applyRunEvent(runs, { kind: "error", payload: { id: "r2", code: "not_configured", message: "Add your ElevenLabs key", reason: "missing_elevenlabs_key" } }, 4);
    expect(runs.map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(runs[1]!.error?.reason).toBe("missing_elevenlabs_key");
    // Limit applies to runs too.
    for (let i = 0; i < 5; i++) runs = applyRunEvent(runs, { kind: "stage", payload: { id: `x${i}`, stage: "stt", ms: 1 } }, 5, 3);
    expect(runs.map((r) => r.id)).toEqual(["x2", "x3", "x4"]);
  });
});
