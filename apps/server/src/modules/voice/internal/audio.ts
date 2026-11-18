/** What the uploaded audio is, read from its bytes (the client's content type is not trusted). */
export type AudioInfo = { format: 'wav' | 'ogg_opus'; mimeType: string; extension: string; seconds: number }

/** Parses the container header; `undefined` when it is not a WAV or Ogg/Opus file we can measure. */
export function inspectAudio(bytes: Uint8Array): AudioInfo | undefined {
  const seconds = wavSeconds(bytes)
  if (seconds !== undefined) return { format: 'wav', mimeType: 'audio/wav', extension: 'wav', seconds }
  const ogg = oggOpusSeconds(bytes)
  if (ogg !== undefined) return { format: 'ogg_opus', mimeType: 'audio/ogg', extension: 'ogg', seconds: ogg }
  return undefined
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length))
}

/** RIFF/WAVE: `data` bytes divided by the `fmt ` byte rate. */
export function wavSeconds(bytes: Uint8Array): number | undefined {
  if (bytes.length < 44 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE') return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let byteRate = 0
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const id = ascii(bytes, offset, 4)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (id === 'fmt ' && body + 16 <= bytes.length) {
      byteRate = view.getUint32(body + 8, true)
    } else if (id === 'data') {
      if (!byteRate) return undefined
      // Streamed writers leave the size at 0 or 0xFFFFFFFF; what was uploaded is what counts.
      const available = bytes.length - body
      const dataBytes = size === 0 || size > available ? available : size
      return dataBytes / byteRate
    }
    offset = body + size + (size % 2)
  }
  return undefined
}

/** Ogg/Opus: granule position of the last page, minus the pre-skip, at 48 kHz. */
export function oggOpusSeconds(bytes: Uint8Array): number | undefined {
  if (bytes.length < 47 || ascii(bytes, 0, 4) !== 'OggS') return undefined
  const segments = bytes[26] ?? 0
  const packet = 27 + segments
  if (packet + 19 > bytes.length || ascii(bytes, packet, 8) !== 'OpusHead') return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const preSkip = view.getUint16(packet + 10, true)
  for (let offset = bytes.length - 27; offset >= 0; offset--) {
    if (bytes[offset] === 0x4f && ascii(bytes, offset, 4) === 'OggS') {
      const granule = view.getBigInt64(offset + 6, true)
      if (granule < 0n) continue
      return Math.max(0, Number(granule) - preSkip) / 48_000
    }
  }
  return undefined
}
