//! Tauri commands (spec 3.3). Contract: `packages/shared/src/ipc/commands.ts`.
//!
//! Commands with multi-word arguments use `rename_all = "snake_case"`, so the frontend passes the
//! same keys the contract lists (`base_url`, not `baseUrl`).

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, State};

use crate::account::{self, Server};
use crate::audio;
use crate::error::{AppError, AppResult, ErrorCode};
use crate::http;
use crate::llm::{self, ChatRequest, Endpoint, Message};
use crate::permissions::{self, PermissionsStatus, SettingsPaneKind};
use crate::prompts::{self, Delivery, Mode, PromptInput};
use crate::secrets::{self, ACCOUNT_ACCESS, ACCOUNT_REFRESH, SecretName, SecretStatus, SecretStore};
use crate::settings::{self, AppMode, MAGPIE_BASE_URL, ReasoningEffort, Settings};
use crate::stt;
use crate::windows::{self, WindowLabel};

/// ElevenLabs accepts up to 3 GB, but a dictation clip over 25 MB (13 min of 16 kHz PCM) is a bug.
const MAX_WAV_BYTES: usize = 25 * 1024 * 1024;
const REFINE_TIMEOUT: Duration = Duration::from_secs(60);
const LLM_TEST_TIMEOUT: Duration = Duration::from_secs(30);

pub struct AppState {
    pub settings: Mutex<Settings>,
    pub settings_path: PathBuf,
    pub secrets: Box<dyn SecretStore>,
    pub http: reqwest::Client,
    /// `stt::ELEVENLABS_BASE_URL`, replaced by a mock server in tests.
    pub elevenlabs_base_url: String,
}

impl AppState {
    pub fn new(settings: Settings, settings_path: PathBuf, secrets: Box<dyn SecretStore>) -> Self {
        Self {
            settings: Mutex::new(settings),
            settings_path,
            secrets,
            http: http::client(),
            elevenlabs_base_url: stt::ELEVENLABS_BASE_URL.into(),
        }
    }

    fn settings(&self) -> AppResult<std::sync::MutexGuard<'_, Settings>> {
        self.settings.lock().map_err(|_| AppError::internal("settings lock poisoned"))
    }

    fn snapshot(&self) -> AppResult<Settings> {
        Ok(self.settings()?.clone())
    }

    pub fn update_settings(&self, patch: &Value) -> AppResult<Settings> {
        let mut current = self.settings()?;
        let next = current.apply_patch(patch)?;
        settings::save(&self.settings_path, &next)?;
        *current = next.clone();
        Ok(next)
    }

    /// The LLM endpoint for `base_url`, or the saved one. magpie needs no key, so the stored key
    /// (which belongs to the custom endpoint) is only sent elsewhere.
    fn llm_endpoint(&self, base_url: Option<String>) -> AppResult<Endpoint> {
        let base_url = match base_url.map(|u| u.trim().to_owned()).filter(|u| !u.is_empty()) {
            Some(url) => url,
            None => self.settings()?.llm.base_url.clone(),
        };
        settings::validate_url(&base_url, "The base URL")?;
        let api_key = if base_url.trim_end_matches('/') == MAGPIE_BASE_URL {
            None
        } else {
            secrets::get_key(self.secrets.as_ref(), SecretName::Llm)?
        };
        Ok(Endpoint { base_url, api_key })
    }

    fn elevenlabs_key(&self) -> AppResult<String> {
        secrets::get_key(self.secrets.as_ref(), SecretName::Elevenlabs)?
            .ok_or_else(|| AppError::new(ErrorCode::NotConfigured, "Add your ElevenLabs API key first"))
    }

    fn server_url(&self) -> AppResult<String> {
        Ok(self.settings()?.account.server_url.clone())
    }
}

#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> AppResult<Settings> {
    state.snapshot()
}

#[tauri::command]
pub fn settings_set(state: State<'_, AppState>, patch: Value) -> AppResult<Settings> {
    state.update_settings(&patch)
}

// Keychain calls can block on a system prompt, so they run off the main thread.
#[tauri::command]
pub async fn secret_set(state: State<'_, AppState>, name: SecretName, value: String) -> AppResult<()> {
    secrets::set_secret(state.secrets.as_ref(), name, &value)
}

#[tauri::command]
pub async fn secret_status(state: State<'_, AppState>) -> AppResult<SecretStatus> {
    secrets::status(state.secrets.as_ref())
}

