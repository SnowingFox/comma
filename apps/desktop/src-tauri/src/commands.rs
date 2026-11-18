//! Tauri commands (spec 3.3). Contract: `packages/shared/src/ipc/commands.ts`.
//!
//! Commands with multi-word arguments use `rename_all = "snake_case"`, so the frontend passes the
//! same keys the contract lists (`base_url`, not `baseUrl`).

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use comma_voice::llm::{self as voice_llm, ChatModel, ChatRequest, Message, OpenAiCompatible};
use comma_voice::pipeline::{self, RefineContext};
use comma_voice::prompts::{Delivery, Mode};
use comma_voice::stt::{Audio, ElevenLabs, SpeechToText, SttOptions};
use comma_voice::{CancellationToken, http, wav};
use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::account::{self, Server};
use crate::db::{self, Db};
use crate::run::{self, HintKind, RunArgs, RunOutput, RunResult, Session};
use crate::shortcuts::{Shortcuts, ShortcutsStatus};
use crate::error::{AppError, AppResult, ErrorCode};
use crate::permissions::{self, PermissionsStatus, SettingsPaneKind};
use crate::secrets::{self, ACCOUNT_ACCESS, ACCOUNT_REFRESH, SecretName, SecretStatus, SecretStore};
use crate::settings::{self, AppMode, MAGPIE_BASE_URL, ReasoningEffort, Settings};
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
    /// `comma_voice::stt::ELEVENLABS_BASE_URL`, replaced by a mock server in tests.
    pub elevenlabs_base_url: String,
    pub db: Db,
    pub session: Mutex<Session>,
    /// Token refreshes never overlap.
    pub refresh_lock: tokio::sync::Mutex<()>,
    pub paste_lock: run::PasteLock,
}

fn ms(d: Duration) -> f64 {
    (d.as_secs_f64() * 10_000.0).round() / 10.0
}

impl AppState {
    pub fn new(settings: Settings, settings_path: PathBuf, secrets: Box<dyn SecretStore>, db: Db) -> Self {
        Self {
            settings: Mutex::new(settings),
            settings_path,
            secrets,
            http: http::client(),
            elevenlabs_base_url: comma_voice::stt::ELEVENLABS_BASE_URL.into(),
            db,
            session: Mutex::new(Session::default()),
            refresh_lock: tokio::sync::Mutex::new(()),
            paste_lock: Arc::new(Mutex::new(())),
        }
    }

    fn settings(&self) -> AppResult<std::sync::MutexGuard<'_, Settings>> {
        self.settings.lock().map_err(|_| AppError::internal("settings lock poisoned"))
    }

    pub fn settings_guard(&self) -> AppResult<std::sync::MutexGuard<'_, Settings>> {
        self.settings()
    }

    pub fn snapshot(&self) -> AppResult<Settings> {
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
    pub fn llm_endpoint(&self, base_url: Option<String>) -> AppResult<OpenAiCompatible> {
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
        Ok(OpenAiCompatible::new(self.http.clone(), base_url, api_key))
    }

    /// ElevenLabs with the stored key and the saved model.
    pub fn elevenlabs(&self) -> AppResult<ElevenLabs> {
        let key = secrets::get_key(self.secrets.as_ref(), SecretName::Elevenlabs)?
            .ok_or_else(|| AppError::new(ErrorCode::NotConfigured, "Add your ElevenLabs API key first"))?;
        let model_id = self.settings()?.stt.model_id.clone();
        Ok(ElevenLabs::new(self.http.clone(), key, model_id).with_base_url(&self.elevenlabs_base_url))
    }

    pub fn server_url(&self) -> AppResult<String> {
        Ok(self.settings()?.account.server_url.clone())
    }
}

#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> AppResult<Settings> {
    state.snapshot()
}

#[tauri::command]
pub fn settings_set(app: AppHandle, state: State<'_, AppState>, patch: Value) -> AppResult<Settings> {
    let before = state.snapshot()?;
    let next = state.update_settings(&patch)?;
    after_settings_change(&app, &before, &next);
    Ok(next)
}

