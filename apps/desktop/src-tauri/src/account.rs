//! Comma server client for the account path of onboarding (spec 5.2, auth module). Request and
//! response shapes follow `packages/shared/src/api/auth.ts`. Tokens never leave Rust: the caller
//! stores them in the Keychain.

use std::time::Duration;

use reqwest::StatusCode;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use comma_voice::http;

use crate::error::{AppError, AppResult, ErrorCode};

const SERVICE: &str = "the Comma server";
const TIMEOUT: Duration = Duration::from_secs(10);
/// Speech to text plus the rewrite on the server, for up to 10 minutes of audio.
const VOICE_TIMEOUT: Duration = Duration::from_secs(180);

/// `POST /v1/voice/runs` -> 200 (`VoiceRunResponse` in `packages/shared/src/api/voice.ts`).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct VoiceRun {
    pub id: String,
    pub raw_text: String,
    pub refined_text: String,
    pub detected_language: String,
    pub delivery: String,
    pub timings: VoiceTimings,
    pub usage: VoiceUsage,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct VoiceTimings {
    pub stt_ms: f64,
    pub llm_ttft_ms: f64,
    pub llm_total_ms: f64,
    pub total_ms: f64,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct VoiceUsage {
    pub audio_seconds: f64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub stt_cost_usd: f64,
}

/// `GET /v1/me/credits`.
#[derive(Debug, Clone, PartialEq, Deserialize, serde::Serialize)]
pub struct Credits {
    pub plan: String,
    pub period_end: String,
    pub used_seconds: f64,
    pub limit_seconds: f64,
}

/// A server dictionary term (`DictionaryTerm`).
#[derive(Debug, Clone, PartialEq, Deserialize, serde::Serialize)]
pub struct ServerTerm {
    pub id: String,
    pub term: String,
    pub created_at: String,
}

#[derive(Deserialize)]
struct TermsEnvelope {
    terms: Vec<ServerTerm>,
}

#[derive(Deserialize)]
struct TermEnvelope {
    term: ServerTerm,
}

#[derive(Debug, Deserialize)]
pub struct ImportResponse {
    pub added: usize,
    pub skipped: usize,
}

/// Whether an error means the access token was refused, so a refresh and one retry may help.
pub fn is_unauthorized(err: &AppError) -> bool {
    err.code == ErrorCode::Server && matches!(err.reason.as_deref(), Some("unauthorized" | "invalid_token" | "http_401"))
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct User {
    pub email: String,
    pub name: String,
}

#[derive(Deserialize)]
pub struct Tokens {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_in: u64,
    pub user: User,
}

impl std::fmt::Debug for Tokens {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Tokens").field("expires_in", &self.expires_in).field("user", &self.user).finish_non_exhaustive()
    }
}

#[derive(Deserialize)]
struct UserEnvelope {
    user: User,
}

pub struct Server<'a> {
    pub http: &'a reqwest::Client,
    pub base_url: &'a str,
}

