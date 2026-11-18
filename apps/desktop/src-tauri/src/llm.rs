//! OpenAI-compatible client: `GET {base}/models` and streamed `POST {base}/chat/completions`
//! with time to first token (spec 3.2). Ported from our prototype's `llm.ts`.

use std::time::{Duration, Instant};

use reqwest::StatusCode;
use serde::Serialize;
use serde_json::{Value, json};

use crate::error::{AppError, AppResult, ErrorCode};
use crate::http;
use crate::settings::{MAGPIE_BASE_URL, ReasoningEffort};

/// Where to send requests. `api_key` is read from the Keychain by the caller and only ever goes
/// into the `Authorization` header.
pub struct Endpoint {
    pub base_url: String,
    pub api_key: Option<String>,
}

impl std::fmt::Debug for Endpoint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Endpoint").field("base_url", &self.base_url).field("has_key", &self.api_key.is_some()).finish()
    }
}

impl Endpoint {
    fn url(&self, path: &str) -> String {
        format!("{}/{path}", self.base_url.trim_end_matches('/'))
    }

    /// The name used in messages: "magpie" for the local gateway, else the host.
    pub fn label(&self) -> String {
        if self.base_url.trim_end_matches('/') == MAGPIE_BASE_URL {
            "magpie".into()
        } else {
            http::host_of(&self.base_url).to_owned()
        }
    }

    fn secrets(&self) -> Vec<&str> {
        self.api_key.as_deref().into_iter().collect()
    }

    fn authorize(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match &self.api_key {
            Some(key) => req.bearer_auth(key),
            None => req,
        }
    }
}

/// Short for loopback (a local gateway answers at once or is not running), longer for the internet.
pub fn models_timeout(base_url: &str) -> Duration {
    if http::is_loopback(base_url) { Duration::from_millis(2500) } else { Duration::from_secs(10) }
}

pub async fn list_models(client: &reqwest::Client, ep: &Endpoint, timeout: Duration) -> AppResult<Vec<String>> {
    let res = ep
        .authorize(client.get(ep.url("models")).timeout(timeout))
        .send()
        .await
        .map_err(|e| send_error(&e, ep, timeout))?;
    let status = res.status();
    let body = res.text().await.map_err(|e| send_error(&e, ep, timeout))?;
    if !status.is_success() {
        return Err(map_status(status, &body, ep, None));
    }
    parse_models(&body).ok_or_else(|| {
        AppError::new(ErrorCode::Upstream, format!("{} did not return a model list. Check that the URL ends in /v1", ep.label()))
    })
}

