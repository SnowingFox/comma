/** 412 ms, 1.4 s, 12 s. */
export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 1000)} s`;
}

export function formatSecs(secs: number): string {
  return secs < 10 ? `${secs.toFixed(1)} s` : `${Math.round(secs)} s`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
