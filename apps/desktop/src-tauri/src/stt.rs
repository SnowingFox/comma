//! ElevenLabs Speech to Text: `POST /v1/speech-to-text`, multipart (spec 3.2). Ported from our
//! prototype's `stt/elevenlabs.ts`, `stt/index.ts` and `stt/languages.ts`.

use std::time::{Duration, Instant};

use reqwest::StatusCode;
use reqwest::multipart::{Form, Part};
use serde_json::Value;

use crate::error::{AppError, AppResult, ErrorCode};
use crate::http;

pub const ELEVENLABS_BASE_URL: &str = "https://api.elevenlabs.io";
pub const SERVICE: &str = "ElevenLabs";
/// Below this `language_probability` the detection is not trusted.
pub const MIN_LANGUAGE_PROBABILITY: f64 = 0.5;

/// Audio upload plus transcription; a minute of speech takes a few seconds.
pub fn timeout_for(audio_secs: Option<f64>) -> Duration {
    Duration::from_secs(20 + audio_secs.unwrap_or(30.0).clamp(0.0, 600.0) as u64 / 4)
}

pub struct Client<'a> {
    pub http: &'a reqwest::Client,
    pub base_url: &'a str,
    pub api_key: &'a str,
    pub model_id: &'a str,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Transcript {
    pub text: String,
    /// As ElevenLabs reports it, ISO 639-3 (`eng`, `zho`).
    pub language_code: String,
    pub language_probability: Option<f64>,
    pub duration_secs: Option<f64>,
}

impl Client<'_> {
    pub async fn transcribe(&self, wav: Vec<u8>, language_code: Option<&str>, timeout: Duration) -> AppResult<Transcript> {
        let file = Part::bytes(wav)
            .file_name("audio.wav")
            .mime_str("audio/wav")
            .map_err(|_| AppError::internal("could not build the upload"))?;
        let mut form = Form::new().text("model_id", self.model_id.to_owned()).part("file", file);
        if let Some(code) = language_code {
            form = form.text("language_code", code.to_owned());
        }
        let url = format!("{}/v1/speech-to-text", self.base_url.trim_end_matches('/'));
        let res = self
            .http
            .post(url)
            .header("xi-api-key", self.api_key)
            .multipart(form)
            .timeout(timeout)
            .send()
            .await
            .map_err(|e| http::send_error(&e, SERVICE, timeout))?;
        let status = res.status();
        let body = res.text().await.map_err(|e| http::send_error(&e, SERVICE, timeout))?;
        if !status.is_success() {
            return Err(map_status(status, &body, self.model_id, self.api_key));
        }
        parse_transcript(&body)
    }
}

/// Joins multichannel `transcripts` into one text; duration from `audio_duration_secs`, else the
/// last word's end time.
pub fn parse_transcript(body: &str) -> AppResult<Transcript> {
    let json: Value = serde_json::from_str(body)
        .map_err(|_| AppError::new(ErrorCode::Upstream, "ElevenLabs sent an answer Comma can't read"))?;
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
    Ok(Transcript {
        text: text.trim().to_owned(),
        language_code: first.and_then(|c| c.get("language_code")).and_then(Value::as_str).unwrap_or_default().to_owned(),
        language_probability: first.and_then(|c| c.get("language_probability")).and_then(Value::as_f64),
        duration_secs: json
            .get("audio_duration_secs")
            .and_then(Value::as_f64)
            .or((last_word_end > 0.0).then_some(last_word_end)),
    })
}

