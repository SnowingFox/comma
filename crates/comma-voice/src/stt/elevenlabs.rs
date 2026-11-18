//! ElevenLabs Speech to Text: `POST /v1/speech-to-text`, multipart (spec 3.2). Ported from our
//! prototype's `stt/elevenlabs.ts` and `stt/index.ts`. Fields per the API reference: `model_id`,
//! `file`, `language_code`, `keyterms` (repeated).

use std::collections::HashSet;
use std::time::{Duration, Instant};

use reqwest::StatusCode;
use reqwest::multipart::{Form, Part};
use serde_json::Value;

use super::{Attempt, Audio, SpeechToText, SttOptions, Transcript, needs_retry, normalize_preferred, to_iso1};
use crate::error::{VoiceError, VoiceResult};
use crate::http;

pub const ELEVENLABS_BASE_URL: &str = "https://api.elevenlabs.io";
const SERVICE: &str = "ElevenLabs";

/// ElevenLabs limits: at most 1000 terms, each at most 50 characters and 5 words, none of
/// `< > { } [ ] \`. Whitespace is collapsed and duplicates are dropped.
pub fn sanitize_keyterms(terms: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    terms
        .iter()
        .map(|raw| raw.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|t| {
            !t.is_empty()
                && t.chars().count() <= 50
                && t.split(' ').count() <= 5
                && !t.chars().any(|c| matches!(c, '<' | '>' | '{' | '}' | '[' | ']' | '\\'))
        })
        .filter(|t| seen.insert(t.clone()))
        .take(1000)
        .collect()
}

/// The ElevenLabs batch API with one key and one model.
#[derive(Clone)]
pub struct ElevenLabs {
    http: reqwest::Client,
    base_url: String,
    api_key: String,
    model_id: String,
}

impl std::fmt::Debug for ElevenLabs {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ElevenLabs").field("base_url", &self.base_url).field("model_id", &self.model_id).finish_non_exhaustive()
    }
}

/// One call's answer.
struct Single {
    text: String,
    language: String,
    probability: Option<f64>,
    duration: Option<Duration>,
    request_id: Option<String>,
}

impl ElevenLabs {
    pub fn new(http: reqwest::Client, api_key: impl Into<String>, model_id: impl Into<String>) -> Self {
        Self { http, base_url: ELEVENLABS_BASE_URL.into(), api_key: api_key.into(), model_id: model_id.into() }
    }

    /// Points at another server (a mock in tests).
    pub fn with_base_url(mut self, base_url: impl Into<String>) -> Self {
        self.base_url = base_url.into().trim_end_matches('/').to_owned();
        self
    }

    pub fn model_id(&self) -> &str {
        &self.model_id
    }

    /// Upload plus transcription; a minute of speech takes a few seconds.
    fn timeout(audio: &Audio) -> Duration {
        let secs = audio.duration().map_or(30.0, |d| d.as_secs_f64()).clamp(0.0, 600.0);
        Duration::from_secs(20 + (secs / 4.0) as u64)
    }

    fn form(&self, audio: &Audio, language: Option<&str>, keyterms: &[String]) -> VoiceResult<Form> {
        let extension = if audio.mime.contains("wav") {
            "wav"
        } else if audio.mime.contains("ogg") {
            "ogg"
        } else {
            "bin"
        };
        let file = Part::bytes(audio.bytes.clone())
            .file_name(format!("audio.{extension}"))
            .mime_str(&audio.mime)
            .map_err(|_| VoiceError::InvalidInput(format!("unsupported audio type {}", audio.mime)))?;
        let mut form = Form::new().text("model_id", self.model_id.clone()).part("file", file);
        if let Some(code) = language {
            form = form.text("language_code", code.to_owned());
        }
        for term in keyterms {
            form = form.text("keyterms", term.clone());
        }
        Ok(form)
    }