#[tauri::command]
pub fn permissions_status() -> PermissionsStatus {
    permissions::status()
}

#[tauri::command]
pub fn open_settings_pane(kind: SettingsPaneKind) -> AppResult<()> {
    permissions::open_pane(kind)
}

#[tauri::command]
pub fn window_show(app: AppHandle, label: WindowLabel) -> AppResult<()> {
    windows::show(&app, label)
}

#[tauri::command]
pub fn window_hide(app: AppHandle, label: WindowLabel) -> AppResult<()> {
    windows::hide(&app, label)
}

// ---- LLM ----------------------------------------------------------------------------------------

#[tauri::command(rename_all = "snake_case")]
pub async fn llm_models(state: State<'_, AppState>, base_url: Option<String>) -> AppResult<Vec<String>> {
    llm_models_impl(&state, base_url).await
}

pub async fn llm_models_impl(state: &AppState, base_url: Option<String>) -> AppResult<Vec<String>> {
    let ep = state.llm_endpoint(base_url)?;
    llm::list_models(&state.http, &ep, llm::models_timeout(&ep.base_url)).await
}

#[derive(Debug, Serialize)]
pub struct LlmTestResult {
    pub model: String,
    pub ttft_ms: Option<f64>,
    pub total_ms: f64,
    pub reasoning_tokens: Option<u64>,
    pub reply: String,
}

#[tauri::command(rename_all = "snake_case")]
pub async fn llm_test(
    state: State<'_, AppState>,
    base_url: Option<String>,
    model: Option<String>,
    reasoning_effort: Option<ReasoningEffort>,
) -> AppResult<LlmTestResult> {
    llm_test_impl(&state, base_url, model, reasoning_effort).await
}

pub async fn llm_test_impl(
    state: &AppState,
    base_url: Option<String>,
    model: Option<String>,
    reasoning_effort: Option<ReasoningEffort>,
) -> AppResult<LlmTestResult> {
    let saved = state.snapshot()?.llm;
    let ep = state.llm_endpoint(base_url)?;
    let model = model.map(|m| m.trim().to_owned()).filter(|m| !m.is_empty()).unwrap_or(saved.model);
    if model.is_empty() {
        return Err(AppError::new(ErrorCode::NotConfigured, "Pick a model first"));
    }
    let req = ChatRequest {
        model,
        messages: vec![
            Message::system("You are a connection check. Answer with one word."),
            Message::user("Reply with the word: ready"),
        ],
        reasoning_effort: reasoning_effort.unwrap_or(saved.reasoning_effort),
        // Room for a reasoning model to think briefly and still answer.
        max_tokens: Some(64),
    };
    let out = llm::chat(&state.http, &ep, &req, LLM_TEST_TIMEOUT).await?;
    Ok(LlmTestResult {
        model: out.model,
        ttft_ms: out.ttft_ms,
        total_ms: out.total_ms,
        reasoning_tokens: out.reasoning_tokens,
        reply: out.text.chars().take(80).collect(),
    })
}

// ---- Speech to text -----------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct SttTestResult {
    pub model_id: String,
    pub total_ms: f64,
    pub text: String,
    pub language_code: String,
}

#[tauri::command]
pub async fn stt_test(state: State<'_, AppState>) -> AppResult<SttTestResult> {
    stt_test_impl(&state).await
}

pub async fn stt_test_impl(state: &AppState) -> AppResult<SttTestResult> {
    let key = state.elevenlabs_key()?;
    let model_id = state.snapshot()?.stt.model_id;
    let client = stt::Client { http: &state.http, base_url: &state.elevenlabs_base_url, api_key: &key, model_id: &model_id };
    let started = Instant::now();
    let out = client.transcribe(audio::test_clip(), None, stt::timeout_for(Some(1.0))).await?;
    Ok(SttTestResult { model_id, total_ms: http::ms(started.elapsed()), text: out.text, language_code: out.language_code })
}

#[derive(Debug, Serialize)]
pub struct Transcription {
    pub text: String,
    pub language_code: String,
    pub language_probability: Option<f64>,
    pub duration_secs: Option<f64>,
    pub total_ms: f64,
    pub retried: bool,
}

#[tauri::command(rename_all = "snake_case")]
pub async fn stt_transcribe(state: State<'_, AppState>, wav_base64: String) -> AppResult<Transcription> {
    stt_transcribe_impl(&state, &wav_base64).await
}

