// `no-inline`: the CSP allows scripts from the app only, so the worklet must be a file, not a data: URL.
import workletUrl from "./pcm-worklet.js?url&no-inline";

/** ElevenLabs takes any rate; 16 kHz mono keeps uploads small (spec 3.1). */
export const TARGET_RATE = 16_000;

export type Recording = { wavBase64: string; durationSecs: number; peak: number };

/**
 * Microphone capture: getUserMedia into an AudioWorklet tap. The level callback runs while the
 * stream is open (for meters); samples are kept only between `start()` and `stop()`.
 */
export class Recorder {
  private chunks: Float32Array[] = [];
  private capturing = false;
  private peak = 0;

  private constructor(
    private readonly stream: MediaStream,
    private readonly context: AudioContext,
    private readonly nodes: AudioNode[],
    readonly deviceLabel: string,
  ) {}

  /** Level from 0 to 1 on a -60..0 dBFS scale, about 23 times a second. */
  onLevel: ((level: number) => void) | undefined;

  static async open(deviceId?: string): Promise<Recorder> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    try {
      const context = new AudioContext();
      await context.audioWorklet.addModule(workletUrl);
      const source = context.createMediaStreamSource(stream);
      const tap = new AudioWorkletNode(context, "comma-pcm-tap", { numberOfOutputs: 0 });
      source.connect(tap);
      const label = stream.getAudioTracks()[0]?.label ?? "";
      const recorder = new Recorder(stream, context, [source, tap], label);
      tap.port.onmessage = (e: MessageEvent<Float32Array>) => recorder.receive(e.data);
      if (context.state === "suspended") await context.resume();
      return recorder;
    } catch (err) {
      for (const track of stream.getTracks()) track.stop();
      throw err;
    }
  }

  private receive(chunk: Float32Array) {
    let sum = 0;
    let peak = 0;
    for (const s of chunk) {
      sum += s * s;
      peak = Math.max(peak, Math.abs(s));
    }
    const rms = Math.sqrt(sum / chunk.length);
    const db = 20 * Math.log10(Math.max(rms, 1e-6));
    this.onLevel?.(Math.min(1, Math.max(0, (db + 60) / 60)));
    if (this.capturing) {
      this.chunks.push(chunk);
      this.peak = Math.max(this.peak, peak);
    }
  }

  get recording() {
    return this.capturing;
  }

  start() {
    this.chunks = [];
    this.peak = 0;
    this.capturing = true;
  }

  stop(): Recording {
    this.capturing = false;
    const samples = resample(concat(this.chunks), this.context.sampleRate, TARGET_RATE);
    this.chunks = [];
    return { wavBase64: toBase64(encodeWav(samples, TARGET_RATE)), durationSecs: samples.length / TARGET_RATE, peak: this.peak };
  }

  close() {
    this.capturing = false;
    this.onLevel = undefined;
    for (const node of this.nodes) node.disconnect();
    for (const track of this.stream.getTracks()) track.stop();
    void this.context.close();
  }
}

/** Audio inputs. Labels are empty until the user has allowed the microphone once. */
export async function listMicrophones(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === "audioinput");
}

function concat(chunks: Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
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

/** 16-bit PCM mono WAV, the same layout `audio.rs` writes. */
export function encodeWav(samples: Float32Array, rate: number): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => [...text].forEach((ch, i) => view.setUint8(offset + i, ch.charCodeAt(0)));
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, s)) * 0x7fff), true));
  return bytes;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) binary += String.fromCharCode(...bytes.subarray(i, i + step));
  return btoa(binary);
}