    async fn call(&self, audio: &Audio, language: Option<&str>, keyterms: &[String], opts: &SttOptions) -> VoiceResult<Single> {
        let timeout = Self::timeout(audio);
        let send = self
            .http
            .post(format!("{}/v1/speech-to-text", self.base_url))
            .header("xi-api-key", &self.api_key)
            .multipart(self.form(audio, language, keyterms)?)
            .timeout(timeout)
            .send();
        let res = http::cancellable(opts.cancel.as_ref(), send).await?.map_err(|e| http::send_error(&e, SERVICE, timeout))?;
        let status = res.status();
        let header_id = ["request-id", "x-request-id"]
            .iter()
            .find_map(|h| res.headers().get(*h))
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let body = http::cancellable(opts.cancel.as_ref(), res.text()).await?.map_err(|e| http::send_error(&e, SERVICE, timeout))?;
        if !status.is_success() {
            return Err(map_status(status, &body, &self.model_id, &self.api_key, header_id));
        }
        let mut single = parse_transcript(&body)?;
        single.request_id = header_id;
        Ok(single)
    }
}

impl SpeechToText for ElevenLabs {
    /// Auto-detect, retried exactly once with the first preferred language when the detection is
    /// not preferred or below 0.5 probability. The forced attempt wins when it comes back in that
    /// language or is more confident; otherwise the first stays. A failing retry keeps the first
    /// result; cancelling still cancels.
    async fn transcribe(&self, audio: Audio, opts: &SttOptions) -> VoiceResult<Transcript> {
        if audio.bytes.is_empty() {
            return Err(VoiceError::InvalidInput("the recording is empty".into()));
        }
        let started = Instant::now();
        let keyterms = sanitize_keyterms(&opts.keyterms);
        let preferred = normalize_preferred(&opts.languages);
        let fixed = (!opts.auto_detect).then(|| preferred.first().cloned()).flatten();

        let t0 = Instant::now();
        let first = self.call(&audio, fixed.as_deref(), &keyterms, opts).await?;
        let mut attempts = vec![attempt(&first, fixed.clone(), t0.elapsed())];
        let mut chosen = first;
        let mut chosen_index = 0;

        if fixed.is_none()
            && needs_retry(&chosen.text, &chosen.language, chosen.probability, &preferred)
            && let Some(lang) = preferred.first()
        {
            let t1 = Instant::now();
            match self.call(&audio, Some(lang), &keyterms, opts).await {
                Ok(second) => {
                    attempts.push(attempt(&second, Some(lang.clone()), t1.elapsed()));
                    let forced = to_iso1(&second.language).as_deref() == Some(lang.as_str());
                    if forced || second.probability.unwrap_or(0.0) > chosen.probability.unwrap_or(0.0) {
                        chosen = second;
                        chosen_index = 1;
                    }
                }
                Err(VoiceError::Cancelled) => return Err(VoiceError::Cancelled),
                Err(err) => attempts.push(Attempt {
                    requested: Some(lang.clone()),
                    detected: String::new(),
                    probability: None,
                    elapsed: t1.elapsed(),
                    request_id: None,
                    used: false,
                    error: Some(err.to_string()),
                }),
            }
        }

        attempts[chosen_index].used = true;
        Ok(Transcript {
            text: chosen.text,
            language: chosen.language,
            language_probability: chosen.probability,
            duration: chosen.duration.or_else(|| audio.duration()),
            attempts,
            timing: started.elapsed(),
        })
    }
}

fn attempt(s: &Single, requested: Option<String>, elapsed: Duration) -> Attempt {
    Attempt {
        requested,
        detected: s.language.clone(),
        probability: s.probability,
        elapsed,
        request_id: s.request_id.clone(),
        used: false,
        error: None,
    }
}