impl Server<'_> {
    fn url(&self, path: &str) -> String {
        format!("{}/v1/{path}", self.base_url.trim_end_matches('/'))
    }

    /// `GET /v1/health`. A 503 means the server runs but a dependency (Postgres) is down.
    pub async fn health(&self) -> AppResult<()> {
        let timeout = Duration::from_secs(3);
        let res = self
            .http
            .get(self.url("health"))
            .timeout(timeout)
            .send()
            .await
            .map_err(|e| unreachable(&e, self.base_url, timeout))?;
        match res.status() {
            s if s.is_success() => Ok(()),
            StatusCode::SERVICE_UNAVAILABLE => Err(AppError::new(ErrorCode::Server, "The Comma server is up but not ready yet")
                .with_reason("service_unavailable")),
            s => Err(AppError::new(
                ErrorCode::Server,
                format!("{} does not look like a Comma server (HTTP {})", http::host_of(self.base_url), s.as_u16()),
            )),
        }
    }

    pub async fn register(&self, email: &str, password: &str, name: &str) -> AppResult<User> {
        let body = json!({ "email": email, "password": password, "name": name });
        Ok(self.post::<UserEnvelope>("auth/register", &body, &[password]).await?.user)
    }

    pub async fn verify_email(&self, email: &str, code: &str) -> AppResult<()> {
        self.post::<Value>("auth/verify-email", &json!({ "email": email, "code": code }), &[code]).await.map(drop)
    }

    pub async fn resend_code(&self, email: &str) -> AppResult<()> {
        self.post::<Value>("auth/verify-email/resend", &json!({ "email": email }), &[]).await.map(drop)
    }

    pub async fn login(&self, email: &str, password: &str, device_name: &str) -> AppResult<Tokens> {
        let body = json!({ "email": email, "password": password, "device_name": device_name, "platform": "macos" });
        self.post("auth/login", &body, &[password]).await
    }

    pub async fn refresh(&self, refresh_token: &str) -> AppResult<Tokens> {
        self.post("auth/refresh", &json!({ "refresh_token": refresh_token }), &[refresh_token]).await
    }

    pub async fn logout(&self, refresh_token: &str) -> AppResult<()> {
        self.post::<Value>("auth/logout", &json!({ "refresh_token": refresh_token }), &[refresh_token]).await.map(drop)
    }

    /// `POST /v1/voice/runs`: multipart `audio` (WAV) and `meta` (JSON).
    #[cfg(test)]
    pub async fn voice_run(&self, access: &str, wav: Vec<u8>, meta: &Value) -> AppResult<VoiceRun> {
        self.voice_run_with(access, wav, "audio/wav", "wav", meta, VOICE_TIMEOUT).await
    }

    /// `POST /v1/voice/runs` with WAV or Ogg/Opus audio; `timeout` grows with the clip.
    pub async fn voice_run_with(&self, access: &str, audio: Vec<u8>, mime: &str, ext: &str, meta: &Value, timeout: Duration) -> AppResult<VoiceRun> {
        let audio = reqwest::multipart::Part::bytes(audio)
            .file_name(format!("run.{ext}"))
            .mime_str(mime)
            .map_err(|e| AppError::internal(e.to_string()))?;
        let form = reqwest::multipart::Form::new().part("audio", audio).text("meta", meta.to_string());
        let req = self.http.post(self.url("voice/runs")).bearer_auth(access).multipart(form);
        self.send(req, timeout.min(VOICE_TIMEOUT), &[access]).await
    }

    pub async fn credits(&self, access: &str) -> AppResult<Credits> {
        self.send(self.http.get(self.url("me/credits")).bearer_auth(access), TIMEOUT, &[access]).await
    }

    pub async fn dictionary(&self, access: &str) -> AppResult<Vec<ServerTerm>> {
        let req = self.http.get(self.url("dictionary")).bearer_auth(access);
        Ok(self.send::<TermsEnvelope>(req, TIMEOUT, &[access]).await?.terms)
    }

    pub async fn dictionary_add(&self, access: &str, term: &str) -> AppResult<ServerTerm> {
        let req = self.http.post(self.url("dictionary")).bearer_auth(access).json(&json!({ "term": term }));
        Ok(self.send::<TermEnvelope>(req, TIMEOUT, &[access]).await?.term)
    }

    pub async fn dictionary_update(&self, access: &str, id: &str, term: &str) -> AppResult<ServerTerm> {
        let req = self.http.patch(self.url(&format!("dictionary/{}", path_segment(id)?))).bearer_auth(access).json(&json!({ "term": term }));
        Ok(self.send::<TermEnvelope>(req, TIMEOUT, &[access]).await?.term)
    }

    pub async fn dictionary_delete(&self, access: &str, id: &str) -> AppResult<()> {
        let req = self.http.delete(self.url(&format!("dictionary/{}", path_segment(id)?))).bearer_auth(access);
        self.send_empty(req, &[access]).await
    }

    pub async fn dictionary_import(&self, access: &str, csv: &str) -> AppResult<ImportResponse> {
        let req = self.http.post(self.url("dictionary/import")).bearer_auth(access).json(&json!({ "csv": csv }));
        self.send(req, TIMEOUT, &[access]).await
    }

    async fn send<T: DeserializeOwned>(&self, req: reqwest::RequestBuilder, timeout: Duration, secrets: &[&str]) -> AppResult<T> {
        let res = req.timeout(timeout).send().await.map_err(|e| unreachable(&e, self.base_url, timeout))?;
        let status = res.status();
        let text = res.text().await.map_err(|e| unreachable(&e, self.base_url, timeout))?;
        if !status.is_success() {
            return Err(map_api_error(status, &text, secrets));
        }
        serde_json::from_str(&text).map_err(|_| AppError::new(ErrorCode::Server, "The Comma server sent an answer Comma can't read"))
    }

    async fn send_empty(&self, req: reqwest::RequestBuilder, secrets: &[&str]) -> AppResult<()> {
        let res = req.timeout(TIMEOUT).send().await.map_err(|e| unreachable(&e, self.base_url, TIMEOUT))?;
        let status = res.status();
        if status.is_success() {
            return Ok(());
        }
        let text = res.text().await.unwrap_or_default();
        Err(map_api_error(status, &text, secrets))
    }

    /// `secrets` are the request's sensitive values, scrubbed from anything echoed back.
    async fn post<T: DeserializeOwned>(&self, path: &str, body: &Value, secrets: &[&str]) -> AppResult<T> {
        let res = self
            .http
            .post(self.url(path))
            .json(body)
            .timeout(TIMEOUT)
            .send()
            .await
            .map_err(|e| unreachable(&e, self.base_url, TIMEOUT))?;
        let status = res.status();
        let text = res.text().await.map_err(|e| unreachable(&e, self.base_url, TIMEOUT))?;
        if !status.is_success() {
            return Err(map_api_error(status, &text, secrets));
        }
        serde_json::from_str(&text).map_err(|_| AppError::new(ErrorCode::Server, "The Comma server sent an answer Comma can't read"))
    }
}