pub async fn stt_transcribe_impl(state: &AppState, wav_base64: &str) -> AppResult<Transcription> {
    if wav_base64.len() > MAX_WAV_BYTES / 3 * 4 + 4 {
        return Err(AppError::invalid("The recording is too long"));
    }
    let wav = base64::engine::general_purpose::STANDARD
        .decode(wav_base64.trim())
        .map_err(|_| AppError::invalid("The recording is not valid base64"))?;
    let measured = audio::wav_duration_secs(&wav).ok_or_else(|| AppError::invalid("The recording is not a WAV file"))?;
    if measured < 0.2 {
        return Err(AppError::invalid("The recording is too short. Hold the key a little longer"));
    }
    let key = state.elevenlabs_key()?;
    let s = state.snapshot()?;
    let client = stt::Client { http: &state.http, base_url: &state.elevenlabs_base_url, api_key: &key, model_id: &s.stt.model_id };
    let out = stt::transcribe_with_retry(&client, wav, &s.languages.spoken, s.languages.auto_detect, stt::timeout_for(Some(measured))).await?;
    Ok(Transcription {
        text: out.transcript.text,
        language_code: out.transcript.language_code,
        language_probability: out.transcript.language_probability,
        duration_secs: out.transcript.duration_secs.or(Some(measured)),
        total_ms: out.total_ms,
        retried: out.retried,
    })
}

// ---- Rewrite ------------------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct RefineResult {
    pub mode: Mode,
    pub text: String,
    /// Ask Anything only: whether the answer replaces the selection or is shown in a card.
    pub delivery: Option<Delivery>,
    pub model: String,
    pub ttft_ms: Option<f64>,
    pub total_ms: f64,
}

#[tauri::command(rename_all = "snake_case")]
pub async fn refine_text(
    state: State<'_, AppState>,
    mode: Mode,
    text: String,
    target_language: Option<String>,
    selected_text: Option<String>,
) -> AppResult<RefineResult> {
    refine_text_impl(&state, mode, &text, target_language, selected_text).await
}

pub async fn refine_text_impl(
    state: &AppState,
    mode: Mode,
    text: &str,
    target_language: Option<String>,
    selected_text: Option<String>,
) -> AppResult<RefineResult> {
    if text.trim().is_empty() {
        return Err(AppError::invalid("There is nothing to rewrite. Say a few words"));
    }
    if text.len() > 100_000 || selected_text.as_ref().is_some_and(|s| s.len() > 100_000) {
        return Err(AppError::invalid("The text is too long"));
    }
    let s = state.snapshot()?;
    if s.llm.model.is_empty() {
        return Err(AppError::new(ErrorCode::NotConfigured, "Pick an LLM model first"));
    }
    let ep = state.llm_endpoint(None)?;
    let target = target_language
        .filter(|t| !t.trim().is_empty())
        .or_else(|| s.languages.translate_targets.first().cloned())
        .map(|t| prompts::language_name(&t));
    let prompt = prompts::build(&PromptInput {
        mode,
        transcript: text,
        languages: &s.languages.spoken,
        target_language: target.as_deref(),
        dictionary: &[],
        app: Some("Comma setup"),
        selected_text: selected_text.as_deref(),
        marker: None,
    });
    let req = ChatRequest {
        model: s.llm.model.clone(),
        messages: vec![Message::system(prompt.system), Message::user(prompt.user)],
        reasoning_effort: s.llm.reasoning_effort,
        max_tokens: None,
    };
    let out = llm::chat(&state.http, &ep, &req, REFINE_TIMEOUT).await?;
    let (delivery, text) = if mode == Mode::Ask {
        let (delivery, body) = prompts::parse_ask_output(&out.text);
        (Some(delivery), body)
    } else {
        (None, out.text)
    };
    Ok(RefineResult { mode, text, delivery, model: out.model, ttft_ms: out.ttft_ms, total_ms: out.total_ms })
}

// ---- Comma account ------------------------------------------------------------------------------

