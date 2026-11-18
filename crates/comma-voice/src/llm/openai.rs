//! OpenAI-compatible endpoints (magpie, DeepSeek, any custom base URL): `GET {base}/models` and
//! streamed `POST {base}/chat/completions`. Ported from our prototype's `llm.ts`.

use std::collections::VecDeque;
use std::time::Duration;

use futures_util::Stream;
use reqwest::StatusCode;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::{ChatModel, ChatRequest, Delta, MAGPIE_LABEL, Usage};
use crate::error::{VoiceError, VoiceResult};
use crate::http;

/// magpie, the local gateway Comma looks for first.
pub const MAGPIE_BASE_URL: &str = "http://127.0.0.1:3425/v1";

/// An endpoint and its key. The key only ever goes into the `Authorization` header.
#[derive(Clone)]
pub struct OpenAiCompatible {
    http: reqwest::Client,
    base_url: String,
    api_key: Option<String>,
    models_timeout: Duration,
}

impl std::fmt::Debug for OpenAiCompatible {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OpenAiCompatible").field("base_url", &self.base_url).field("has_key", &self.api_key.is_some()).finish()
    }
}

impl OpenAiCompatible {
    /// `base_url` up to `/v1`, without `/chat/completions`. An empty key is treated as none.
    pub fn new(http: reqwest::Client, base_url: impl Into<String>, api_key: Option<String>) -> Self {
        let base_url = base_url.into().trim().trim_end_matches('/').to_owned();
        // A local gateway answers at once or is not running; the internet gets longer.
        let models_timeout = if http::is_loopback(&base_url) { Duration::from_millis(2500) } else { Duration::from_secs(10) };
        Self { http, base_url, api_key: api_key.filter(|k| !k.is_empty()), models_timeout }
    }

    pub fn magpie(http: reqwest::Client) -> Self {
        Self::new(http, MAGPIE_BASE_URL, None)
    }

    pub fn with_models_timeout(mut self, timeout: Duration) -> Self {
        self.models_timeout = timeout;
        self
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    fn url(&self, path: &str) -> String {
        format!("{}/{path}", self.base_url)
    }

    fn secrets(&self) -> Vec<String> {
        self.api_key.iter().cloned().collect()
    }

    fn authorize(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match &self.api_key {
            Some(key) => req.bearer_auth(key),
            None => req,
        }
    }

    /// The JSON body for a streamed chat request.
    pub fn body(req: &ChatRequest) -> Value {
        let mut body = json!({
            "model": req.model,
            "messages": req.messages,
            "stream": true,
            "stream_options": { "include_usage": true },
        });
        if let Some(effort) = req.reasoning_effort.wire_value() {
            body["reasoning_effort"] = json!(effort);
        }
        if let Some(max) = req.max_tokens {
            body["max_tokens"] = json!(max);
        }
        if let Some(t) = req.temperature {
            body["temperature"] = json!(t);
        }
        body
    }

    /// Maps a non-2xx answer. `model` is the one requested, for chat calls.
    pub fn map_status(&self, status: StatusCode, body: &str, model: Option<&str>, request_id: Option<String>) -> VoiceError {
        let service = self.label();
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
        let secrets = self.secrets();
        let secrets: Vec<&str> = secrets.iter().map(String::as_str).collect();

        if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
            return VoiceError::InvalidKey { service, sent: self.api_key.is_some() };
        }
        if let Some(model) = model
            && is_unknown_model(status, upstream_code, upstream_message)
        {
            return VoiceError::UnknownModel { service, model: model.into() };
        }
        if status == StatusCode::TOO_MANY_REQUESTS || upstream_code == "insufficient_quota" {
            return VoiceError::Quota { service };
        }
        let message = if status == StatusCode::NOT_FOUND && model.is_none_or(|_| upstream_message.is_empty() || !upstream_message.contains("model")) {
            "no such endpoint. The base URL usually ends in /v1".to_owned()
        } else {
            http::clip_detail(upstream_message, &secrets, 160)
        };
        VoiceError::Provider { service, status: status.as_u16(), request_id, message }
    }
}

