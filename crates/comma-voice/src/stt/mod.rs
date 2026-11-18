//! Speech to text: the [`SpeechToText`] trait, its options and result, and the language helpers
//! behind the one retry rule. Ported from our prototype's `stt/index.ts` and `stt/languages.ts`.

mod elevenlabs;

use std::future::Future;
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use crate::error::VoiceResult;
use crate::wav;

pub use elevenlabs::{ELEVENLABS_BASE_URL, ElevenLabs, sanitize_keyterms};

/// An audio clip to transcribe.
#[derive(Clone, PartialEq)]
pub struct Audio {
    pub bytes: Vec<u8>,
    pub mime: String,
    /// Length in seconds when the container does not say it cheaply (Ogg/Opus from the app).
    pub secs: Option<f64>,
}

impl std::fmt::Debug for Audio {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Audio").field("bytes", &self.bytes.len()).field("mime", &self.mime).finish()
    }
}

impl Audio {
    pub fn wav(bytes: Vec<u8>) -> Self {
        Self { bytes, mime: "audio/wav".into(), secs: None }
    }

    /// Ogg/Opus with its length, which the caller knows from the recording.
    pub fn ogg(bytes: Vec<u8>, secs: f64) -> Self {
        Self { bytes, mime: "audio/ogg".into(), secs: Some(secs) }
    }

    /// Length from the WAV header, or the length given with the audio.
    pub fn duration(&self) -> Option<Duration> {
        wav::duration_secs(&self.bytes)
            .or(self.secs.filter(|s| s.is_finite() && *s >= 0.0))
            .map(Duration::from_secs_f64)
    }
}

#[derive(Debug, Clone, Default)]
pub struct SttOptions {
    /// Languages the speaker uses, most preferred first (`en`, `zh-Hans`, `eng`).
    pub languages: Vec<String>,
    /// With auto-detect off and a preferred language, that language is sent from the start.
    pub auto_detect: bool,
    /// Names and terms to bias recognition (the dictionary). Cleaned with [`sanitize_keyterms`].
    pub keyterms: Vec<String>,
    pub cancel: Option<CancellationToken>,
}