/// Joins multichannel `transcripts` into one text; duration from `audio_duration_secs`, else the
/// last word's end time.
fn parse_transcript(body: &str) -> VoiceResult<Single> {
    let json: Value = serde_json::from_str(body).map_err(|_| VoiceError::InvalidResponse { service: SERVICE.into(), detail: String::new() })?;
    let chunks: Vec<&Value> = match json.get("transcripts").and_then(Value::as_array) {
        Some(list) => list.iter().collect(),
        None => vec![&json],
    };
    let text = chunks
        .iter()
        .map(|c| c.get("text").and_then(Value::as_str).unwrap_or_default())
        .collect::<Vec<_>>()
        .join("\n");
    let first = chunks.first().copied();
    let last_word_end = chunks
        .iter()
        .flat_map(|c| c.get("words").and_then(Value::as_array).into_iter().flatten())
        .filter_map(|w| w.get("end").and_then(Value::as_f64))
        .fold(0.0_f64, f64::max);
    let duration = json
        .get("audio_duration_secs")
        .and_then(Value::as_f64)
        .or((last_word_end > 0.0).then_some(last_word_end))
        .map(Duration::from_secs_f64);
    Ok(Single {
        text: text.trim().to_owned(),
        language: first.and_then(|c| c.get("language_code")).and_then(Value::as_str).unwrap_or_default().to_owned(),
        probability: first.and_then(|c| c.get("language_probability")).and_then(Value::as_f64),
        duration,
        request_id: None,
    })
}