fn is_unknown_model(status: StatusCode, code: &str, message: &str) -> bool {
    if code == "model_not_found" || code == "invalid_model" {
        return true;
    }
    let m = message.to_lowercase();
    let missing = ["not found", "does not exist", "unknown", "knows no", "no such", "not supported", "invalid model", "not available"]
        .iter()
        .any(|needle| m.contains(needle));
    matches!(status.as_u16(), 400 | 404 | 422) && m.contains("model") && missing
}

fn request_id(res: &reqwest::Response) -> Option<String> {
    ["x-request-id", "request-id"]
        .iter()
        .find_map(|h| res.headers().get(*h))
        .and_then(|v| v.to_str().ok())
        .map(|s| s.chars().take(100).collect())
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

impl ChatModel for OpenAiCompatible {
    fn label(&self) -> String {
        if self.base_url == MAGPIE_BASE_URL { MAGPIE_LABEL.into() } else { http::host_of(&self.base_url).to_owned() }
    }

    async fn list_models(&self) -> VoiceResult<Vec<String>> {
        let timeout = self.models_timeout;
        let service = self.label();
        let res = self
            .authorize(self.http.get(self.url("models")).timeout(timeout))
            .send()
            .await
            .map_err(|e| http::send_error(&e, &service, timeout))?;
        let status = res.status();
        let id = request_id(&res);
        let body = res.text().await.map_err(|e| http::send_error(&e, &service, timeout))?;
        if !status.is_success() {
            return Err(self.map_status(status, &body, None, id));
        }
        parse_models(&body).ok_or_else(|| VoiceError::InvalidResponse { service, detail: "Check that the URL ends in /v1".into() })
    }

    async fn stream(
        &self,
        req: ChatRequest,
        cancel: CancellationToken,
    ) -> VoiceResult<impl Stream<Item = VoiceResult<Delta>> + Send + 'static> {
        let service = self.label();
        let timeout = req.timeout;
        let send = self
            .authorize(self.http.post(self.url("chat/completions")).timeout(timeout))
            .header("accept", "text/event-stream")
            .json(&Self::body(&req))
            .send();
        let res = http::cancellable(Some(&cancel), send).await?.map_err(|e| http::send_error(&e, &service, timeout))?;
        let status = res.status();
        if !status.is_success() {
            let id = request_id(&res);
            let body = http::cancellable(Some(&cancel), res.text()).await?.unwrap_or_default();
            return Err(self.map_status(status, &body, Some(&req.model), id));
        }
        let state = StreamState {
            res,
            cancel,
            service,
            secrets: self.secrets(),
            timeout,
            parser: SseParser::default(),
            whole: None,
            decided: false,
            pending: VecDeque::new(),
            done: false,
        };
        Ok(futures_util::stream::unfold(state, StreamState::next))
    }
}

struct StreamState {
    res: reqwest::Response,
    cancel: CancellationToken,
    service: String,
    secrets: Vec<String>,
    timeout: Duration,
    parser: SseParser,
    /// Set when the body turned out to be one JSON document instead of an event stream.
    whole: Option<Vec<u8>>,
    decided: bool,
    pending: VecDeque<VoiceResult<Delta>>,
    done: bool,
}

impl StreamState {
    async fn next(mut self) -> Option<(VoiceResult<Delta>, Self)> {
        loop {
            if let Some(item) = self.pending.pop_front() {
                if item.is_err() {
                    // An error ends the stream.
                    self.pending.clear();
                    self.done = true;
                }
                return Some((item, self));
            }
            if self.done {
                return None;
            }
            let chunk = tokio::select! {
                biased;
                () = self.cancel.cancelled() => Err(VoiceError::Cancelled),
                chunk = self.res.chunk() => chunk.map_err(|e| http::send_error(&e, &self.service, self.timeout)),
            };
            match chunk {
                Err(err) => {
                    self.done = true;
                    return Some((Err(err), self));
                }
                Ok(Some(bytes)) => self.feed(&bytes),
                Ok(None) => {
                    self.finish();
                    self.done = true;
                }
            }
        }
    }

