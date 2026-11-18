import { useEffect, useRef } from "react";
import { useReducedMotion } from "motion/react";

export const BAR_COUNT = 10;
const MIN_PX = 3;
const MAX_PX = 22;
/** Centre bars move more than the edges, like a voice rather than an equaliser. */
const WEIGHTS = Array.from({ length: BAR_COUNT }, (_, i) => {
  const x = (i - (BAR_COUNT - 1) / 2) / (BAR_COUNT / 2);
  return 0.45 + 0.55 * Math.exp(-2.2 * x * x);
});

/** A level in 0..1, read once per frame. */
export type LevelSource = () => number;

/**
 * Dev stand-in for the microphone RMS stream: speech-like bursts with pauses.
 * Phase 2 replaces it with the AudioWorklet level.
 */
export function createFakeLevel(): LevelSource {
  const start = performance.now();
  return () => {
    const t = (performance.now() - start) / 1000;
    const syllables = 0.5 + 0.5 * Math.sin(t * 9.1) * Math.sin(t * 3.7 + 1.3);
    const phrase = Math.max(0, Math.sin(t * 0.9 + 0.4)) ** 0.6;
    return Math.min(1, Math.max(0, syllables * phrase * 0.9 + Math.random() * 0.12));
  };
}

/** Ten smoothed bars. Heights are written straight to the DOM each frame, without re-rendering. */
export function Waveform({ level }: { level?: LevelSource }) {
  const bars = useRef<(HTMLSpanElement | null)[]>([]);
  const reduced = useReducedMotion();

  useEffect(() => {
    const values = new Array<number>(BAR_COUNT).fill(0);
    let frame = 0;
    const tick = () => {
      const l = level ? level() : 0;
      for (let i = 0; i < BAR_COUNT; i++) {
        const jitter = 0.75 + Math.random() * 0.5;
        const target = l * WEIGHTS[i]! * jitter;
        // Rise fast, fall slower: reads as attack and decay.
        const k = target > values[i]! ? 0.45 : 0.18;
        values[i] = values[i]! + (target - values[i]!) * (reduced ? 1 : k);
        const el = bars.current[i];
        if (el) el.style.height = `${MIN_PX + values[i]! * (MAX_PX - MIN_PX)}px`;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [level, reduced]);

  return (
    <div className="flex h-6 items-center gap-[3px]" aria-hidden>
      {Array.from({ length: BAR_COUNT }, (_, i) => (
        <span
          key={i}
          ref={(el) => {
            bars.current[i] = el;
          }}
          className="w-[3px] rounded-full bg-white/90"
          style={{ height: MIN_PX }}
        />
      ))}
    </div>
  );
}
