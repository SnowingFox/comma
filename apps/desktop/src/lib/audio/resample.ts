/**
 * `resample` one piece at a time, so the clip is ready (and can be encoded) while the user talks.
 * Gives the same samples as resampling the whole recording, except at the very end.
 */
export class StreamResampler {
  /** Input position of the next output sample, counted from the first input sample. */
  private pos = 0;
  /** Input index of the current piece's first sample. */
  private base = 0;
  private prev = 0;

  constructor(
    private readonly from: number,
    private readonly to: number,
  ) {}

  push(input: Float32Array): Float32Array {
    if (this.from === this.to) return input.slice();
    const ratio = this.from / this.to;
    const out = new Float32Array(Math.ceil(input.length / ratio) + 1);
    let n = 0;
    for (;;) {
      const j = Math.floor(this.pos);
      const idx = j - this.base;
      if (idx + 1 >= input.length) break;
      const frac = this.pos - j;
      const a = idx < 0 ? this.prev : input[idx]!;
      out[n++] = a * (1 - frac) + input[idx + 1]! * frac;
      this.pos += ratio;
    }
    if (input.length > 0) this.prev = input[input.length - 1]!;
    this.base += input.length;
    return out.subarray(0, n);
  }
}

/** Linear interpolation; good enough for speech going to a recogniser. */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to || input.length === 0) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const j = Math.floor(pos);
    const frac = pos - j;
    out[i] = (input[j] ?? 0) * (1 - frac) + (input[j + 1] ?? input[j] ?? 0) * frac;
  }
  return out;
}