    // Some endpoints ignore `stream: true` and answer with one JSON body, sometimes still labelled
    // as an event stream, so the first byte decides: `{` is JSON, anything else is SSE.
    fn feed(&mut self, bytes: &[u8]) {
        if !self.decided
            && let Some(first) = bytes.iter().find(|b| !b.is_ascii_whitespace())
        {
            self.decided = true;
            if *first == b'{' {
                self.whole = Some(Vec::new());
            }
        }
        if let Some(buf) = self.whole.as_mut() {
            buf.extend_from_slice(bytes);
            return;
        }
        for data in self.parser.feed(bytes) {
            self.event(&data);
        }
    }

    fn finish(&mut self) {
        if let Some(body) = self.whole.take() {
            match serde_json::from_slice::<Value>(&body) {
                Ok(json) => self.deltas(&json, "/choices/0/message"),
                Err(_) => self.pending.push_back(Err(VoiceError::InvalidResponse { service: self.service.clone(), detail: String::new() })),
            }
            return;
        }
        for data in self.parser.finish() {
            self.event(&data);
        }
    }

    fn event(&mut self, data: &str) {
        let data = data.trim();
        if data.is_empty() || data == "[DONE]" {
            return;
        }
        // Comment lines and keep-alives that are not JSON are skipped.
        let Ok(json) = serde_json::from_str::<Value>(data) else { return };
        if let Some(err) = json.get("error") {
            let message = err.get("message").and_then(Value::as_str).unwrap_or("unknown error");
            let secrets: Vec<&str> = self.secrets.iter().map(String::as_str).collect();
            self.pending.push_back(Err(VoiceError::Stream { service: self.service.clone(), message: http::clip_detail(message, &secrets, 200) }));
            return;
        }
        self.deltas(&json, "/choices/0/delta");
    }

    fn deltas(&mut self, json: &Value, choice: &str) {
        if let Some(model) = json.get("model").and_then(Value::as_str).filter(|m| !m.is_empty()) {
            self.pending.push_back(Ok(Delta::Model(model.to_owned())));
        }
        let field = |name: &str| json.pointer(&format!("{choice}/{name}")).and_then(Value::as_str).filter(|s| !s.is_empty());
        if let Some(thinking) = field("reasoning_content") {
            self.pending.push_back(Ok(Delta::Reasoning(thinking.to_owned())));
        }
        if let Some(text) = field("content") {
            self.pending.push_back(Ok(Delta::Text(text.to_owned())));
        }
        if let Some(usage) = json.get("usage").filter(|u| u.is_object()) {
            let num = |p: &str| usage.pointer(p).and_then(Value::as_u64);
            self.pending.push_back(Ok(Delta::Usage(Usage {
                prompt_tokens: num("/prompt_tokens"),
                completion_tokens: num("/completion_tokens"),
                reasoning_tokens: num("/completion_tokens_details/reasoning_tokens"),
            })));
        }
    }
}

