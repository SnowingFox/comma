/**
 * 16 kHz mono speech to Ogg/Opus at 32 kbps (20 ms frames, VBR) with WebCodecs, for smaller
 * uploads: about 4 KB per second instead of the WAV's 32 KB. The Ogg container is written here
 * (RFC 7845); WebCodecs only gives raw Opus packets. Returns null when the webview has no Opus
 * encoder, and the caller sends WAV instead.
 */

const OPUS_RATE = 48_000;
/** libopus's encoder delay at 48 kHz, written as the pre-skip. */
const PRE_SKIP = 312;
const SERIAL = 0x436f6d6d; // "Comm"

let crcTable: Uint32Array | undefined;

/** Ogg's CRC-32: polynomial 0x04c11db7, no reflection, initial value 0. */
export function oggCrc(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let r = i << 24;
      for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
      crcTable[i] = r >>> 0;
    }
  }
  let crc = 0;
  for (const b of bytes) crc = ((crc << 8) ^ crcTable[((crc >>> 24) ^ b) & 0xff]!) >>> 0;
  return crc >>> 0;
}

type Packet = { data: Uint8Array; samples48k: number };

function page(packets: Uint8Array[], granule: bigint, seq: number, flags: number): Uint8Array {
  const lacing: number[] = [];
  for (const p of packets) {
    let n = p.length;
    while (n >= 255) {
      lacing.push(255);
      n -= 255;
    }
    lacing.push(n);
  }
  const bodyLen = packets.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(27 + lacing.length + bodyLen);
  const view = new DataView(out.buffer);
  out.set([0x4f, 0x67, 0x67, 0x53], 0); // OggS
  out[4] = 0;
  out[5] = flags;
  view.setBigInt64(6, granule, true);
  view.setUint32(14, SERIAL, true);
  view.setUint32(18, seq, true);
  out[26] = lacing.length;
  out.set(lacing, 27);
  let offset = 27 + lacing.length;
  for (const p of packets) {
    out.set(p, offset);
    offset += p.length;
  }
  view.setUint32(22, oggCrc(out), true);
  return out;
}

function opusHead(inputRate: number): Uint8Array {
  const head = new Uint8Array(19);
  const view = new DataView(head.buffer);
  head.set(new TextEncoder().encode("OpusHead"), 0);
  head[8] = 1; // version
  head[9] = 1; // channels
  view.setUint16(10, PRE_SKIP, true);
  view.setUint32(12, inputRate, true);
  view.setInt16(16, 0, true); // output gain
  head[18] = 0; // mapping family: mono
  return head;
}

function opusTags(): Uint8Array {
  const vendor = new TextEncoder().encode("Comma");
  const tags = new Uint8Array(8 + 4 + vendor.length + 4);
  const view = new DataView(tags.buffer);
  tags.set(new TextEncoder().encode("OpusTags"), 0);
  view.setUint32(8, vendor.length, true);
  tags.set(vendor, 12);
  view.setUint32(12 + vendor.length, 0, true);
  return tags;
}

/** The Ogg stream for already-encoded Opus packets. Pure, for tests. */
export function muxOggOpus(packets: Packet[], inputRate: number): Uint8Array {
  const pages: Uint8Array[] = [page([opusHead(inputRate)], 0n, 0, 0x02), page([opusTags()], 0n, 1, 0)];
  let seq = 2;
  let granule = BigInt(PRE_SKIP);
  // About one second of 20 ms packets per page; a page holds at most 255 lacing values.
  for (let i = 0; i < packets.length; i += 50) {
    const group = packets.slice(i, i + 50);
    for (const p of group) granule += BigInt(p.samples48k);
    const last = i + 50 >= packets.length;
    pages.push(page(group.map((p) => p.data), granule, seq++, last ? 0x04 : 0));
  }
  if (packets.length === 0) pages.push(page([], granule, seq, 0x04));
  const out = new Uint8Array(pages.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of pages) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

const CONFIG = {
  codec: "opus",
  sampleRate: 16_000,
  numberOfChannels: 1,
  bitrate: 32_000,
  bitrateMode: "variable",
  opus: { frameDuration: 20_000, complexity: 9, application: "voip" },
} as const;

let supported: Promise<boolean> | undefined;

export function opusSupported(): Promise<boolean> {
  supported ??= (async () => {
    try {
      if (typeof AudioEncoder === "undefined") return false;
      const res = await AudioEncoder.isConfigSupported(CONFIG as unknown as AudioEncoderConfig);
      return res.supported === true;
    } catch {
      return false;
    }
  })();
  return supported;
}

/** Encodes 16 kHz mono samples; null without an Opus encoder or on any encoder error. */
export async function encodeOggOpus(samples: Float32Array, rate: number): Promise<Uint8Array | null> {
  if (rate !== CONFIG.sampleRate || !(await opusSupported())) return null;
  const packets: Packet[] = [];
  let failed = false;
  const encoder = new AudioEncoder({
    output: (chunk) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      packets.push({ data, samples48k: Math.round(((chunk.duration ?? 20_000) * OPUS_RATE) / 1_000_000) });
    },
    error: () => {
      failed = true;
    },
  });
  try {
    encoder.configure(CONFIG as unknown as AudioEncoderConfig);
    // Feed in 1 s pieces so a long clip never makes one huge AudioData.
    const step = rate;
    for (let i = 0; i < samples.length; i += step) {
      const part = samples.subarray(i, Math.min(samples.length, i + step));
      const data = new AudioData({
        format: "f32-planar",
        sampleRate: rate,
        numberOfFrames: part.length,
        numberOfChannels: 1,
        timestamp: Math.round((i / rate) * 1_000_000),
        data: part.slice(),
      });
      encoder.encode(data);
      data.close();
    }
    await encoder.flush();
  } catch {
    failed = true;
  } finally {
    if (encoder.state !== "closed") encoder.close();
  }
  if (failed || packets.length === 0) return null;
  return muxOggOpus(packets, rate);
}