/// ElevenLabs errors look like `{"detail":{"status":"missing_permissions","message":".."}}`, or a
/// list of validation errors under `detail`.
pub fn map_status(status: StatusCode, body: &str, model_id: &str, api_key: &str) -> AppError {
    let json: Option<Value> = serde_json::from_str(body).ok();
    let detail = json.as_ref().and_then(|j| j.get("detail"));
    let upstream_status = detail.and_then(|d| d.get("status")).and_then(Value::as_str).unwrap_or_default();
    let upstream_message = match detail {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|i| i.get("msg").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("; "),
        Some(d) => d.get("message").and_then(Value::as_str).unwrap_or_default().to_owned(),
        None => String::new(),
    };
    let lower = upstream_message.to_lowercase();
    let reason = |e: AppError| if upstream_status.is_empty() { e } else { e.with_reason(upstream_status) };

    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        if upstream_status == "missing_permissions" || lower.contains("missing the permission") {
            return reason(AppError::new(
                ErrorCode::MissingPermission,
                "This ElevenLabs key lacks the Speech to Text permission. Turn it on for the key in ElevenLabs, or create a new key with it",
            ));
        }
        return reason(AppError::new(ErrorCode::InvalidKey, "ElevenLabs rejected the API key. Check that you pasted all of it"));
    }
    if status == StatusCode::TOO_MANY_REQUESTS {
        return reason(AppError::new(ErrorCode::RateLimited, "ElevenLabs is rate limiting requests or your quota is used up"));
    }
    if matches!(status.as_u16(), 400 | 404 | 422)
        && (upstream_status.contains("model") || (lower.contains("model") && !lower.contains("file")))
    {
        return reason(AppError::new(ErrorCode::UnknownModel, format!("ElevenLabs has no speech model named \"{model_id}\"")));
    }
    let detail = http::clip_detail(&upstream_message, &[api_key], 160);
    let suffix = if detail.is_empty() { String::new() } else { format!(": {detail}") };
    reason(AppError::new(ErrorCode::Upstream, format!("ElevenLabs returned HTTP {}{suffix}", status.as_u16())))
}

/// The result of [`transcribe_with_retry`]: the transcript used, how long all calls took, and
/// whether a second call forced the fallback language.
pub struct Outcome {
    pub transcript: Transcript,
    pub total_ms: f64,
    pub retried: bool,
}

/// Auto-detect, retried once with the first preferred language when the detection is not one of
/// the preferred languages or its probability is below 0.5 (spec 3.2). A failing retry keeps the
/// first result. With auto-detect off, the first preferred language is sent from the start.
pub async fn transcribe_with_retry(
    client: &Client<'_>,
    wav: Vec<u8>,
    preferred: &[String],
    auto_detect: bool,
    timeout: Duration,
) -> AppResult<Outcome> {
    let started = Instant::now();
    let preferred = normalize_preferred(preferred);
    let fallback = preferred.first().cloned();
    if !auto_detect && let Some(lang) = &fallback {
        let transcript = client.transcribe(wav, Some(lang), timeout).await?;
        return Ok(Outcome { transcript, total_ms: http::ms(started.elapsed()), retried: false });
    }
    let first = client.transcribe(wav.clone(), None, timeout).await?;
    let Some(lang) = fallback.filter(|_| needs_retry(&first, &preferred)) else {
        return Ok(Outcome { transcript: first, total_ms: http::ms(started.elapsed()), retried: false });
    };
    let chosen = match client.transcribe(wav, Some(&lang), timeout).await {
        Ok(second)
            if to_iso1(&second.language_code).as_deref() == Some(lang.as_str())
                || second.language_probability.unwrap_or(0.0) > first.language_probability.unwrap_or(0.0) =>
        {
            second
        }
        _ => first,
    };
    Ok(Outcome { transcript: chosen, total_ms: http::ms(started.elapsed()), retried: true })
}

