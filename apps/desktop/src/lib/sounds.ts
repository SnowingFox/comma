/**
 * Comma's ticks, synthesised with WebAudio (spec 2.1): a soft low tick when recording starts, a
 * second, higher one when the text lands, and a quiet falling one on cancel. No sound files.
 */

let ctx: AudioContext | undefined;

function context(): AudioContext | undefined {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return undefined;
  }
}

type Tick = { from: number; to: number; ms: number; gain: number };

const TICKS = {
  start: { from: 660, to: 520, ms: 70, gain: 0.07 },
  done: { from: 990, to: 1240, ms: 90, gain: 0.06 },
  cancel: { from: 420, to: 300, ms: 110, gain: 0.05 },
} satisfies Record<string, Tick>;

export type TickKind = keyof typeof TICKS;

/** One short sine blip with a fast attack and an exponential tail, through a gentle low-pass. */
export function playTick(kind: TickKind) {
  const ac = context();
  if (!ac) return;
  const t = TICKS[kind];
  const now = ac.currentTime;
  const end = now + t.ms / 1000;
  const osc = ac.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(t.from, now);
  osc.frequency.exponentialRampToValueAtTime(t.to, end);
  const amp = ac.createGain();
  amp.gain.setValueAtTime(0.0001, now);
  amp.gain.exponentialRampToValueAtTime(t.gain, now + 0.006);
  amp.gain.exponentialRampToValueAtTime(0.0001, end);
  const filter = ac.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 2400;
  osc.connect(amp).connect(filter).connect(ac.destination);
  osc.start(now);
  osc.stop(end + 0.02);
}