/// Ids go into the URL path; the server's are UUIDs.
fn path_segment(id: &str) -> AppResult<&str> {
    if !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        Ok(id)
    } else {
        Err(AppError::invalid("That term id is not valid"))
    }
}

fn unreachable(err: &reqwest::Error, base_url: &str, timeout: Duration) -> AppError {
    let mut e = AppError::from(http::send_error(err, SERVICE, timeout));
    if e.code == ErrorCode::Unreachable {
        e.message = format!("Can't reach the Comma server at {}", http::host_of(base_url));
    }
    e
}

/// `{ code, message }` from the server, with our own wording for the codes a person can act on.
pub fn map_api_error(status: StatusCode, body: &str, secrets: &[&str]) -> AppError {
    let json: Option<Value> = serde_json::from_str(body).ok();
    let code = json.as_ref().and_then(|j| j.get("code")).and_then(Value::as_str).unwrap_or_default().to_owned();
    let server_message = json.as_ref().and_then(|j| j.get("message")).and_then(Value::as_str).unwrap_or_default();
    let message = match code.as_str() {
        "invalid_credentials" => "Wrong email or password".to_owned(),
        "email_not_verified" => "Confirm your email first. Enter the code we sent you".to_owned(),
        "email_taken" => "There is already an account with this email. Sign in instead".to_owned(),
        "invalid_code" => "That code is not right. Check the latest email".to_owned(),
        "code_expired" => "That code has expired. Send a new one".to_owned(),
        "too_many_attempts" => "Too many tries. Send a new code".to_owned(),
        "resend_cooldown" => "A code was just sent. Wait a minute before asking for another".to_owned(),
        "rate_limited" => "Too many requests. Try again in a minute".to_owned(),
        "invalid_refresh_token" | "refresh_token_reused" | "invalid_token" => "Your session ended. Sign in again".to_owned(),
        "quota_exceeded" => {
            let resets = json.as_ref().and_then(|j| j.get("resets_at")).and_then(Value::as_str).and_then(|t| t.get(..10));
            match resets {
                Some(day) => format!("You've used this week's Comma minutes. They renew on {day}"),
                None => "You've used this week's Comma minutes".to_owned(),
            }
        }
        "no_speech" => "Didn't catch that".to_owned(),
        "run_in_progress" => "Another run is still going. Try again in a moment".to_owned(),
        "audio_too_long" => "That recording is longer than 10 minutes".to_owned(),
        "audio_too_large" => "That recording is too large to send".to_owned(),
        "provider_unavailable" => "The speech service is busy. Try again in a moment".to_owned(),
        "provider_not_configured" => "This Comma server has no speech provider set up yet".to_owned(),
        "term_exists" => "That term is already in the dictionary".to_owned(),
        "dictionary_full" => "The dictionary is full (1000 terms)".to_owned(),
        _ if !server_message.is_empty() => http::clip_detail(server_message, secrets, 160),
        _ => format!("The Comma server returned HTTP {}", status.as_u16()),
    };
    let reason = if code.is_empty() { format!("http_{}", status.as_u16()) } else { code };
    AppError::new(ErrorCode::Server, message).with_reason(reason)
}