/// `{ "data": [{ "id": .. }] }`, or a bare array of ids or objects. Sorted, deduplicated.
pub fn parse_models(body: &str) -> Option<Vec<String>> {
    let json: Value = serde_json::from_str(body).ok()?;
    let list = json.get("data").unwrap_or(&json).as_array()?;
    let mut ids: Vec<String> = list
        .iter()
        .filter_map(|m| m.as_str().or_else(|| m.get("id").and_then(Value::as_str)))
        .map(str::to_owned)
        .collect();
    ids.sort();
    ids.dedup();
    Some(ids)
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Message {
    pub role: &'static str,
    pub content: String,
}

impl Message {
    pub fn system(content: impl Into<String>) -> Self {
        Self { role: "system", content: content.into() }
    }
    pub fn user(content: impl Into<String>) -> Self {
        Self { role: "user", content: content.into() }
    }
}

pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<Message>,
    pub reasoning_effort: ReasoningEffort,
    pub max_tokens: Option<u32>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ChatOutcome {
    pub text: String,
    /// The model the endpoint says answered, else the one requested.
    pub model: String,
    /// Request start to the first content token; `None` when no content arrived.
    pub ttft_ms: Option<f64>,
    pub total_ms: f64,
    pub prompt_tokens: Option<u64>,
    pub completion_tokens: Option<u64>,
    pub reasoning_tokens: Option<u64>,
}

/// Off is sent as `"none"`, Default leaves the field out (spec 3.2).
pub fn build_body(req: &ChatRequest) -> Value {
    let mut body = json!({
        "model": req.model,
        "messages": req.messages,
        "stream": true,
        "stream_options": { "include_usage": true },
    });
    let effort = match req.reasoning_effort {
        ReasoningEffort::Off => Some("none"),
        ReasoningEffort::Low => Some("low"),
        ReasoningEffort::Medium => Some("medium"),
        ReasoningEffort::High => Some("high"),
        ReasoningEffort::Default => None,
    };
    if let Some(effort) = effort {
        body["reasoning_effort"] = json!(effort);
    }
    if let Some(max) = req.max_tokens {
        body["max_tokens"] = json!(max);
    }
    body
}

pub async fn chat(client: &reqwest::Client, ep: &Endpoint, req: &ChatRequest, timeout: Duration) -> AppResult<ChatOutcome> {
    let started = Instant::now();
    let mut res = ep
        .authorize(client.post(ep.url("chat/completions")).timeout(timeout))
        .header("accept", "text/event-stream")
        .json(&build_body(req))
        .send()
        .await
        .map_err(|e| send_error(&e, ep, timeout))?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(map_status(status, &body, ep, Some(&req.model)));
    }

    // Some endpoints ignore `stream: true` and answer with one JSON body, sometimes still labelled
    // as an event stream, so the first byte decides: `{` is JSON, anything else is SSE.
    let mut acc = Accumulator::new(&req.model);
    let mut parser = SseParser::default();
    let mut whole: Option<Vec<u8>> = None;
    let mut decided = false;
    while let Some(chunk) = res.chunk().await.map_err(|e| send_error(&e, ep, timeout))? {
        if !decided && let Some(first) = chunk.iter().find(|b| !b.is_ascii_whitespace()) {
            decided = true;
            if *first == b'{' {
                whole = Some(Vec::new());
            }
        }
        match whole.as_mut() {
            Some(buf) => buf.extend_from_slice(&chunk),
            None => {
                for data in parser.feed(&chunk) {
                    acc.event(&data, started, ep)?;
                }
            }
        }
    }
    match whole {
        Some(body) => acc.whole(&String::from_utf8_lossy(&body), started, ep)?,
        None => {
            for data in parser.finish() {
                acc.event(&data, started, ep)?;
            }
        }
    }
    Ok(acc.finish(started))
}

/// Collects streamed deltas into the final text, usage and timing.
struct Accumulator {
    text: String,
    model: String,
    ttft_ms: Option<f64>,
    prompt_tokens: Option<u64>,
    completion_tokens: Option<u64>,
    reasoning_tokens: Option<u64>,
}

impl Accumulator {
    fn new(model: &str) -> Self {
        Self {
            text: String::new(),
            model: model.to_owned(),
            ttft_ms: None,
            prompt_tokens: None,
            completion_tokens: None,
            reasoning_tokens: None,
        }
    }

    fn event(&mut self, data: &str, started: Instant, ep: &Endpoint) -> AppResult<()> {
        let data = data.trim();
        if data.is_empty() || data == "[DONE]" {
            return Ok(());
        }
        let Ok(json) = serde_json::from_str::<Value>(data) else { return Ok(()) };
        if let Some(err) = json.get("error") {
            let message = err.get("message").and_then(Value::as_str).unwrap_or("unknown error");
            return Err(AppError::new(
                ErrorCode::Upstream,
                format!("{} stopped with an error: {}", ep.label(), http::clip_detail(message, &ep.secrets(), 200)),
            ));
        }
        self.read_meta(&json);
        if let Some(piece) = json.pointer("/choices/0/delta/content").and_then(Value::as_str)
            && !piece.is_empty()
        {
            self.ttft_ms.get_or_insert_with(|| http::ms(started.elapsed()));
            self.text.push_str(piece);
        }
        Ok(())
    }