/// ElevenLabs errors look like `{"detail":{"status":"missing_permissions","message":".."}}`, or a
/// list of validation errors under `detail`.
fn map_status(status: StatusCode, body: &str, model_id: &str, api_key: &str, header_id: Option<String>) -> VoiceError {
    let json: Option<Value> = serde_json::from_str(body).ok();
    let detail = json.as_ref().and_then(|j| j.get("detail"));
    let upstream_status = detail.and_then(|d| d.get("status")).and_then(Value::as_str).unwrap_or_default();
    let request_id = detail.and_then(|d| d.get("request_id")).and_then(Value::as_str).map(str::to_owned).or(header_id);
    let upstream_message = match detail {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => items.iter().filter_map(|i| i.get("msg").and_then(Value::as_str)).collect::<Vec<_>>().join("; "),
        Some(d) => d.get("message").and_then(Value::as_str).unwrap_or_default().to_owned(),
        None => String::new(),
    };
    let lower = upstream_message.to_lowercase();
    let service = SERVICE.to_owned();

    if upstream_status == "quota_exceeded" || status == StatusCode::TOO_MANY_REQUESTS {
        return VoiceError::Quota { service };
    }
    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        if upstream_status == "missing_permissions" || lower.contains("missing the permission") {
            return VoiceError::MissingPermission { service, permission: "Speech to Text".into() };
        }
        return VoiceError::InvalidKey { service, sent: !api_key.is_empty() };
    }
    if matches!(status.as_u16(), 400 | 404 | 422) && (upstream_status.contains("model") || (lower.contains("model") && !lower.contains("file"))) {
        return VoiceError::UnknownModel { service, model: model_id.into() };
    }
    VoiceError::Provider { service, status: status.as_u16(), request_id, message: http::clip_detail(&upstream_message, &[api_key], 160) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wav;
    use tokio_util::sync::CancellationToken;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, Request, ResponseTemplate};

    fn client(server: &MockServer, model: &str) -> ElevenLabs {
        ElevenLabs::new(http::client(), "el-test-key", model).with_base_url(server.uri())
    }

    #[test]
    fn timeout_grows_with_the_clip_also_for_ogg() {
        assert_eq!(ElevenLabs::timeout(&Audio::wav(wav::test_clip())), Duration::from_secs(20));
        assert_eq!(ElevenLabs::timeout(&Audio::ogg(b"OggS".to_vec(), 400.0)), Duration::from_secs(120));
        // Unknown length: assume 30 s.
        assert_eq!(ElevenLabs::timeout(&Audio { bytes: vec![], mime: "audio/ogg".into(), secs: None }), Duration::from_secs(27));
    }

    fn opts(languages: &[&str]) -> SttOptions {
        SttOptions { languages: languages.iter().map(|s| (*s).to_owned()).collect(), auto_detect: true, ..Default::default() }
    }

    #[test]
    fn keyterm_limits() {
        let terms: Vec<String> = ["  Comma  app ", "Comma app", "", "one two three four five six", &"x".repeat(51), "a[b]", "ElevenLabs"]
            .iter()
            .map(|s| (*s).to_owned())
            .collect();
        assert_eq!(sanitize_keyterms(&terms), ["Comma app", "ElevenLabs"]);
        let many: Vec<String> = (0..1500).map(|i| format!("term{i}")).collect();
        assert_eq!(sanitize_keyterms(&many).len(), 1000);
        assert_eq!(sanitize_keyterms(&["x".repeat(50)]).len(), 1, "50 characters is allowed");
    }

    #[test]
    fn parses_single_and_multichannel_answers() {
        let one = parse_transcript(r#"{"language_code":"eng","language_probability":0.98,"text":" Hello there. ","words":[{"end":0.4},{"end":1.25}]}"#).unwrap();
        assert_eq!((one.text.as_str(), one.language.as_str(), one.probability), ("Hello there.", "eng", Some(0.98)));
        assert_eq!(one.duration, Some(Duration::from_secs_f64(1.25)));
        let multi = parse_transcript(r#"{"audio_duration_secs":3.5,"transcripts":[{"text":"a","language_code":"fra"},{"text":"b"}]}"#).unwrap();
        assert_eq!((multi.text.as_str(), multi.language.as_str()), ("a\nb", "fra"));
        assert!(matches!(parse_transcript("<html>"), Err(VoiceError::InvalidResponse { .. })));
    }

    #[test]
    fn error_mapping() {
        let missing = r#"{"detail":{"status":"missing_permissions","message":"The API key you used is missing the permission speech_to_text to execute this operation."}}"#;
        let e = map_status(StatusCode::UNAUTHORIZED, missing, "scribe_v3", "k", None);
        assert_eq!(e, VoiceError::MissingPermission { service: "ElevenLabs".into(), permission: "Speech to Text".into() });
        assert!(e.to_string().starts_with("This ElevenLabs key lacks the Speech to Text permission"));

        let invalid = r#"{"detail":{"status":"invalid_api_key","message":"Invalid API key"}}"#;
        assert!(matches!(map_status(StatusCode::UNAUTHORIZED, invalid, "scribe_v3", "k", None), VoiceError::InvalidKey { sent: true, .. }));

        let model = r#"{"detail":{"status":"invalid_model_id","message":"Model 'scribe_v9' not found"}}"#;
        assert_eq!(map_status(StatusCode::BAD_REQUEST, model, "scribe_v9", "k", None).to_string(), "ElevenLabs has no model named \"scribe_v9\"");

        let validation = r#"{"detail":[{"msg":"file is too short"}]}"#;
        assert_eq!(map_status(StatusCode::UNPROCESSABLE_ENTITY, validation, "scribe_v3", "k", None).to_string(), "ElevenLabs returned HTTP 422: file is too short");

        let quota = r#"{"detail":{"status":"quota_exceeded","message":"This request exceeds your quota"}}"#;
        assert!(matches!(map_status(StatusCode::UNAUTHORIZED, quota, "m", "k", None), VoiceError::Quota { .. }));
        assert!(matches!(map_status(StatusCode::TOO_MANY_REQUESTS, "", "m", "k", None), VoiceError::Quota { .. }));

        let echoed = r#"{"detail":{"message":"key sk_abcdef123 is weird","request_id":"r9"}}"#;
        let e = map_status(StatusCode::INTERNAL_SERVER_ERROR, echoed, "m", "sk_abcdef123", Some("hdr".into()));
        assert!(!e.to_string().contains("sk_abcdef123"));
        assert!(matches!(e, VoiceError::Provider { request_id: Some(ref id), .. } if id == "r9"));
    }

    #[tokio::test]
    async fn request_shape_and_one_language_retry() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/speech-to-text"))
            .and(header("xi-api-key", "el-test-key"))
            .respond_with(|req: &Request| {
                let body = String::from_utf8_lossy(&req.body);
                assert!(body.contains("name=\"model_id\"\r\n\r\nscribe_v3"));
                assert!(body.contains("filename=\"audio.wav\""));
                assert!(body.contains("Content-Type: audio/wav"));
                assert_eq!(body.matches("name=\"keyterms\"").count(), 1);
                if body.contains("name=\"language_code\"\r\n\r\nzh") {
                    ResponseTemplate::new(200).insert_header("request-id", "second").set_body_string(r#"{"text":"你好","language_code":"zho","language_probability":1.0}"#)
                } else {
                    ResponseTemplate::new(200).insert_header("request-id", "first").set_body_string(r#"{"text":"ni hao","language_code":"vie","language_probability":0.4}"#)
                }
            })
            .expect(2)
            .mount(&server)
            .await;
        let mut o = opts(&["zh", "en"]);
        o.keyterms = vec!["Comma".into(), "".into()];
        let out = client(&server, "scribe_v3").transcribe(Audio::wav(wav::test_clip()), &o).await.unwrap();
        assert!(out.retried());
        assert_eq!((out.text.as_str(), out.language.as_str()), ("你好", "zho"));
        assert_eq!(out.attempts.iter().map(|a| a.used).collect::<Vec<_>>(), [false, true]);
        assert_eq!(out.attempts[1].requested.as_deref(), Some("zh"));
        assert_eq!(out.duration, Some(Duration::from_secs(1)), "falls back to the WAV header");
    }

    #[tokio::test]
    async fn confident_preferred_detection_is_not_retried_and_failed_retry_keeps_first() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(|req: &Request| {
                if String::from_utf8_lossy(&req.body).contains("language_code") {
                    ResponseTemplate::new(500).set_body_string(r#"{"detail":{"message":"boom"}}"#)
                } else {
                    ResponseTemplate::new(200).set_body_string(r#"{"text":"hola","language_code":"spa","language_probability":0.9}"#)
                }
            })
            .mount(&server)
            .await;
        let el = client(&server, "scribe_v3");
        let out = el.transcribe(Audio::wav(wav::test_clip()), &opts(&["es"])).await.unwrap();
        assert!(!out.retried());
        let out = el.transcribe(Audio::wav(wav::test_clip()), &opts(&["en"])).await.unwrap();
        assert_eq!(out.text, "hola");
        assert_eq!(out.attempts[1].error.as_deref(), Some("ElevenLabs returned HTTP 500: boom"));
        assert!(out.attempts[0].used);

        // Auto-detect off: the preferred language is sent from the start, one call.
        let mut fixed = opts(&["en"]);
        fixed.auto_detect = false;
        assert!(el.transcribe(Audio::wav(wav::test_clip()), &fixed).await.is_err(), "the mock fails every forced call");
    }

    #[tokio::test]
    async fn missing_permission_and_cancel() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/speech-to-text"))
            .respond_with(ResponseTemplate::new(401).set_body_string(r#"{"detail":{"status":"missing_permissions","message":"missing the permission speech_to_text"}}"#))
            .mount(&server)
            .await;
        let err = client(&server, "scribe_v3").transcribe(Audio::wav(wav::test_clip()), &opts(&[])).await.unwrap_err();
        assert!(matches!(err, VoiceError::MissingPermission { .. }));
        assert!(!err.to_string().contains("el-test-key"));

        let slow = MockServer::start().await;
        Mock::given(method("POST")).respond_with(ResponseTemplate::new(200).set_delay(Duration::from_secs(3))).mount(&slow).await;
        let token = CancellationToken::new();
        let o = SttOptions { cancel: Some(token.clone()), ..opts(&[]) };
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            token.cancel();
        });
        let err = client(&slow, "scribe_v3").transcribe(Audio::wav(wav::test_clip()), &o).await.unwrap_err();
        assert_eq!(err, VoiceError::Cancelled);
    }
}