/// The Mac's name as shown in Sharing settings, for the server's device list.
pub fn device_name() -> String {
    std::process::Command::new("/usr/sbin/scutil")
        .args(["--get", "ComputerName"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().chars().take(100).collect::<String>())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "Mac".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_partial_json, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const USER: &str = r#"{"id":"8f1c2f5e-2d0c-4f5e-9b8a-3e1f7a6b9c01","email":"ada@example.com","name":"Ada","email_verified":true,"plan":"free","settings":{"languages":[],"translate_targets":[],"context_level":"app"},"created_at":"2026-11-18T10:00:00.000Z"}"#;

    #[test]
    fn maps_server_errors() {
        let e = map_api_error(StatusCode::UNAUTHORIZED, r#"{"code":"invalid_credentials","message":"x"}"#, &[]);
        assert_eq!((e.code, e.message.as_str(), e.reason.as_deref()), (ErrorCode::Server, "Wrong email or password", Some("invalid_credentials")));
        let e = map_api_error(StatusCode::BAD_REQUEST, r#"{"code":"validation_failed","message":"password: too short hunter2"}"#, &["hunter2"]);
        assert_eq!(e.message, "password: too short [redacted]");
        let e = map_api_error(StatusCode::BAD_GATEWAY, "<html>", &[]);
        assert_eq!((e.message.as_str(), e.reason.as_deref()), ("The Comma server returned HTTP 502", Some("http_502")));
    }

    #[tokio::test]
    async fn login_flow_against_a_mocked_server() {
        let mock = MockServer::start().await;
        Mock::given(method("GET")).and(path("/v1/health")).respond_with(ResponseTemplate::new(200).set_body_string(r#"{"status":"ok","details":{}}"#)).mount(&mock).await;
        Mock::given(method("POST"))
            .and(path("/v1/auth/login"))
            .and(body_partial_json(json!({ "email": "ada@example.com", "platform": "macos" })))
            .respond_with(ResponseTemplate::new(200).set_body_string(format!(
                r#"{{"access_token":"at","refresh_token":"rt","expires_in":900,"user":{USER}}}"#
            )))
            .mount(&mock)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/auth/register"))
            .respond_with(ResponseTemplate::new(409).set_body_string(r#"{"code":"email_taken","message":"taken"}"#))
            .mount(&mock)
            .await;
        let client = http::client();
        let base = mock.uri();
        let server = Server { http: &client, base_url: &base };
        server.health().await.unwrap();
        let tokens = server.login("ada@example.com", "pw", "Ada's Mac").await.unwrap();
        assert_eq!((tokens.access_token.as_str(), tokens.expires_in, tokens.user.name.as_str()), ("at", 900, "Ada"));
        assert!(!format!("{tokens:?}").contains("rt\""));
        let err = server.register("ada@example.com", "password1", "Ada").await.unwrap_err();
        assert_eq!(err.reason.as_deref(), Some("email_taken"));
    }

    #[test]
    fn maps_voice_errors() {
        let e = map_api_error(StatusCode::PAYMENT_REQUIRED, r#"{"code":"quota_exceeded","message":"x","resets_at":"2026-11-23T00:00:00.000Z"}"#, &[]);
        assert_eq!((e.message.as_str(), e.reason.as_deref()), ("You've used this week's Comma minutes. They renew on 2026-11-23", Some("quota_exceeded")));
        let e = map_api_error(StatusCode::UNAUTHORIZED, r#"{"code":"unauthorized","message":"no"}"#, &[]);
        assert!(is_unauthorized(&e));
        assert!(is_unauthorized(&map_api_error(StatusCode::UNAUTHORIZED, "", &[])));
        assert!(!is_unauthorized(&map_api_error(StatusCode::UNPROCESSABLE_ENTITY, r#"{"code":"no_speech","message":"n"}"#, &[])));
        assert_eq!(path_segment("../me").unwrap_err().code, ErrorCode::InvalidInput);
    }

    #[tokio::test]
    async fn voice_run_and_dictionary_against_a_mocked_server() {
        use wiremock::matchers::{header, header_regex};
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/voice/runs"))
            .and(header("authorization", "Bearer at"))
            .and(header_regex("content-type", "^multipart/form-data"))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                r#"{"id":"0b0c2f5e-2d0c-4f5e-9b8a-3e1f7a6b9c01","raw_text":"um hi","refined_text":"Hi.","detected_language":"en","delivery":"insert","timings":{"stt_ms":300,"llm_ttft_ms":120,"llm_total_ms":200,"total_ms":520},"usage":{"audio_seconds":1.5,"prompt_tokens":80,"completion_tokens":3,"stt_cost_usd":0.0001}}"#,
            ))
            .mount(&mock)
            .await;
        Mock::given(method("GET"))
            .and(path("/v1/dictionary"))
            .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"terms":[{"id":"t1","term":"Comma","created_at":"2026-11-18T10:00:00.000Z"}]}"#))
            .mount(&mock)
            .await;
        Mock::given(method("DELETE")).and(path("/v1/dictionary/t1")).respond_with(ResponseTemplate::new(204)).mount(&mock).await;
        let client = http::client();
        let base = mock.uri();
        let server = Server { http: &client, base_url: &base };
        let run = server.voice_run("at", wav_bytes(), &json!({ "mode": "dictate" })).await.unwrap();
        assert_eq!((run.refined_text.as_str(), run.delivery.as_str(), run.timings.stt_ms), ("Hi.", "insert", 300.0));
        let body = String::from_utf8_lossy(&mock.received_requests().await.unwrap()[0].body).into_owned();
        assert!(body.contains(r#"name="meta""#) && body.contains(r#"{"mode":"dictate"}"#) && body.contains(r#"name="audio""#));
        assert_eq!(server.dictionary("at").await.unwrap()[0].term, "Comma");
        server.dictionary_delete("at", "t1").await.unwrap();
        let err = server.credits("at").await.unwrap_err();
        assert_eq!(err.reason.as_deref(), Some("http_404"));
    }

    fn wav_bytes() -> Vec<u8> {
        comma_voice::wav::test_clip()
    }

    #[tokio::test]
    async fn unreachable_server() {
        let client = http::client();
        let server = Server { http: &client, base_url: "http://127.0.0.1:9" };
        let err = server.health().await.unwrap_err();
        assert_eq!((err.code, err.message.as_str()), (ErrorCode::Unreachable, "Can't reach the Comma server at 127.0.0.1:9"));
    }
}