/// Re-registers shortcuts, prunes history and tells the other windows.
pub fn after_settings_change(app: &AppHandle, before: &Settings, next: &Settings) {
    if before.shortcuts != next.shortcuts
        && let Some(shortcuts) = app.try_state::<Shortcuts>()
    {
        shortcuts.reconfigure(app, &next.shortcuts);
    }
    if before.privacy.history_days != next.privacy.history_days
        && let Some(state) = app.try_state::<AppState>()
    {
        let _ = state.db.prune(next.privacy.history_days, now_ms());
        let _ = app.emit("history://changed", json!({}));
    }
    if before.feedback.show_idle_bar != next.feedback.show_idle_bar {
        let layout = if next.feedback.show_idle_bar { windows::BarLayout::Dot } else { windows::BarLayout::Hidden };
        let _ = windows::set_bar(app, layout, next.feedback.show_idle_bar);
    }
    let _ = app.emit("settings://changed", json!({}));
}

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
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

/// Input Monitoring is granted when the preflight says so or a key press reached the Fn tap (the
/// preflight can stay "no" until relaunch). A running tap alone is no proof: macOS creates one
/// without the permission and then passes it modifier changes only.
#[tauri::command]
pub fn permissions_status(app: AppHandle) -> PermissionsStatus {
    let mut status = permissions::status();
    if app.try_state::<Shortcuts>().is_some_and(|s| s.input_monitoring_effective()) {
        status.input_monitoring = permissions::PermissionState::Granted;
    }
    status
}

/// On a click only. The system prompt can show once per process; later clicks just re-check (the
/// frontend then opens System Settings, and offers a relaunch).
#[tauri::command]
pub fn input_monitoring_request(app: AppHandle) -> bool {
    let Some(shortcuts) = app.try_state::<Shortcuts>() else { return comma_input::input_monitoring_granted() };
    let granted = if shortcuts.take_request() {
        let granted = comma_input::request_input_monitoring();
        log::info!("Input Monitoring requested: {}", if granted { "allowed" } else { "not allowed yet" });
        granted
    } else {
        log::info!("Input Monitoring asked again: not prompting a second time in this process");
        comma_input::input_monitoring_granted()
    };
    shortcuts.probe(&app);
    granted || shortcuts.input_monitoring_effective()
}

/// Experimental: an active tap that swallows Fn so the Globe key action does not run (needs
/// Accessibility). Off by default; the devtool turns it on.
#[tauri::command]
pub fn shortcuts_set_swallow(app: AppHandle, on: bool) -> AppResult<ShortcutsStatus> {
    let s = shortcuts(&app)?;
    s.set_swallow(&app, on);
    s.status()
}