    fn whole(&mut self, body: &str, started: Instant, ep: &Endpoint) -> AppResult<()> {
        let json: Value = serde_json::from_str(body)
            .map_err(|_| AppError::new(ErrorCode::Upstream, format!("{} sent an answer Comma can't read", ep.label())))?;
        self.read_meta(&json);
        if let Some(text) = json.pointer("/choices/0/message/content").and_then(Value::as_str) {
            self.text = text.to_owned();
            if !text.is_empty() {
                self.ttft_ms = Some(http::ms(started.elapsed()));
            }
        }
        Ok(())
    }

    fn read_meta(&mut self, json: &Value) {
        if let Some(model) = json.get("model").and_then(Value::as_str)
            && !model.is_empty()
        {
            self.model = model.to_owned();
        }
        if let Some(usage) = json.get("usage").filter(|u| u.is_object()) {
            let num = |p: &str| usage.pointer(p).and_then(Value::as_u64);
            self.prompt_tokens = num("/prompt_tokens").or(self.prompt_tokens);
            self.completion_tokens = num("/completion_tokens").or(self.completion_tokens);
            self.reasoning_tokens = num("/completion_tokens_details/reasoning_tokens").or(self.reasoning_tokens);
        }
    }

    fn finish(self, started: Instant) -> ChatOutcome {
        ChatOutcome {
            text: self.text.trim().to_owned(),
            model: self.model,
            ttft_ms: self.ttft_ms,
            total_ms: http::ms(started.elapsed()),
            prompt_tokens: self.prompt_tokens,
            completion_tokens: self.completion_tokens,
            reasoning_tokens: self.reasoning_tokens,
        }
    }
}

/// Splits a byte stream into SSE `data:` payloads. Handles events split across chunks and
/// multi-byte characters split across chunks.
#[derive(Default)]
pub struct SseParser {
    buf: Vec<u8>,
    data: Vec<String>,
}

impl SseParser {
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        while let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line);
            self.line(line.trim_end_matches(['\n', '\r']), &mut out);
        }
        out
    }

    pub fn finish(&mut self) -> Vec<String> {
        let mut out = Vec::new();
        if !self.buf.is_empty() {
            let rest = std::mem::take(&mut self.buf);
            self.line(String::from_utf8_lossy(&rest).trim_end_matches('\r'), &mut out);
        }
        self.line("", &mut out);
        out
    }

    fn line(&mut self, line: &str, out: &mut Vec<String>) {
        if line.is_empty() {
            if !self.data.is_empty() {
                out.push(self.data.join("\n"));
                self.data.clear();
            }
        } else if let Some(value) = line.strip_prefix("data:") {
            self.data.push(value.strip_prefix(' ').unwrap_or(value).to_owned());
        }
    }
}

fn send_error(err: &reqwest::Error, ep: &Endpoint, timeout: Duration) -> AppError {
    let label = ep.label();
    let mut e = http::send_error(err, &label, timeout);
    if e.code == ErrorCode::Unreachable {
        e.message = if label == "magpie" {
            "magpie is not running on this Mac (nothing answers at 127.0.0.1:3425)".into()
        } else {
            format!("Can't reach {label}. Check the URL and your connection")
        };
    }
    e
}