pub fn needs_retry(first: &Transcript, preferred: &[String]) -> bool {
    if preferred.is_empty() || first.text.trim().is_empty() {
        return false;
    }
    let confident = first.language_probability.is_none_or(|p| p >= MIN_LANGUAGE_PROBABILITY);
    let detected = to_iso1(&first.language_code);
    !confident || !detected.is_some_and(|d| preferred.contains(&d))
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
    use crate::audio;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, Request, ResponseTemplate};

    fn t(text: &str, lang: &str, p: Option<f64>) -> Transcript {
        Transcript { text: text.into(), language_code: lang.into(), language_probability: p, duration_secs: None }
    }

    #[test]
    fn parses_single_and_multichannel_answers() {
        let one = parse_transcript(r#"{"language_code":"eng","language_probability":0.98,"text":" Hello there. ","words":[{"end":0.4},{"end":1.25}]}"#).unwrap();
        assert_eq!(one, Transcript { text: "Hello there.".into(), language_code: "eng".into(), language_probability: Some(0.98), duration_secs: Some(1.25) });
        let multi = parse_transcript(r#"{"audio_duration_secs":3.5,"transcripts":[{"text":"a","language_code":"fra"},{"text":"b"}]}"#).unwrap();
        assert_eq!((multi.text.as_str(), multi.language_code.as_str(), multi.duration_secs), ("a\nb", "fra", Some(3.5)));
        assert_eq!(parse_transcript("<html>").unwrap_err().code, ErrorCode::Upstream);
    }

    #[test]
    fn error_mapping() {
        let missing = r#"{"detail":{"status":"missing_permissions","message":"The API key you used is missing the permission speech_to_text to execute this operation."}}"#;
        let e = map_status(StatusCode::UNAUTHORIZED, missing, "scribe_v3", "k");
        assert_eq!(e.code, ErrorCode::MissingPermission);
        assert_eq!(e.reason.as_deref(), Some("missing_permissions"));

        let invalid = r#"{"detail":{"status":"invalid_api_key","message":"Invalid API key"}}"#;
        assert_eq!(map_status(StatusCode::UNAUTHORIZED, invalid, "scribe_v3", "k").code, ErrorCode::InvalidKey);

        let model = r#"{"detail":{"status":"invalid_model_id","message":"Model 'scribe_v9' not found"}}"#;
        let e = map_status(StatusCode::BAD_REQUEST, model, "scribe_v9", "k");
        assert_eq!((e.code, e.message.as_str()), (ErrorCode::UnknownModel, "ElevenLabs has no speech model named \"scribe_v9\""));

        let validation = r#"{"detail":[{"msg":"file is too short"}]}"#;
        let e = map_status(StatusCode::UNPROCESSABLE_ENTITY, validation, "scribe_v3", "k");
        assert_eq!((e.code, e.message.as_str()), (ErrorCode::Upstream, "ElevenLabs returned HTTP 422: file is too short"));

        assert_eq!(map_status(StatusCode::TOO_MANY_REQUESTS, "", "m", "k").code, ErrorCode::RateLimited);
        let echoed = r#"{"detail":{"message":"key sk_abcdef123 is weird"}}"#;
        assert!(!map_status(StatusCode::INTERNAL_SERVER_ERROR, echoed, "m", "sk_abcdef123").message.contains("sk_abcdef123"));
    }

    #[test]
    fn language_codes() {
        assert_eq!(to_iso1("zho").as_deref(), Some("zh"));
        assert_eq!(to_iso1("zh-Hans").as_deref(), Some("zh"));
        assert_eq!(to_iso1("EN_us").as_deref(), Some("en"));
        assert_eq!(to_iso1("xx"), None);
        assert_eq!(normalize_preferred(&["eng".into(), "en".into(), "zh-Hant".into(), "??".into()]), ["en", "zh"]);
    }

    #[test]
    fn retry_rules() {
        let pref = vec!["zh".to_owned(), "en".to_owned()];
        assert!(!needs_retry(&t("你好", "zho", Some(0.9)), &pref));
        assert!(needs_retry(&t("ciao", "ita", Some(0.9)), &pref));
        assert!(needs_retry(&t("hi", "eng", Some(0.3)), &pref));
        assert!(!needs_retry(&t("", "ita", Some(0.1)), &pref));
        assert!(!needs_retry(&t("ciao", "ita", Some(0.9)), &[]));
    }

    #[tokio::test]
    async fn uploads_multipart_with_key_header_and_retries_language() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/speech-to-text"))
            .and(header("xi-api-key", "el-test-key"))
            .respond_with(|req: &Request| {
                let body = String::from_utf8_lossy(&req.body);
                assert!(body.contains("name=\"model_id\"\r\n\r\nscribe_v3"));
                assert!(body.contains("filename=\"audio.wav\""));
                if body.contains("name=\"language_code\"") {
                    ResponseTemplate::new(200).set_body_string(r#"{"text":"你好","language_code":"zho","language_probability":1.0}"#)
                } else {
                    ResponseTemplate::new(200).set_body_string(r#"{"text":"ni hao","language_code":"vie","language_probability":0.4}"#)
                }
            })
            .expect(2)
            .mount(&server)
            .await;
        let http = http::client();
        let base = server.uri();
        let client = Client { http: &http, base_url: &base, api_key: "el-test-key", model_id: "scribe_v3" };
        let out = transcribe_with_retry(&client, audio::test_clip(), &["zh".into()], true, Duration::from_secs(5))
            .await
            .unwrap();
        assert!(out.retried);
        assert_eq!(out.transcript.text, "你好");
    }

    #[tokio::test]
    async fn missing_permission_from_a_mocked_server() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(401).set_body_string(r#"{"detail":{"status":"missing_permissions","message":"missing the permission speech_to_text"}}"#))
            .mount(&server)
            .await;
        let http = http::client();
        let base = server.uri();
        let client = Client { http: &http, base_url: &base, api_key: "el-test-key", model_id: "scribe_v3" };
        let err = client.transcribe(audio::test_clip(), None, Duration::from_secs(5)).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::MissingPermission);
        assert!(!err.message.contains("el-test-key"));
    }
}