/// One provider call.
#[derive(Debug, Clone, PartialEq)]
pub struct Attempt {
    /// The language sent; `None` for auto-detect.
    pub requested: Option<String>,
    /// As the provider reports it (ISO 639-3 for ElevenLabs).
    pub detected: String,
    pub probability: Option<f64>,
    pub elapsed: Duration,
    pub request_id: Option<String>,
    /// Whether this attempt's text is the one returned.
    pub used: bool,
    /// Set when the retry failed; the first result is kept then.
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Transcript {
    pub text: String,
    /// As the provider reports it (ISO 639-3 for ElevenLabs).
    pub language: String,
    pub language_probability: Option<f64>,
    /// From the provider, else the last word's end, else the WAV header.
    pub duration: Option<Duration>,
    pub attempts: Vec<Attempt>,
    /// All calls together.
    pub timing: Duration,
}

impl Transcript {
    pub fn retried(&self) -> bool {
        self.attempts.len() > 1
    }
}

pub trait SpeechToText: Send + Sync {
    fn transcribe(&self, audio: Audio, opts: &SttOptions) -> impl Future<Output = VoiceResult<Transcript>> + Send;
}

/// Below this `language_probability` the detection is not trusted.
pub const MIN_LANGUAGE_PROBABILITY: f64 = 0.5;

/// Whether an auto-detected result is retried with the first preferred language: the detection is
/// not one of the preferred languages, or its probability is below 0.5. Empty transcripts and an
/// empty preference list never retry.
pub fn needs_retry(text: &str, detected: &str, probability: Option<f64>, preferred: &[String]) -> bool {
    if preferred.is_empty() || text.trim().is_empty() {
        return false;
    }
    let confident = probability.is_none_or(|p| p >= MIN_LANGUAGE_PROBABILITY);
    !confident || !to_iso1(detected).is_some_and(|d| preferred.contains(&d))
}

/// ISO 639-3 as ElevenLabs reports it, to the two-letter codes users pick.
const THREE_TO_TWO: &[(&str, &str)] = &[
    ("zho", "zh"), ("cmn", "zh"), ("yue", "zh"), ("wuu", "zh"), ("eng", "en"), ("spa", "es"), ("hin", "hi"),
    ("ara", "ar"), ("por", "pt"), ("rus", "ru"), ("jpn", "ja"), ("deu", "de"), ("fra", "fr"), ("kor", "ko"),
    ("ita", "it"), ("tur", "tr"), ("vie", "vi"), ("ind", "id"), ("pol", "pl"), ("nld", "nl"), ("tha", "th"),
    ("ukr", "uk"), ("swe", "sv"), ("ces", "cs"), ("ell", "el"), ("heb", "he"), ("ron", "ro"), ("hun", "hu"),
    ("dan", "da"), ("fin", "fi"), ("nor", "no"), ("nob", "no"), ("nno", "no"), ("bul", "bg"), ("hrv", "hr"),
    ("slk", "sk"), ("cat", "ca"), ("msa", "ms"), ("zlm", "ms"), ("fil", "tl"), ("tgl", "tl"), ("ben", "bn"),
    ("tam", "ta"), ("urd", "ur"), ("fas", "fa"), ("pes", "fa"), ("srp", "sr"), ("slv", "sl"), ("lit", "lt"),
    ("lav", "lv"), ("est", "et"),
];

/// `zho`, `zh`, `zh-Hans`, `ZH_tw` all give `zh`. `None` when the code is not recognised.
pub fn to_iso1(code: &str) -> Option<String> {
    let base = code.trim().to_lowercase();
    let base = base.split(['-', '_']).next().unwrap_or_default();
    match base.len() {
        2 => THREE_TO_TWO.iter().any(|(_, two)| *two == base).then(|| base.to_owned()),
        3 => THREE_TO_TWO.iter().find(|(three, _)| *three == base).map(|(_, two)| (*two).to_owned()),
        _ => None,
    }
}

/// Two-letter codes, deduplicated, unknown entries dropped.
pub fn normalize_preferred(list: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for code in list.iter().filter_map(|c| to_iso1(c)) {
        if !out.contains(&code) {
            out.push(code);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn language_codes() {
        assert_eq!(to_iso1("zho").as_deref(), Some("zh"));
        assert_eq!(to_iso1("zh-Hans").as_deref(), Some("zh"));
        assert_eq!(to_iso1("EN_us").as_deref(), Some("en"));
        assert_eq!(to_iso1("xx"), None);
        assert_eq!(normalize_preferred(&["eng".into(), "en".into(), "zh-Hant".into(), "??".into()]), ["en", "zh"]);
    }

    #[test]
    fn retry_rule() {
        let pref = vec!["zh".to_owned(), "en".to_owned()];
        assert!(!needs_retry("你好", "zho", Some(0.9), &pref));
        assert!(needs_retry("ciao", "ita", Some(0.9), &pref));
        assert!(needs_retry("hi", "eng", Some(0.3), &pref));
        assert!(needs_retry("hi", "", None, &pref), "an unknown language is not preferred");
        assert!(!needs_retry("", "ita", Some(0.1), &pref));
        assert!(!needs_retry("ciao", "ita", Some(0.9), &[]));
    }

    #[test]
    fn audio_debug_hides_the_bytes() {
        let audio = Audio::wav(wav::test_clip());
        assert_eq!(format!("{audio:?}"), "Audio { bytes: 32044, mime: \"audio/wav\" }");
        assert_eq!(audio.duration(), Some(Duration::from_secs(1)));
        assert_eq!(Audio::ogg(b"OggS".to_vec(), 2.5).duration(), Some(Duration::from_millis(2500)));
    }
}