/// Maps a non-2xx answer to a precise error. `model` is the one requested, for chat calls.
pub fn map_status(status: StatusCode, body: &str, ep: &Endpoint, model: Option<&str>) -> AppError {
    let label = ep.label();
    let json: Option<Value> = serde_json::from_str(body).ok();
    let upstream_message = json
        .as_ref()
        .and_then(|j| {
            j.pointer("/error/message")
                .or_else(|| j.get("message"))
                .or_else(|| j.get("detail"))
                .or_else(|| j.get("error").filter(|e| e.is_string()))
        })
        .and_then(Value::as_str)
        .unwrap_or_default();
    let upstream_code = json
        .as_ref()
        .and_then(|j| j.pointer("/error/code").or_else(|| j.pointer("/error/type")))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let detail = http::clip_detail(upstream_message, &ep.secrets(), 160);

    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        let message = if ep.api_key.is_some() {
            format!("{label} rejected the API key")
        } else {
            format!("{label} needs an API key. Add one and test again")
        };
        return AppError::new(ErrorCode::InvalidKey, message);
    }
    if let Some(model) = model
        && is_unknown_model(status, upstream_code, upstream_message)
    {
        return AppError::new(ErrorCode::UnknownModel, format!("{label} has no model named \"{model}\""));
    }
    if status == StatusCode::TOO_MANY_REQUESTS {
        return AppError::new(ErrorCode::RateLimited, format!("{label} is rate limiting requests or the quota is used up"));
    }
    if status == StatusCode::NOT_FOUND {
        return AppError::new(
            ErrorCode::Upstream,
            format!("{label} has no such endpoint (HTTP 404). The base URL usually ends in /v1"),
        );
    }
    let suffix = if detail.is_empty() { String::new() } else { format!(": {detail}") };
    AppError::new(ErrorCode::Upstream, format!("{label} returned HTTP {}{suffix}", status.as_u16()))
}