#[derive(Debug, Serialize, PartialEq)]
pub struct AccountStatus {
    pub signed_in: bool,
    pub email: String,
    pub name: String,
    pub server_url: String,
    /// Signed in, but the server could not be reached to renew the session.
    pub offline: bool,
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

fn validate_email(email: &str) -> AppResult<String> {
    let email = email.trim().to_lowercase();
    let ok = email.len() <= 320 && email.split_once('@').is_some_and(|(a, b)| !a.is_empty() && b.contains('.'));
    if ok { Ok(email) } else { Err(AppError::invalid("Enter a valid email address")) }
}

fn validate_password(password: &str, new: bool) -> AppResult<()> {
    let len = password.chars().count();
    if new && len < 8 {
        return Err(AppError::invalid("Use at least 8 characters for the password"));
    }
    if len == 0 || len > 256 {
        return Err(AppError::invalid("Enter your password"));
    }
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn account_check(state: State<'_, AppState>, server_url: Option<String>) -> AppResult<()> {
    let url = match server_url.filter(|u| !u.trim().is_empty()) {
        Some(url) => url.trim().to_owned(),
        None => state.server_url()?,
    };
    settings::validate_url(&url, "The server URL")?;
    Server { http: &state.http, base_url: &url }.health().await
}

#[tauri::command]
pub async fn account_register(state: State<'_, AppState>, email: String, password: String, name: String) -> AppResult<()> {
    let email = validate_email(&email)?;
    validate_password(&password, true)?;
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 100 {
        return Err(AppError::invalid("Enter your name"));
    }
    let url = state.server_url()?;
    Server { http: &state.http, base_url: &url }.register(&email, &password, name).await.map(drop)
}

#[tauri::command]
pub async fn account_verify_email(state: State<'_, AppState>, email: String, code: String) -> AppResult<()> {
    let email = validate_email(&email)?;
    let code = code.trim();
    if code.len() != 6 || !code.chars().all(|c| c.is_ascii_digit()) {
        return Err(AppError::invalid("Enter the 6-digit code"));
    }
    let url = state.server_url()?;
    Server { http: &state.http, base_url: &url }.verify_email(&email, code).await
}

#[tauri::command]
pub async fn account_resend_code(state: State<'_, AppState>, email: String) -> AppResult<()> {
    let email = validate_email(&email)?;
    let url = state.server_url()?;
    Server { http: &state.http, base_url: &url }.resend_code(&email).await
}

#[tauri::command]
pub async fn account_sign_in(state: State<'_, AppState>, email: String, password: String) -> AppResult<AccountStatus> {
    account_sign_in_impl(&state, &email, &password).await
}

pub async fn account_sign_in_impl(state: &AppState, email: &str, password: &str) -> AppResult<AccountStatus> {
    let email = validate_email(email)?;
    validate_password(password, false)?;
    let url = state.server_url()?;
    let tokens = Server { http: &state.http, base_url: &url }.login(&email, password, &account::device_name()).await?;
    store_session(state, &tokens)?;
    state.update_settings(&json!({ "mode": "account" }))?;
    account_status_impl(state).await
}

fn store_session(state: &AppState, tokens: &account::Tokens) -> AppResult<()> {
    state.secrets.set(ACCOUNT_ACCESS, &tokens.access_token)?;
    state.secrets.set(ACCOUNT_REFRESH, &tokens.refresh_token)?;
    state.update_settings(&json!({
        "account": {
            "email": tokens.user.email,
            "name": tokens.user.name,
            "access_expires_at": now_secs() + tokens.expires_in,
        }
    }))?;
    Ok(())
}

fn clear_session(state: &AppState) -> AppResult<()> {
    state.secrets.delete(ACCOUNT_ACCESS)?;
    state.secrets.delete(ACCOUNT_REFRESH)?;
    state.update_settings(&json!({ "account": { "email": "", "name": "", "access_expires_at": 0 } }))?;
    Ok(())
}

#[tauri::command]
pub async fn account_status(state: State<'_, AppState>) -> AppResult<AccountStatus> {
    account_status_impl(&state).await
}

/// Signed in while a refresh token is stored. An expired access token is renewed here; a session
/// the server rejects is cleared, an unreachable server only marks the status offline.
pub async fn account_status_impl(state: &AppState) -> AppResult<AccountStatus> {
    let s = state.snapshot()?.account;
    let status = |signed_in: bool, offline: bool, s: &settings::AccountSettings| AccountStatus {
        signed_in,
        email: if signed_in { s.email.clone() } else { String::new() },
        name: if signed_in { s.name.clone() } else { String::new() },
        server_url: s.server_url.clone(),
        offline,
    };
    let Some(refresh) = state.secrets.get(ACCOUNT_REFRESH)? else {
        return Ok(status(false, false, &s));
    };
    if s.access_expires_at > now_secs() + 30 {
        return Ok(status(true, false, &s));
    }
    match (Server { http: &state.http, base_url: &s.server_url }).refresh(&refresh).await {
        Ok(tokens) => {
            store_session(state, &tokens)?;
            Ok(status(true, false, &state.snapshot()?.account))
        }
        Err(e) if e.code == ErrorCode::Server && e.reason.as_deref().is_some_and(|r| r.contains("refresh_token") || r == "unauthorized") => {
            clear_session(state)?;
            Ok(status(false, false, &state.snapshot()?.account))
        }
        Err(_) => Ok(status(true, true, &s)),
    }
}

#[tauri::command]
pub async fn account_sign_out(state: State<'_, AppState>) -> AppResult<()> {
    let url = state.server_url()?;
    if let Some(refresh) = state.secrets.get(ACCOUNT_REFRESH)? {
        // Best effort: the local session ends even when the server is unreachable.
        let _ = Server { http: &state.http, base_url: &url }.logout(&refresh).await;
    }
    clear_session(&state)?;
    if state.snapshot()?.mode == AppMode::Account {
        state.update_settings(&json!({ "mode": "local" }))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::memory::MemoryStore;
    use serde_json::json;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn state(dir: &tempfile::TempDir) -> AppState {
        AppState::new(Settings::default(), dir.path().join(settings::FILE_NAME), Box::new(MemoryStore::default()))
    }

    #[test]
    fn update_settings_persists_and_keeps_state_on_error() {
        let dir = tempfile::tempdir().unwrap();
        let state = state(&dir);
        let next = state.update_settings(&json!({ "onboarding_completed": true })).unwrap();
        assert!(next.onboarding_completed);
        assert_eq!(settings::load(&state.settings_path), next);

        assert!(state.update_settings(&json!({ "theme": 3 })).is_err());
        assert_eq!(*state.settings.lock().unwrap(), next);
    }

    #[test]
    fn app_error_serializes_as_code_and_message() {
        let json = serde_json::to_value(AppError::invalid("bad")).unwrap();
        assert_eq!(json, json!({ "code": "invalid_input", "message": "bad" }));
        let json = serde_json::to_value(AppError::new(ErrorCode::MissingPermission, "m").with_reason("missing_permissions")).unwrap();
        assert_eq!(json, json!({ "code": "missing_permission", "message": "m", "reason": "missing_permissions" }));
    }

    #[test]
    fn magpie_never_gets_the_stored_key() {
        let dir = tempfile::tempdir().unwrap();
        let state = state(&dir);
        secrets::set_secret(state.secrets.as_ref(), SecretName::Llm, "sk-custom").unwrap();
        assert!(state.llm_endpoint(None).unwrap().api_key.is_none());
        let custom = state.llm_endpoint(Some("https://api.example.com/v1".into())).unwrap();
        assert_eq!(custom.api_key.as_deref(), Some("sk-custom"));
        assert_eq!(state.llm_endpoint(Some("ftp://x".into())).unwrap_err().code, ErrorCode::InvalidInput);
    }

    #[tokio::test]
    async fn stt_test_needs_a_key_then_calls_elevenlabs() {
        let dir = tempfile::tempdir().unwrap();
        let mut state = state(&dir);
        assert_eq!(stt_test_impl(&state).await.unwrap_err().code, ErrorCode::NotConfigured);

        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/speech-to-text"))
            .and(header("xi-api-key", "el-key"))
            .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"text":"","language_code":"eng","language_probability":0.2}"#))
            .mount(&mock)
            .await;
        state.elevenlabs_base_url = mock.uri();
        secrets::set_secret(state.secrets.as_ref(), SecretName::Elevenlabs, "el-key").unwrap();
        let out = stt_test_impl(&state).await.unwrap();
        assert_eq!((out.model_id.as_str(), out.language_code.as_str()), ("scribe_v3", "eng"));
    }

    #[tokio::test]
    async fn transcribe_validates_the_upload() {
        let dir = tempfile::tempdir().unwrap();
        let state = state(&dir);
        assert_eq!(stt_transcribe_impl(&state, "@@@").await.unwrap_err().code, ErrorCode::InvalidInput);
        let not_wav = base64::engine::general_purpose::STANDARD.encode(b"hello");
        assert!(stt_transcribe_impl(&state, &not_wav).await.unwrap_err().message.contains("not a WAV"));
        let short = base64::engine::general_purpose::STANDARD.encode(audio::encode_wav(&[0; 800], 16_000));
        assert!(stt_transcribe_impl(&state, &short).await.unwrap_err().message.contains("too short"));
    }

    #[tokio::test]
    async fn refine_ask_splits_the_delivery_header() {
        let dir = tempfile::tempdir().unwrap();
        let state = state(&dir);
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"model":"m","choices":[{"message":{"content":"DELIVERY: inline\nShorter."}}]}"#))
            .mount(&mock)
            .await;
        state
            .update_settings(&json!({ "llm": { "base_url": format!("{}/v1", mock.uri()), "model": "m" } }))
            .unwrap();
        let out = refine_text_impl(&state, Mode::Ask, "make it shorter", None, Some("A long text.".into())).await.unwrap();
        assert_eq!((out.text.as_str(), out.delivery), ("Shorter.", Some(Delivery::Inline)));
        assert_eq!(refine_text_impl(&state, Mode::Dictate, "  ", None, None).await.unwrap_err().code, ErrorCode::InvalidInput);
    }

    /// Real calls against a local magpie: `cargo test -- --ignored real_magpie --nocapture`.
    #[tokio::test]
    #[ignore = "needs magpie running at 127.0.0.1:3425"]
    async fn real_magpie() {
        let dir = tempfile::tempdir().unwrap();
        let state = state(&dir);
        let models = llm_models_impl(&state, None).await.unwrap();
        println!("magpie lists {} models", models.len());
        let model = std::env::var("COMMA_TEST_MODEL").unwrap_or_else(|_| models[0].clone());
        let out = llm_test_impl(&state, None, Some(model), Some(ReasoningEffort::Low)).await.unwrap();
        println!("llm_test: {out:?}");
        let err = llm_test_impl(&state, None, Some("nope/no-such-model".into()), None).await.unwrap_err();
        println!("unknown model: {err:?}");
        assert_eq!(err.code, ErrorCode::UnknownModel);
    }

    #[tokio::test]
    async fn account_session_lifecycle() {
        let dir = tempfile::tempdir().unwrap();
        let state = state(&dir);
        let mock = MockServer::start().await;
        let user = r#"{"id":"8f1c2f5e-2d0c-4f5e-9b8a-3e1f7a6b9c01","email":"ada@example.com","name":"Ada","email_verified":true,"plan":"free","settings":{"languages":[],"translate_targets":[],"context_level":"app"},"created_at":"2026-11-18T10:00:00.000Z"}"#;
        Mock::given(method("POST"))
            .and(path("/v1/auth/login"))
            .respond_with(ResponseTemplate::new(200).set_body_string(format!(r#"{{"access_token":"a1","refresh_token":"r1","expires_in":900,"user":{user}}}"#)))
            .mount(&mock)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/auth/refresh"))
            .respond_with(ResponseTemplate::new(401).set_body_string(r#"{"code":"invalid_refresh_token","message":"no"}"#))
            .mount(&mock)
            .await;
        state.update_settings(&json!({ "account": { "server_url": mock.uri() } })).unwrap();

        let status = account_sign_in_impl(&state, "Ada@Example.com", "pw").await.unwrap();
        assert!(status.signed_in && !status.offline);
        assert_eq!((status.email.as_str(), status.name.as_str()), ("ada@example.com", "Ada"));
        assert_eq!(state.secrets.get(ACCOUNT_ACCESS).unwrap().as_deref(), Some("a1"));
        assert_eq!(state.snapshot().unwrap().mode, AppMode::Account);
        // The status never carries a token.
        let json = serde_json::to_string(&status).unwrap();
        assert!(!json.contains("a1") && !json.contains("r1"));

        // Once the access token expires, the status refreshes; the server rejects the refresh
        // token, so the session is cleared.
        state.update_settings(&json!({ "account": { "access_expires_at": 0 } })).unwrap();
        let status = account_status_impl(&state).await.unwrap();
        assert!(!status.signed_in);
        assert!(state.secrets.get(ACCOUNT_REFRESH).unwrap().is_none());

        // Unreachable server with a stored session: still signed in, marked offline.
        state.secrets.set(ACCOUNT_REFRESH, "r2").unwrap();
        state.update_settings(&json!({ "account": { "server_url": "http://127.0.0.1:9", "email": "ada@example.com" } })).unwrap();
        let status = account_status_impl(&state).await.unwrap();
        assert!(status.signed_in && status.offline);
    }
}