/// Quits and relaunches Comma, for a permission macOS applies only to a new process.
#[tauri::command]
pub fn app_restart(app: AppHandle) {
    log::info!("restarting at the user's request");
    app.restart();
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
    Ok(state.llm_endpoint(base_url)?.list_models().await?)
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

/// One tiny streamed completion.
pub async fn llm_test_impl(
    state: &AppState,
    base_url: Option<String>,
    model: Option<String>,
    reasoning_effort: Option<ReasoningEffort>,
) -> AppResult<LlmTestResult> {
    let saved = state.snapshot()?.llm;
    let endpoint = state.llm_endpoint(base_url)?;
    let model = model.map(|m| m.trim().to_owned()).filter(|m| !m.is_empty()).unwrap_or(saved.model);
    if model.is_empty() {
        return Err(AppError::new(ErrorCode::NotConfigured, "Pick a model first"));
    }
    let mut req = ChatRequest::new(
        model,
        vec![Message::system("You are a connection check. Answer with one word."), Message::user("Reply with the word: ready")],
    );
    req.reasoning_effort = reasoning_effort.unwrap_or(saved.reasoning_effort);
    // Room for a reasoning model to think briefly and still answer.
    req.max_tokens = Some(64);
    req.timeout = LLM_TEST_TIMEOUT;
    let out = voice_llm::complete(&endpoint, req, CancellationToken::new(), |_| {}).await?;
    Ok(LlmTestResult {
        model: out.model,
        ttft_ms: out.ttft.map(ms),
        total_ms: ms(out.total),
        reasoning_tokens: out.usage.reasoning_tokens,
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

/// Sends a generated one-second clip: proves the key, the permission and the model.
pub async fn stt_test_impl(state: &AppState) -> AppResult<SttTestResult> {
    let stt = state.elevenlabs()?;
    let opts = SttOptions { auto_detect: true, ..Default::default() };
    let out = stt.transcribe(Audio::wav(wav::test_clip()), &opts).await?;
    Ok(SttTestResult { model_id: stt.model_id().to_owned(), total_ms: ms(out.timing), text: out.text, language_code: out.language })
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
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(wav_base64.trim())
        .map_err(|_| AppError::invalid("The recording is not valid base64"))?;
    let measured = wav::duration_secs(&bytes).ok_or_else(|| AppError::invalid("The recording is not a WAV file"))?;
    if measured < 0.2 {
        return Err(AppError::invalid("The recording is too short. Hold the key a little longer"));
    }
    let stt = state.elevenlabs()?;
    let languages = state.snapshot()?.languages;
    let opts = SttOptions { languages: languages.spoken, auto_detect: languages.auto_detect, ..Default::default() };
    let out = stt.transcribe(Audio::wav(bytes), &opts).await?;
    Ok(Transcription {
        retried: out.retried(),
        text: out.text,
        language_code: out.language,
        language_probability: out.language_probability,
        duration_secs: Some(out.duration.map_or(measured, |d| d.as_secs_f64())),
        total_ms: ms(out.timing),
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
    let endpoint = state.llm_endpoint(None)?;
    let mut ctx = RefineContext::new(mode, s.llm.model.clone());
    ctx.reasoning_effort = s.llm.reasoning_effort;
    ctx.languages = s.languages.spoken.clone();
    ctx.target_language = target_language
        .filter(|t| !t.trim().is_empty())
        .or_else(|| s.languages.translate_targets.first().cloned());
    ctx.app = Some("Comma setup".into());
    ctx.selected_text = selected_text;
    ctx.timeout = REFINE_TIMEOUT;
    let out = pipeline::refine(&endpoint, text, &ctx, CancellationToken::new(), |_| {}).await?;
    Ok(RefineResult {
        mode,
        text: out.text,
        delivery: out.delivery,
        model: out.model,
        ttft_ms: out.ttft.map(ms),
        total_ms: ms(out.total),
    })
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

pub fn now_secs() -> u64 {
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

pub fn store_session(state: &AppState, tokens: &account::Tokens) -> AppResult<()> {
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

pub fn clear_session(state: &AppState) -> AppResult<()> {
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
    let Some(_) = state.secrets.get(ACCOUNT_REFRESH)? else {
        return Ok(status(false, false, &s));
    };
    if s.access_expires_at > now_secs() + 30 {
        return Ok(status(true, false, &s));
    }
    let _lock = state.refresh_lock.lock().await;
    // Another caller may have refreshed while this one waited.
    let s = state.snapshot()?.account;
    if s.access_expires_at > now_secs() + 30 {
        return Ok(status(true, false, &s));
    }
    let Some(refresh) = state.secrets.get(ACCOUNT_REFRESH)? else {
        return Ok(status(false, false, &s));
    };
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

// ---- Dictation loop -----------------------------------------------------------------------------

fn shortcuts(app: &AppHandle) -> AppResult<tauri::State<'_, Shortcuts>> {
    app.try_state::<Shortcuts>().ok_or_else(|| AppError::internal("shortcuts are not running"))
}

#[tauri::command]
pub fn shortcuts_status(app: AppHandle) -> AppResult<ShortcutsStatus> {
    shortcuts(&app)?.status()
}

#[tauri::command]
pub fn shortcuts_capture(app: AppHandle, owner: Option<WindowLabel>) -> AppResult<()> {
    if owner == Some(WindowLabel::Bar) {
        return Err(AppError::invalid("only onboarding and the hub can capture shortcuts"));
    }
    shortcuts(&app)?.set_capture(owner);
    Ok(())
}

/// Stops the Fn tap and the plugin shortcuts and registers everything again.
#[tauri::command]
pub fn shortcuts_restart(app: AppHandle) -> AppResult<ShortcutsStatus> {
    log::info!("shortcuts: restart requested");
    let s = shortcuts(&app)?;
    s.restart(&app);
    s.status()
}

/// Re-checks Input Monitoring and tries the tap even when the preflight says no.
#[tauri::command]
pub fn shortcuts_probe(app: AppHandle) -> AppResult<ShortcutsStatus> {
    log::info!("shortcuts: probe requested");
    let s = shortcuts(&app)?;
    s.probe(&app);
    s.status()
}

#[tauri::command]
pub fn shortcuts_suspend(app: AppHandle, suspended: bool) -> AppResult<()> {
    shortcuts(&app)?.set_suspended(&app, suspended);
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
#[allow(clippy::too_many_arguments)]
pub async fn pipeline_run(
    app: AppHandle,
    state: State<'_, AppState>,
    mode: Mode,
    audio_base64: String,
    source: run::RunSource,
    audio_secs: Option<f64>,
    target_language: Option<String>,
    selected_text: Option<String>,
    record_ms: Option<f64>,
) -> AppResult<RunResult> {
    let args = RunArgs { mode, audio_base64, source, target_language, selected_text, record_ms, audio_secs };
    run::pipeline_run(&app, &state, args).await
}

/// Whether a run can start (keys or session), checked by the bar when the shortcut goes down.
#[tauri::command]
pub async fn pipeline_check(state: State<'_, AppState>, mode: Mode) -> AppResult<()> {
    let ready = run::readiness(&state);
    if let Err(e) = &ready {
        log::warn!("{mode:?} cannot start: {}", e.reason.as_deref().unwrap_or(&e.message));
    }
    ready
}

#[tauri::command]
pub fn pipeline_cancel(state: State<'_, AppState>) -> AppResult<()> {
    if let Some(cancel) = state.session.lock().map_err(|_| AppError::internal("session lock poisoned"))?.cancel.as_ref() {
        cancel.cancel();
    }
    Ok(())
}

#[tauri::command]
pub async fn output_insert(state: State<'_, AppState>, text: String) -> AppResult<RunOutput> {
    if text.is_empty() || text.len() > 100_000 {
        return Err(AppError::invalid("Nothing to insert"));
    }
    Ok(run::insert_answer(&state, &text).await)
}

#[tauri::command]
pub fn clipboard_copy(text: String) -> AppResult<()> {
    if text.len() > 100_000 {
        return Err(AppError::invalid("The text is too long"));
    }
    run::copy(&text);
    Ok(())
}

#[tauri::command]
pub fn bar_layout(app: AppHandle, layout: windows::BarLayout, interactive: bool, escape: Option<bool>) -> AppResult<()> {
    if let Ok(s) = shortcuts(&app) {
        s.set_card_open(escape.unwrap_or(false));
    }
    windows::set_bar(&app, layout, interactive)
}

#[tauri::command]
pub fn bar_menu(app: AppHandle, state: State<'_, AppState>) -> AppResult<()> {
    let has_last = state.session.lock().map(|s| s.last_text.is_some()).unwrap_or(false) || state.db.last_ok_run()?.is_some();
    windows::bar_menu(&app, has_last, &state.snapshot()?.languages.translate_targets)
}

/// The bar menu's items.
pub fn on_bar_menu(app: &AppHandle, id: &str) {
    let Some(state) = app.try_state::<AppState>() else { return };
    if id == windows::MENU_COPY {
        let last = state.session.lock().ok().and_then(|s| s.last_text.clone());
        let last = last.or_else(|| state.db.last_ok_run().ok().flatten().map(|r| r.refined_text));
        if let Some(text) = last {
            run::copy(&text);
        }
    } else if id == windows::MENU_OPEN {
        let _ = crate::tray::open_main(app);
    } else if let Some(tag) = id.strip_prefix(windows::MENU_LANG)
        && let Ok(before) = state.snapshot()
    {
        let targets = windows::with_first_target(&before.languages.translate_targets, tag);
        if let Ok(next) = state.update_settings(&json!({ "languages": { "translate_targets": targets } })) {
            after_settings_change(app, &before, &next);
        }
    }
}

#[derive(Debug, Serialize)]
pub struct LogTail {
    pub path: String,
    pub lines: Vec<String>,
}

pub const LOG_FILE: &str = "comma";
const LOG_TAIL_BYTES: u64 = 256 * 1024;

/// The last `lines` lines of the current log file.
pub fn read_tail(path: &std::path::Path, lines: usize) -> AppResult<Vec<String>> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    let len = file.metadata()?.len();
    let start = len.saturating_sub(LOG_TAIL_BYTES);
    file.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf)?;
    let text = String::from_utf8_lossy(&buf);
    let mut all: Vec<&str> = text.lines().collect();
    if start > 0 && !all.is_empty() {
        // The first line was cut by the seek.
        all.remove(0);
    }
    Ok(all[all.len().saturating_sub(lines)..].iter().map(|l| (*l).to_owned()).collect())
}

#[tauri::command]
pub async fn log_tail(app: AppHandle, lines: Option<u32>) -> AppResult<LogTail> {
    let dir = app.path().app_log_dir().map_err(|e| AppError::internal(e.to_string()))?;
    let path = dir.join(format!("{LOG_FILE}.log"));
    let lines = read_tail(&path, lines.unwrap_or(200).clamp(1, 1000) as usize)?;
    Ok(LogTail { path: path.to_string_lossy().into_owned(), lines })
}

#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LogLevel {
    Info,
    Warn,
    Error,
}

/// A line from a window (the bar's microphone errors, for instance). Windows send states and error
/// names only, never text the user dictated or typed.
#[tauri::command]
pub fn log_write(level: LogLevel, scope: String, message: String) -> AppResult<()> {
    if scope.len() > 32 || message.len() > 500 {
        return Err(AppError::invalid("log line too long"));
    }
    let scope: String = scope.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
    let message = message.replace(['\n', '\r'], " ");
    match level {
        LogLevel::Info => log::info!(target: "webview", "[{scope}] {message}"),
        LogLevel::Warn => log::warn!(target: "webview", "[{scope}] {message}"),
        LogLevel::Error => log::error!(target: "webview", "[{scope}] {message}"),
    }
    Ok(())
}

#[tauri::command]
pub fn hint_take(state: State<'_, AppState>, kind: HintKind) -> AppResult<bool> {
    run::hint_take(&state, kind)
}

/// Forgets how often each hint was shown, so the teaching hints show again.
#[tauri::command]
pub fn hints_reset(app: AppHandle, state: State<'_, AppState>) -> AppResult<()> {
    run::hints_reset(&state)?;
    let _ = app.emit("settings://changed", json!({}));
    Ok(())
}

// ---- History and usage --------------------------------------------------------------------------

#[tauri::command]
pub async fn runs_list(state: State<'_, AppState>, search: Option<String>, before: Option<i64>, limit: Option<u32>) -> AppResult<Vec<db::RunRecord>> {
    state.db.list_runs(&db::RunsQuery { search, before, limit })
}

#[tauri::command]
pub async fn run_get(state: State<'_, AppState>, id: String) -> AppResult<db::RunRecord> {
    state.db.get_run(&id)
}

#[tauri::command]
pub async fn run_delete(app: AppHandle, state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.db.delete_run(&id)?;
    let _ = app.emit("history://changed", json!({ "id": id }));
    Ok(())
}

#[tauri::command]
pub async fn runs_clear(app: AppHandle, state: State<'_, AppState>) -> AppResult<()> {
    state.db.clear_runs()?;
    let _ = app.emit("history://changed", json!({}));
    Ok(())
}

#[tauri::command]
pub async fn run_rerun(app: AppHandle, state: State<'_, AppState>, id: String) -> AppResult<db::RunRecord> {
    let run = run::rerun(&state, &id).await?;
    let _ = app.emit("history://changed", json!({ "id": id }));
    Ok(run)
}

#[tauri::command]
pub async fn run_audio(state: State<'_, AppState>, id: String) -> AppResult<String> {
    Ok(base64::engine::general_purpose::STANDARD.encode(state.db.run_audio(&id)?))
}

#[tauri::command]
pub async fn usage_summary(state: State<'_, AppState>, range: db::UsageRange) -> AppResult<db::UsageSummary> {
    state.db.usage_summary(range, now_ms())
}

#[tauri::command]
pub async fn usage_daily(state: State<'_, AppState>, range: db::UsageRange) -> AppResult<Vec<db::Day>> {
    state.db.usage_daily(range, now_ms())
}

#[derive(Debug, Serialize)]
pub struct ExportResult {
    pub path: String,
}

#[tauri::command]
pub async fn usage_export_csv(app: AppHandle, state: State<'_, AppState>, range: db::UsageRange) -> AppResult<ExportResult> {
    let csv = state.db.usage_csv(range, now_ms())?;
    let dir = app.path().download_dir().map_err(|e| AppError::internal(e.to_string()))?;
    let label = match range {
        db::UsageRange::Today => "today",
        db::UsageRange::Week => "7d",
        db::UsageRange::Month => "30d",
        db::UsageRange::Quarter => "90d",
    };
    let mut path = dir.join(format!("comma-usage-{label}.csv"));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("comma-usage-{label}-{n}.csv"));
        n += 1;
    }
    std::fs::write(&path, csv)?;
    Ok(ExportResult { path: path.to_string_lossy().into_owned() })
}

// ---- Dictionary: local in Local mode, the server's in account mode ------------------------------

fn account_mode(state: &AppState) -> AppResult<bool> {
    Ok(state.snapshot()?.mode == AppMode::Account)
}

fn server_term(t: account::ServerTerm) -> db::Term {
    db::Term { id: t.id, term: t.term, created_at: t.created_at }
}

#[tauri::command]
pub async fn dictionary_list(state: State<'_, AppState>) -> AppResult<Vec<db::Term>> {
    if !account_mode(&state)? {
        return state.db.terms();
    }
    let url = state.server_url()?;
    let terms = run::with_access(&state, |t| {
        let url = url.clone();
        let http = state.http.clone();
        async move { Server { http: &http, base_url: &url }.dictionary(&t).await }
    })
    .await?;
    Ok(terms.into_iter().map(server_term).collect())
}

#[tauri::command]
pub async fn dictionary_add(state: State<'_, AppState>, term: String) -> AppResult<db::Term> {
    let term = db::clean_term(&term)?;
    if !account_mode(&state)? {
        return state.db.add_term(&term);
    }
    let url = state.server_url()?;
    let added = run::with_access(&state, |t| {
        let (url, http, term) = (url.clone(), state.http.clone(), term.clone());
        async move { Server { http: &http, base_url: &url }.dictionary_add(&t, &term).await }
    })
    .await?;
    Ok(server_term(added))
}

#[tauri::command]
pub async fn dictionary_update(state: State<'_, AppState>, id: String, term: String) -> AppResult<db::Term> {
    let term = db::clean_term(&term)?;
    if !account_mode(&state)? {
        return state.db.update_term(&id, &term);
    }
    let url = state.server_url()?;
    let updated = run::with_access(&state, |t| {
        let (url, http, term, id) = (url.clone(), state.http.clone(), term.clone(), id.clone());
        async move { Server { http: &http, base_url: &url }.dictionary_update(&t, &id, &term).await }
    })
    .await?;
    Ok(server_term(updated))
}

#[tauri::command]
pub async fn dictionary_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    if !account_mode(&state)? {
        return state.db.delete_term(&id);
    }
    let url = state.server_url()?;
    run::with_access(&state, |t| {
        let (url, http, id) = (url.clone(), state.http.clone(), id.clone());
        async move { Server { http: &http, base_url: &url }.dictionary_delete(&t, &id).await }
    })
    .await
}

#[tauri::command]
pub async fn dictionary_import_csv(state: State<'_, AppState>, csv: String) -> AppResult<db::ImportResult> {
    if csv.len() > 200_000 {
        return Err(AppError::invalid("That file is too large to import"));
    }
    if !account_mode(&state)? {
        return state.db.import_terms(&csv);
    }
    let url = state.server_url()?;
    let res = run::with_access(&state, |t| {
        let (url, http, csv) = (url.clone(), state.http.clone(), csv.clone());
        async move { Server { http: &http, base_url: &url }.dictionary_import(&t, &csv).await }
    })
    .await?;
    Ok(db::ImportResult { added: res.added, skipped: res.skipped })
}

#[tauri::command]
pub async fn account_credits(state: State<'_, AppState>) -> AppResult<account::Credits> {
    let url = state.server_url()?;
    run::with_access(&state, |t| {
        let (url, http) = (url.clone(), state.http.clone());
        async move { Server { http: &http, base_url: &url }.credits(&t).await }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::memory::MemoryStore;
    use serde_json::json;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn state(dir: &tempfile::TempDir) -> AppState {
        AppState::new(
            Settings::default(),
            dir.path().join(settings::FILE_NAME),
            Box::new(MemoryStore::default()),
            Db::in_memory(dir.path().join("audio")).unwrap(),
        )
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
    fn log_tail_reads_the_last_lines() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("comma.log");
        assert!(read_tail(&path, 10).unwrap().is_empty(), "no file yet");
        std::fs::write(&path, (1..=50).map(|i| format!("line {i}\n")).collect::<String>()).unwrap();
        assert_eq!(read_tail(&path, 3).unwrap(), ["line 48", "line 49", "line 50"]);
        // Longer than the tail window: the cut first line is dropped.
        let long: String = (0..40_000).map(|i| format!("entry {i:06}\n")).collect();
        std::fs::write(&path, long).unwrap();
        let tail = read_tail(&path, 100_000).unwrap();
        assert!(tail.iter().all(|l| l.starts_with("entry ") && l.len() == 12));
        assert_eq!(tail.last().unwrap(), "entry 039999");
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
        assert!(format!("{:?}", state.llm_endpoint(None).unwrap()).contains("has_key: false"));
        let custom = state.llm_endpoint(Some("https://api.example.com/v1".into())).unwrap();
        assert!(format!("{custom:?}").contains("has_key: true"));
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
        let short = base64::engine::general_purpose::STANDARD.encode(wav::encode_wav(&[0; 800], 16_000));
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

    /// A Local-mode run through the app's pipeline (`run::run_inner`, what `pipeline_run` calls):
    /// the real rewrite on magpie, ElevenLabs mocked (no key in the Keychain). Saves to history.
    /// `COMMA_TEST_WAV=/path/speech.wav COMMA_TEST_MODEL=... cargo test -p comma real_local_run -- --ignored --nocapture`
    #[tokio::test]
    #[ignore = "needs magpie running at 127.0.0.1:3425"]
    async fn real_local_run() {
        let dir = tempfile::tempdir().unwrap();
        let mut state = state(&dir);
        let model = std::env::var("COMMA_TEST_MODEL").unwrap_or_else(|_| "cursor/deepseek-v41-flash-1017".into());
        let wav = std::env::var("COMMA_TEST_WAV").map(|p| std::fs::read(p).unwrap()).unwrap_or_else(|_| wav::test_clip());
        let secs = wav::duration_secs(&wav).unwrap();
        let raw = "um so I wanted to uh follow up on the design review from tuesday can we move the launch to next thursday no wait next friday and make sure the onboarding copy is final by then";
        let mock = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/speech-to-text"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "text": raw, "language_code": "eng", "language_probability": 0.98 })))
            .expect(2)
            .mount(&mock)
            .await;
        state.elevenlabs_base_url = mock.uri();
        secrets::set_secret(state.secrets.as_ref(), SecretName::Elevenlabs, "el-mock").unwrap();
        state.update_settings(&json!({ "llm": { "model": model, "reasoning_effort": "off" }, "languages": { "spoken": ["en"] } })).unwrap();
        state.db.add_term("Comma").unwrap();

        let events = std::sync::Mutex::new(Vec::<String>::new());
        let emit = |label: &str, event: &str, payload: Value| {
            events.lock().unwrap().push(format!("{label} {event} {payload}"));
        };
        for (mode, selected) in [(Mode::Dictate, None), (Mode::Ask, Some("Our launch is scheduled for next Thursday at the earliest, pending design review."))] {
            let args = run::RunArgs {
                mode,
                audio_base64: base64::engine::general_purpose::STANDARD.encode(&wav),
                source: run::RunSource::Onboarding,
                target_language: None,
                selected_text: selected.map(str::to_owned),
                record_ms: Some(secs * 1000.0),
                audio_secs: None,
            };
            let t = std::time::Instant::now();
            let out = run::run_inner(&emit, &state, &args, &format!("test-{mode:?}"), "onboarding", comma_voice::CancellationToken::new(), t).await.unwrap();
            println!(
                "{mode:?}: {:.1} s audio, stt {} ms (mock), llm first token {:?} ms, llm {} ms, total {} ms, delivery {:?}\n  raw: {}\n  refined: {}",
                out.audio_secs, out.stt_ms, out.llm_ttft_ms, out.llm_total_ms, out.total_ms, out.delivery, out.raw_text, out.refined_text
            );
            assert!(!out.refined_text.is_empty());
        }
        let runs = state.db.list_runs(&db::RunsQuery { search: None, before: None, limit: Some(10) }).unwrap();
        assert_eq!(runs.len(), 2);
        assert!(runs.iter().all(|r| r.ok && r.model.is_some()));
        assert!(events.lock().unwrap().iter().any(|e| e.contains("run://stage") && e.contains("\"llm\"")));
        println!("events: {}", events.lock().unwrap().len());
    }

    /// The app's pipeline with the real ElevenLabs (key from the environment, held only in the
    /// in-memory store, never the Keychain) and the rewrite on magpie:
    /// `ELEVENLABS_API_KEY=... COMMA_TEST_WAV=speech.wav cargo test -p comma real_elevenlabs_run -- --ignored --nocapture`
    #[tokio::test]
    #[ignore = "needs ELEVENLABS_API_KEY, a speech WAV and magpie"]
    async fn real_elevenlabs_run() {
        let key = std::env::var("ELEVENLABS_API_KEY").expect("ELEVENLABS_API_KEY");
        let wav = std::fs::read(std::env::var("COMMA_TEST_WAV").expect("COMMA_TEST_WAV")).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let state = state(&dir);
        let models = llm_models_impl(&state, None).await.unwrap();
        let model = std::env::var("COMMA_TEST_MODEL").unwrap_or_else(|_| models[0].clone());
        secrets::set_secret(state.secrets.as_ref(), SecretName::Elevenlabs, &key).unwrap();
        state.update_settings(&json!({ "llm": { "model": model, "reasoning_effort": "off" } })).unwrap();
        assert!(run::readiness(&state).is_ok());
        let args = run::RunArgs {
            mode: Mode::Dictate,
            audio_base64: base64::engine::general_purpose::STANDARD.encode(&wav),
            source: run::RunSource::Onboarding,
            target_language: None,
            selected_text: None,
            record_ms: None,
            audio_secs: None,
        };
        let stages = std::sync::Mutex::new(Vec::<String>::new());
        let emit = |_: &str, event: &str, payload: Value| {
            if event == "run://stage" {
                stages.lock().unwrap().push(format!("{} {}", payload["stage"], payload["ms"]));
            }
        };
        let out = run::run_inner(&emit, &state, &args, "real", "onboarding", comma_voice::CancellationToken::new(), std::time::Instant::now()).await.unwrap();
        println!("stt {} ms, llm {} ms, total {} ms, stages {:?}\n  raw: {}\n  refined: {}", out.stt_ms, out.llm_total_ms, out.total_ms, stages.lock().unwrap(), out.raw_text, out.refined_text);
        assert!(!out.refined_text.is_empty());
        assert_eq!(state.db.list_runs(&db::RunsQuery::default()).unwrap().len(), 1);
    }

    /// Account mode: an expired access token is refused with 401, refreshed once, and the call is
    /// retried with the new token; the refreshed pair is stored.
    #[tokio::test]
    async fn account_calls_refresh_on_401_and_retry() {
        let dir = tempfile::tempdir().unwrap();
        let state = state(&dir);
        let mock = MockServer::start().await;
        let user = r#"{"id":"8f1c2f5e-2d0c-4f5e-9b8a-3e1f7a6b9c01","email":"ada@example.com","name":"Ada","email_verified":true,"plan":"free","settings":{"languages":[],"translate_targets":[],"context_level":"app","provider_mode":"comma"},"created_at":"2026-11-18T10:00:00.000Z"}"#;
        Mock::given(method("GET"))
            .and(path("/v1/me/credits"))
            .and(header("authorization", "Bearer old"))
            .respond_with(ResponseTemplate::new(401).set_body_string(r#"{"code":"invalid_token","message":"expired"}"#))
            .mount(&mock)
            .await;
        Mock::given(method("GET"))
            .and(path("/v1/me/credits"))
            .and(header("authorization", "Bearer new"))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                r#"{"plan":"free","period_start":"2026-11-16T00:00:00.000Z","period_end":"2026-11-23T00:00:00.000Z","used_seconds":60,"limit_seconds":1800}"#,
            ))
            .mount(&mock)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/auth/refresh"))
            .respond_with(ResponseTemplate::new(200).set_body_string(format!(r#"{{"access_token":"new","refresh_token":"r2","expires_in":900,"user":{user}}}"#)))
            .expect(1)
            .mount(&mock)
            .await;
        state.secrets.set(ACCOUNT_ACCESS, "old").unwrap();
        state.secrets.set(ACCOUNT_REFRESH, "r1").unwrap();
        // The stored token looks fresh, so the first call uses it and gets the 401.
        state
            .update_settings(&json!({ "mode": "account", "account": { "server_url": mock.uri(), "access_expires_at": now_secs() + 600 } }))
            .unwrap();
        let url = state.server_url().unwrap();
        let credits = run::with_access(&state, |t| {
            let (url, http) = (url.clone(), state.http.clone());
            async move { Server { http: &http, base_url: &url }.credits(&t).await }
        })
        .await
        .unwrap();
        assert_eq!(credits.limit_seconds, 1800.0);
        assert_eq!(state.secrets.get(ACCOUNT_REFRESH).unwrap().as_deref(), Some("r2"));

        // Without a session the call fails as signed out, before any request.
        clear_session(&state).unwrap();
        let err = run::access_token(&state, false).await.unwrap_err();
        assert_eq!(err.reason.as_deref(), Some("signed_out"));
    }

    /// The run's history and dictionary in Local mode go to SQLite.
    #[tokio::test]
    async fn local_dictionary_and_rerun_need_local_mode() {
        let dir = tempfile::tempdir().unwrap();
        let state = state(&dir);
        state.db.add_term("Comma").unwrap();
        assert_eq!(state.db.terms().unwrap().len(), 1);
        state.db.insert_run(&db::RunRecord { id: "r".into(), mode: "dictate".into(), provider: "local".into(), raw_text: "hi".into(), ok: true, ..Default::default() }, None).unwrap();
        state.update_settings(&json!({ "mode": "account" })).unwrap();
        assert_eq!(run::rerun(&state, "r").await.unwrap_err().code, ErrorCode::Unsupported);
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
