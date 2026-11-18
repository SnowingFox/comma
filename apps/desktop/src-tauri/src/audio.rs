//! WAV helpers: encode 16-bit mono PCM, read a WAV's duration, and the short clip `stt_test` sends.

pub const TEST_SAMPLE_RATE: u32 = 16_000;

/// A canonical 44-byte-header RIFF/WAVE file, 16-bit PCM, one channel.
pub fn encode_wav(samples: &[i16], sample_rate: u32) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes()); // fmt chunk size
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&(sample_rate * 2).to_le_bytes()); // byte rate
    out.extend_from_slice(&2u16.to_le_bytes()); // block align
    out.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

/// One second of a quiet, gently varying hum with soft edges. It carries no speech, so a
/// successful test returns an empty or near-empty transcript; what it proves is that the key,
/// the permission and the model work.
pub fn test_clip() -> Vec<u8> {
    let rate = TEST_SAMPLE_RATE as f32;
    let n = TEST_SAMPLE_RATE as usize;
    let samples: Vec<i16> = (0..n)
        .map(|i| {
            let t = i as f32 / rate;
            let fade = (t / 0.05).min(1.0) * ((1.0 - t) / 0.05).min(1.0);
            let wobble = 1.0 + 0.04 * (std::f32::consts::TAU * 3.0 * t).sin();
            let tone = (std::f32::consts::TAU * 180.0 * wobble * t).sin() * 0.6
                + (std::f32::consts::TAU * 360.0 * t).sin() * 0.25;
            (tone * fade * 0.12 * i16::MAX as f32) as i16
        })
        .collect();
    encode_wav(&samples, TEST_SAMPLE_RATE)
}

/// Duration from the `fmt ` byte rate and the `data` chunk size. `None` for anything that is not a
/// PCM WAV this function can read.
pub fn wav_duration_secs(bytes: &[u8]) -> Option<f64> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return None;
    }
    let mut pos = 12;
    let mut byte_rate = None;
    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let size = u32::from_le_bytes(bytes[pos + 4..pos + 8].try_into().ok()?) as usize;
        let body = pos + 8;
        if id == b"fmt " && body + 12 <= bytes.len() {
            byte_rate = Some(u32::from_le_bytes(bytes[body + 8..body + 12].try_into().ok()?));
        } else if id == b"data" {
            let rate = byte_rate.filter(|r| *r > 0)?;
            // Streams written before their length was known put 0 or u32::MAX here.
            let len = size.min(bytes.len() - body);
            return Some(len as f64 / rate as f64);
        }
        pos = body + size + (size & 1);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_a_valid_header() {
        let wav = encode_wav(&[0, 1, -1, i16::MAX], 16_000);
        assert_eq!(wav.len(), 44 + 8);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(wav[4..8].try_into().unwrap()), 36 + 8);
        assert_eq!(&wav[36..40], b"data");
        assert_eq!(&wav[44..46], &0i16.to_le_bytes());
        assert_eq!(&wav[50..52], &i16::MAX.to_le_bytes());
    }

    #[test]
    fn test_clip_is_one_quiet_second() {
        let wav = test_clip();
        assert_eq!(wav_duration_secs(&wav), Some(1.0));
        let peak = wav[44..].as_chunks::<2>().0.iter().map(|b| i16::from_le_bytes(*b).unsigned_abs()).max().unwrap();
        assert!(peak > 1000 && peak < i16::MAX as u16 / 4, "peak {peak}");
        // Soft edges: the first sample is silent.
        assert_eq!(&wav[44..46], &[0, 0]);
    }

    #[test]
    fn duration_skips_extra_chunks_and_rejects_garbage() {
        let mut wav = encode_wav(&vec![0; 8_000], 16_000);
        // Insert a LIST chunk between fmt and data, as some encoders do.
        let list = [b"LIST".as_slice(), &4u32.to_le_bytes(), b"INFO"].concat();
        wav.splice(36..36, list);
        assert_eq!(wav_duration_secs(&wav), Some(0.5));
        assert_eq!(wav_duration_secs(b"OggS...."), None);
        assert_eq!(wav_duration_secs(&wav[..20]), None);
    }
}
