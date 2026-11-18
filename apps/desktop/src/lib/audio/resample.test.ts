import { describe, expect, test } from "bun:test";
import { resample, StreamResampler } from "./resample";
import { muxOggOpus, oggCrc } from "./ogg-opus";

describe("StreamResampler", () => {
  test("matches resampling the whole clip, piece by piece", () => {
    const input = new Float32Array(48_000).map((_, i) => Math.sin(i / 7) * 0.5);
    const whole = resample(input, 48_000, 16_000);
    const r = new StreamResampler(48_000, 16_000);
    const parts: number[] = [];
    for (let i = 0; i < input.length; i += 2048) parts.push(...r.push(input.subarray(i, i + 2048)));
    // Only the very last output sample may be missing (it needs the next input sample).
    expect(whole.length - parts.length).toBeLessThanOrEqual(1);
    for (let i = 0; i < parts.length; i++) expect(Math.abs(parts[i]! - whole[i]!)).toBeLessThan(1e-6);
  });

  test("odd rates and tiny pieces", () => {
    const input = new Float32Array(44_100).map((_, i) => (i % 100) / 100);
    const whole = resample(input, 44_100, 16_000);
    const r = new StreamResampler(44_100, 16_000);
    const parts: number[] = [];
    for (let i = 0; i < input.length; i += 3) parts.push(...r.push(input.subarray(i, i + 3)));
    expect(whole.length - parts.length).toBeLessThanOrEqual(1);
    for (let i = 0; i < parts.length; i++) expect(Math.abs(parts[i]! - whole[i]!)).toBeLessThan(1e-5);
  });
});

describe("Ogg/Opus container", () => {
  test("CRC-32 as Ogg defines it", () => {
    expect(oggCrc(new TextEncoder().encode("OggS"))).toBe(0x5fb0a94f);
  });

  test("head, tags and audio pages with granule positions", () => {
    const packets = Array.from({ length: 120 }, () => ({ data: new Uint8Array(80).fill(1), samples48k: 960 }));
    const ogg = muxOggOpus(packets, 16_000);
    const pages: { flags: number; granule: bigint; seq: number }[] = [];
    let off = 0;
    while (off < ogg.length) {
      const view = new DataView(ogg.buffer, ogg.byteOffset + off);
      expect(String.fromCharCode(...ogg.subarray(off, off + 4))).toBe("OggS");
      const segs = ogg[off + 26]!;
      const body = [...ogg.subarray(off + 27, off + 27 + segs)].reduce((a, b) => a + b, 0);
      pages.push({ flags: ogg[off + 5]!, granule: view.getBigInt64(6, true), seq: view.getUint32(18, true) });
      // The stored CRC matches the page with its CRC field zeroed.
      const page = ogg.slice(off, off + 27 + segs + body);
      const crc = new DataView(page.buffer).getUint32(22, true);
      page.fill(0, 22, 26);
      expect(oggCrc(page)).toBe(crc);
      off += 27 + segs + body;
    }
    expect(pages.map((p) => p.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(pages[0]!.flags).toBe(0x02);
    expect(pages.at(-1)!.flags).toBe(0x04);
    expect(pages.at(-1)!.granule).toBe(312n + 120n * 960n);
  });
});