/// Splits a byte stream into SSE `data:` payloads. Handles events and multi-byte characters split
/// across chunks.
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::{Message, ReasoningEffort, complete};
    use futures_util::StreamExt;
    use wiremock::matchers::{body_partial_json, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn ep(base: &str, key: Option<&str>) -> OpenAiCompatible {
        OpenAiCompatible::new(http::client(), base, key.map(str::to_owned))
    }

    fn req(model: &str, effort: ReasoningEffort) -> ChatRequest {
        let mut r = ChatRequest::new(model, vec![Message::user("hi")]);
        r.reasoning_effort = effort;
        r.max_tokens = Some(16);
        r.timeout = Duration::from_secs(5);
        r
    }

    fn sse(body: &str) -> ResponseTemplate {
        ResponseTemplate::new(200).set_body_raw(body.as_bytes().to_vec(), "text/event-stream")
    }

    #[test]
    fn parses_model_lists() {
        assert_eq!(parse_models(r#"{"data":[{"id":"b"},{"id":"a"},{"id":"a"}]}"#).unwrap(), ["a", "b"]);
        assert_eq!(parse_models(r#"["x", {"id":"y"}]"#).unwrap(), ["x", "y"]);
        assert!(parse_models("<html>").is_none());
    }

    #[test]
    fn request_shape_and_reasoning_effort() {
        let body = OpenAiCompatible::body(&req("m", ReasoningEffort::Off));
        assert_eq!(body["reasoning_effort"], "none");
        assert_eq!(body["stream"], true);
        assert_eq!(body["stream_options"]["include_usage"], true);
        assert_eq!(body["messages"][0], json!({ "role": "user", "content": "hi" }));
        assert_eq!(OpenAiCompatible::body(&req("m", ReasoningEffort::High))["reasoning_effort"], "high");
        assert!(OpenAiCompatible::body(&req("m", ReasoningEffort::Default)).get("reasoning_effort").is_none());
    }

    #[test]
    fn labels_and_debug_hide_the_key() {
        assert_eq!(ep(MAGPIE_BASE_URL, None).label(), "magpie");
        assert_eq!(ep("https://api.deepseek.com/v1/", None).label(), "api.deepseek.com");
        assert!(!format!("{:?}", ep("https://x.io/v1", Some("sk-123456"))).contains("sk-123456"));
    }

    #[test]
    fn sse_parser_handles_split_chunks_and_utf8() {
        let mut p = SseParser::default();
        let full = "data: {\"a\":\"é\"}\n\n: keep-alive\n\ndata: [DONE]\n\n".as_bytes();
        // Split inside the two-byte é.
        let cut = full.iter().position(|&b| b == 0xC3).unwrap() + 1;
        let mut out = p.feed(&full[..cut]);
        assert!(out.is_empty());
        out.extend(p.feed(&full[cut..]));
        out.extend(p.finish());
        assert_eq!(out, ["{\"a\":\"é\"}", "[DONE]"]);
        // An event without the trailing blank line is flushed by finish().
        let mut p = SseParser::default();
        assert!(p.feed(b"data: x").is_empty());
        assert_eq!(p.finish(), ["x"]);
    }

    #[test]
    fn error_mapping() {
        let magpie = ep(MAGPIE_BASE_URL, None);
        let keyed = ep("https://api.example.com/v1", Some("sk-secret-123"));
        assert_eq!(keyed.map_status(StatusCode::UNAUTHORIZED, "{}", Some("m"), None), VoiceError::InvalidKey { service: "api.example.com".into(), sent: true });
        assert_eq!(magpie.map_status(StatusCode::UNAUTHORIZED, "{}", Some("m"), None), VoiceError::InvalidKey { service: "magpie".into(), sent: false });

        let e = keyed.map_status(StatusCode::NOT_FOUND, r#"{"error":{"code":"model_not_found","message":"x"}}"#, Some("gpt-x"), None);
        assert_eq!(e.to_string(), "api.example.com has no model named \"gpt-x\"");
        let magpie_body = r#"{"error":{"code":null,"message":"magpie knows no model \"nope\" Name a model as provider/model"}}"#;
        assert!(matches!(magpie.map_status(StatusCode::BAD_REQUEST, magpie_body, Some("nope"), None), VoiceError::UnknownModel { .. }));
        // A 404 that is not about the model is a wrong URL.
        assert!(keyed.map_status(StatusCode::NOT_FOUND, "Not Found", Some("m"), None).to_string().contains("ends in /v1"));
        assert_eq!(keyed.map_status(StatusCode::TOO_MANY_REQUESTS, "", None, None), VoiceError::Quota { service: "api.example.com".into() });

        // Keys echoed back by a provider never reach the message; the request id is kept.
        let e = keyed.map_status(StatusCode::INTERNAL_SERVER_ERROR, r#"{"error":{"message":"bad sk-secret-123"}}"#, None, Some("req_1".into()));
        assert_eq!(e.to_string(), "api.example.com returned HTTP 500: bad [redacted]");
        assert!(matches!(e, VoiceError::Provider { request_id: Some(ref id), .. } if id == "req_1"));
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
        let models = ep(&format!("{}/v1/", server.uri()), Some("sk-1234")).list_models().await.unwrap();
        assert_eq!(models, ["deepseek-chat"]);
    }

    #[tokio::test]
    async fn streams_and_measures_first_token() {
        let server = MockServer::start().await;
        let body = concat!(
            "data: {\"model\":\"real-model\",\"choices\":[{\"delta\":{\"reasoning_content\":\"hm\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"Rea\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"dy.\"}}]}\n\n",
            "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":9,\"completion_tokens\":7,\"completion_tokens_details\":{\"reasoning_tokens\":5}}}\n\n",
            "data: [DONE]\n\n",
        );
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .and(body_partial_json(json!({ "model": "alias", "stream": true, "reasoning_effort": "none" })))
            .respond_with(sse(body))
            .mount(&server)
            .await;
        let model = ep(&format!("{}/v1", server.uri()), None);
        let mut seen = String::new();
        let out = complete(&model, req("alias", ReasoningEffort::Off), CancellationToken::new(), |t| seen.push_str(t)).await.unwrap();
        assert_eq!((out.text.as_str(), seen.as_str(), out.model.as_str()), ("Ready.", "Ready.", "real-model"));
        assert_eq!(out.usage, Usage { prompt_tokens: Some(9), completion_tokens: Some(7), reasoning_tokens: Some(5) });
        assert!(out.ttft.unwrap() <= out.total);

        // The raw stream keeps reasoning apart from the answer.
        let deltas: Vec<Delta> = model
            .stream(req("alias", ReasoningEffort::Off), CancellationToken::new())
            .await
            .unwrap()
            .map(Result::unwrap)
            .collect()
            .await;
        assert_eq!(deltas[1], Delta::Reasoning("hm".into()));
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
            .respond_with(sse("data: {\"choices\":[{\"delta\":{\"content\":\"par\"}}]}\n\ndata: {\"error\":{\"message\":\"overloaded\"}}\n\n"))
            .mount(&server)
            .await;
        let c = CancellationToken::new;
        let out = complete(&ep(&format!("{}/plain", server.uri()), None), req("m", ReasoningEffort::Default), c(), |_| {}).await.unwrap();
        assert_eq!(out.text, "ok");
        let err = complete(&ep(&format!("{}/broken", server.uri()), None), req("m", ReasoningEffort::Default), c(), |_| {}).await.unwrap_err();
        assert_eq!(err.to_string(), format!("{} stopped with an error: overloaded", http::host_of(&server.uri())));
    }

    #[tokio::test]
    async fn unreachable_timeout_and_cancel() {
        // Nothing listens on port 9 of loopback.
        let err = ep("http://127.0.0.1:9/v1", None).list_models().await.unwrap_err();
        assert_eq!(err, VoiceError::Unreachable { service: "127.0.0.1:9".into() });

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_secs(3)))
            .mount(&server)
            .await;
        let slow = ep(&server.uri(), None).with_models_timeout(Duration::from_millis(300));
        assert!(matches!(slow.list_models().await.unwrap_err(), VoiceError::Timeout { .. }));

        Mock::given(method("POST"))
            .respond_with(sse("data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}]}\n\n").set_delay(Duration::from_secs(3)))
            .mount(&server)
            .await;
        let token = CancellationToken::new();
        let cancel = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            cancel.cancel();
        });
        let started = std::time::Instant::now();
        let err = complete(&ep(&server.uri(), None), req("m", ReasoningEffort::Default), token, |_| {}).await.unwrap_err();
        assert_eq!(err, VoiceError::Cancelled);
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}