fn is_unknown_model(status: StatusCode, code: &str, message: &str) -> bool {
    if code == "model_not_found" || code == "invalid_model" {
        return true;
    }
    let m = message.to_lowercase();
    let about_model = m.contains("model");
    let missing = ["not found", "does not exist", "unknown", "knows no", "no such", "not supported", "invalid model", "not available"]
        .iter()
        .any(|needle| m.contains(needle));
    matches!(status.as_u16(), 400 | 404 | 422) && about_model && missing
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_partial_json, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn ep(base: &str, key: Option<&str>) -> Endpoint {
        Endpoint { base_url: base.into(), api_key: key.map(str::to_owned) }
    }

    fn req(model: &str, effort: ReasoningEffort) -> ChatRequest {
        ChatRequest { model: model.into(), messages: vec![Message::user("hi")], reasoning_effort: effort, max_tokens: Some(16) }
    }

    #[test]
    fn parses_model_lists() {
        assert_eq!(parse_models(r#"{"data":[{"id":"b"},{"id":"a"},{"id":"a"}]}"#).unwrap(), ["a", "b"]);
        assert_eq!(parse_models(r#"["x", {"id":"y"}]"#).unwrap(), ["x", "y"]);
        assert!(parse_models("<html>").is_none());
    }

    #[test]
    fn reasoning_effort_mapping() {
        assert_eq!(build_body(&req("m", ReasoningEffort::Off))["reasoning_effort"], "none");
        assert_eq!(build_body(&req("m", ReasoningEffort::High))["reasoning_effort"], "high");
        assert!(build_body(&req("m", ReasoningEffort::Default)).get("reasoning_effort").is_none());
    }

    #[test]
    fn sse_parser_handles_split_chunks_and_utf8() {
        let mut p = SseParser::default();
        let full = "data: {\"a\":\"é\"}\n\ndata: [DONE]\n\n".as_bytes();
        // Split inside the two-byte é.
        let cut = full.iter().position(|&b| b == 0xC3).unwrap() + 1;
        let mut out = p.feed(&full[..cut]);
        assert!(out.is_empty());
        out.extend(p.feed(&full[cut..]));
        out.extend(p.finish());
        assert_eq!(out, ["{\"a\":\"é\"}", "[DONE]"]);
    }

    #[test]
    fn error_mapping() {
        let magpie = ep(MAGPIE_BASE_URL, None);
        let keyed = ep("https://api.example.com/v1", Some("sk-secret-123"));
        let e = map_status(StatusCode::UNAUTHORIZED, "{}", &keyed, Some("m"));
        assert_eq!((e.code, e.message.as_str()), (ErrorCode::InvalidKey, "api.example.com rejected the API key"));
        let e = map_status(StatusCode::UNAUTHORIZED, "{}", &magpie, Some("m"));
        assert!(e.message.contains("needs an API key"));

        let e = map_status(StatusCode::NOT_FOUND, r#"{"error":{"code":"model_not_found","message":"x"}}"#, &keyed, Some("gpt-x"));
        assert_eq!((e.code, e.message.as_str()), (ErrorCode::UnknownModel, "api.example.com has no model named \"gpt-x\""));
        let magpie_body = r#"{"error":{"code":null,"message":"magpie knows no model \"nope\" Name a model as provider/model"}}"#;
        assert_eq!(map_status(StatusCode::BAD_REQUEST, magpie_body, &magpie, Some("nope")).code, ErrorCode::UnknownModel);
        // A 404 that is not about the model is a wrong URL.
        let e = map_status(StatusCode::NOT_FOUND, "Not Found", &keyed, Some("m"));
        assert!(e.message.contains("ends in /v1"));
        assert_eq!(map_status(StatusCode::TOO_MANY_REQUESTS, "", &keyed, None).code, ErrorCode::RateLimited);

        // Keys echoed back by a provider never reach the message.
        let e = map_status(StatusCode::INTERNAL_SERVER_ERROR, r#"{"error":{"message":"bad sk-secret-123"}}"#, &keyed, None);
        assert_eq!(e.message, "api.example.com returned HTTP 500: bad [redacted]");
    }

    #[tokio::test]
    async fn lists_models_with_bearer_key() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/models"))
            .and(header("authorization", "Bearer sk-1234"))
            .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"data":[{"id":"deepseek-chat"}]}"#))
            .mount(&server)
            .await;
        let models = list_models(&http::client(), &ep(&format!("{}/v1/", server.uri()), Some("sk-1234")), Duration::from_secs(2))
            .await
            .unwrap();
        assert_eq!(models, ["deepseek-chat"]);
    }

    #[tokio::test]
    async fn streams_and_measures_first_token() {
        let server = MockServer::start().await;
        let sse = concat!(
            "data: {\"model\":\"real-model\",\"choices\":[{\"delta\":{\"reasoning_content\":\"hm\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"Rea\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"dy.\"}}]}\n\n",
            "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":9,\"completion_tokens\":7,\"completion_tokens_details\":{\"reasoning_tokens\":5}}}\n\n",
            "data: [DONE]\n\n",
        );
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .and(body_partial_json(json!({ "model": "alias", "stream": true, "reasoning_effort": "none" })))
            .respond_with(ResponseTemplate::new(200).insert_header("content-type", "text/event-stream").set_body_string(sse))
            .mount(&server)
            .await;
        let out = chat(&http::client(), &ep(&format!("{}/v1", server.uri()), None), &req("alias", ReasoningEffort::Off), Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(out.text, "Ready.");
        assert_eq!(out.model, "real-model");
        assert_eq!((out.prompt_tokens, out.completion_tokens, out.reasoning_tokens), (Some(9), Some(7), Some(5)));
        assert!(out.ttft_ms.unwrap() <= out.total_ms);
    }

    #[tokio::test]
    async fn non_streaming_answer_and_stream_errors() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/plain/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"choices":[{"message":{"content":" ok "}}]}"#))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/broken/chat/completions"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_string("data: {\"error\":{\"message\":\"overloaded\"}}\n\n"),
            )
            .mount(&server)
            .await;
        let client = http::client();
        let t = Duration::from_secs(5);
        let out = chat(&client, &ep(&format!("{}/plain", server.uri()), None), &req("m", ReasoningEffort::Default), t).await.unwrap();
        assert_eq!(out.text, "ok");
        let err = chat(&client, &ep(&format!("{}/broken", server.uri()), None), &req("m", ReasoningEffort::Default), t).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::Upstream);
        assert!(err.message.contains("overloaded"));
    }

    #[tokio::test]
    async fn unreachable_and_timeout() {
        // Nothing listens on port 9 of loopback.
        let err = list_models(&http::client(), &ep("http://127.0.0.1:9/v1", None), Duration::from_secs(2)).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::Unreachable);

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_secs(3)))
            .mount(&server)
            .await;
        let err = list_models(&http::client(), &ep(&server.uri(), None), Duration::from_millis(300)).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::Timeout);
    }
}
