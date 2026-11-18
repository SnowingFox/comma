//! One dictation run end to end (spec 2.1 to 2.3, 3.2): the context captured when the shortcut
//! goes down, speech to text and the rewrite (your keys, or the Comma server in account mode),
//! the output (paste with clipboard restore, copy, or an answer card), history and hints.
//!
//! Context is only what spec section 1 allows, and only for a run the user started: the focused
//! app's name, and for Ask Anything the selected text, each behind the Context setting.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use comma_input::{Action, Hint as KeyHint};
use comma_voice::pipeline::{self, Event, RefineContext, Stage};
use comma_voice::prompts::{Delivery, Mode};
use comma_voice::stt::{Audio, SttOptions, sanitize_keyterms};
use comma_voice::{CancellationToken, wav};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager};

use crate::account::{self, Server};
use crate::commands::AppState;
use crate::db::{self, RunRecord};
use crate::error::{AppError, AppResult, ErrorCode};
use crate::settings::AppMode;
use crate::shortcuts::{Shortcuts, Target, run_mode};
use crate::windows::WindowLabel;

/// ElevenLabs batch list price, as the server prices it (`STT_USD_PER_HOUR`); keyterms add 20%.
pub const STT_USD_PER_HOUR: f64 = 0.2;
const KEYTERMS_SURCHARGE: f64 = 1.2;
/// The server's `maxSelectedTextChars`.
const MAX_SELECTED_CHARS: usize = 20_000;
const MAX_AUDIO_BYTES: usize = 25 * 1024 * 1024;
const MIN_AUDIO_SECS: f64 = 0.3;
const MAX_AUDIO_SECS: f64 = 600.0;
/// Spec 3.2: restore the clipboard 400 ms after Cmd+V.
const RESTORE_AFTER: Duration = Duration::from_millis(400);
/// A run at the hands-free hint's threshold.
const LONG_DICTATION_SECS: f64 = 20.0;
const LONG_DICTATIONS_BEFORE_HINT: i64 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HintKind {
    AskHold,
    HandsFree,
    Copied,
    Microphone,
    InputMonitoring,
    Accessibility,
    MicrophoneDenied,
    SignedOut,
}

impl HintKind {
    pub fn as_str(self) -> &'static str {
        match self {
            HintKind::AskHold => "ask_hold",
            HintKind::HandsFree => "hands_free",
            HintKind::Copied => "copied",
            HintKind::Microphone => "microphone",
            HintKind::InputMonitoring => "input_monitoring",
            HintKind::Accessibility => "accessibility",
            HintKind::MicrophoneDenied => "microphone_denied",
            HintKind::SignedOut => "signed_out",
        }
    }

    /// Teaching hints show a few times, then never again (spec 2.3.1). Hints that point at a fix
    /// (a permission, signing in) are not counted: they show whenever the problem is there.
    pub fn limit(self) -> Option<u32> {
        match self {
            HintKind::AskHold | HintKind::Copied => Some(3),
            HintKind::HandsFree | HintKind::Microphone => Some(2),
            _ => None,
        }
    }
}

/// Whether `kind` may show; counts it when it may.
pub fn hint_take(state: &AppState, kind: HintKind) -> AppResult<bool> {
    let Some(limit) = kind.limit() else { return Ok(true) };
    let mut settings = state.settings_guard()?;
    if !settings.feedback.hints {
        return Ok(false);
    }
    let count = settings.hint_counts.get(kind.as_str()).copied().unwrap_or(0);
    if count >= limit {
        return Ok(false);
    }
    let mut next = settings.clone();
    next.hint_counts.insert(kind.as_str().to_owned(), count + 1);
    crate::settings::save(&state.settings_path, &next)?;
    *settings = next;
    Ok(true)
}

/// What a run may use from the app the user was in when the shortcut went down.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Captured {
    pub app: Option<String>,
    pub pid: Option<i32>,
    pub selected_text: Option<String>,
}

#[derive(Default)]
pub struct Session {
    /// Bumped at every shortcut start; the context belongs to one start.
    seq: u64,
    context: Option<(u64, Captured)>,
    pub cancel: Option<CancellationToken>,
    /// The app the last run's output went to, for the answer card's Insert.
    target_pid: Option<i32>,
    pub last_text: Option<String>,
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

fn ms(d: Duration) -> f64 {
    (d.as_secs_f64() * 10_000.0).round() / 10.0
}

fn emit_hint(app: &AppHandle, kind: HintKind) {
    let _ = app.emit_to(WindowLabel::Bar.as_str(), "bar://hint", json!({ "kind": kind }));
}

/// Shortcut actions from the dispatcher thread: capture context at start, cancel a run on Esc,
/// hints, and the volume duck.
pub fn on_action(app: &AppHandle, action: &Action, target: Target) {
    let state = app.state::<AppState>();
    match action {
        Action::Start(mode) => {
            crate::ducking::duck(&state);
            let seq = {
                let Ok(mut session) = state.session.lock() else { return };
                session.seq += 1;
                session.context = None;
                session.seq
            };
            if target == Target::Onboarding {
                return;
            }
            let _ = crate::windows::prepare_bar(app);
            let captured = capture(&state, run_mode(*mode));
            if let Ok(mut session) = state.session.lock()
                && session.seq == seq
            {
                session.context = Some((seq, captured));
            }
            start_hints(app, &state);
        }
        Action::Switch { mode, .. } if run_mode(*mode) == Mode::Ask && target == Target::Bar => {
            // Fn, then Space: the selection is read once Ask Anything is chosen.
            let selection = read_selection(&state);
            if let Ok(mut session) = state.session.lock()
                && let Some((_, ctx)) = session.context.as_mut()
                && ctx.selected_text.is_none()
            {
                ctx.selected_text = selection;
            }
        }
        Action::Stop(_) => crate::ducking::restore(&state),
        Action::Cancel(_) => {
            crate::ducking::restore(&state);
            if let Ok(session) = state.session.lock()
                && let Some(cancel) = &session.cancel
            {
                cancel.cancel();
            }
        }
        Action::Hint(KeyHint::AskHold) => {
            if hint_take(&state, HintKind::AskHold).unwrap_or(false) {
                emit_hint(app, HintKind::AskHold);
            }
        }
        Action::Switch { .. } => {}
    }
}

fn read_selection(state: &AppState) -> Option<String> {
    let level = state.snapshot().ok()?.context_level;
    if !level.selection() || !comma_input::context::accessibility_trusted() {
        return None;
    }
    let app = comma_input::context::frontmost_app()?;
    comma_input::context::selected_text(app.pid, MAX_SELECTED_CHARS)
}

fn capture(state: &AppState, mode: Mode) -> Captured {
    let level = state.snapshot().map(|s| s.context_level).unwrap_or_default();
    let front = comma_input::context::frontmost_app();
    let pid = front.as_ref().map(|f| f.pid);
    Captured {
        app: front.filter(|_| level.app()).map(|f| f.name).filter(|n| !n.is_empty()),
        pid,
        selected_text: if mode == Mode::Ask { read_selection(state) } else { None },
    }
}

/// Problems the user can fix, shown as the recording starts.
fn start_hints(app: &AppHandle, state: &AppState) {
    let Ok(s) = state.snapshot() else { return };
    if s.mode == AppMode::Account && state.secrets.get(crate::secrets::ACCOUNT_REFRESH).ok().flatten().is_none() {
        emit_hint(app, HintKind::SignedOut);
    } else if !comma_input::context::accessibility_trusted() {
        emit_hint(app, HintKind::Accessibility);
    } else if let Some(shortcuts) = app.try_state::<Shortcuts>()
        && !shortcuts.fn_running()
        && [&s.shortcuts.dictate, &s.shortcuts.ask, &s.shortcuts.translate].iter().any(|a| a.starts_with("Fn"))
    {
        emit_hint(app, HintKind::InputMonitoring);
    }
}

// ---- pipeline_run ---------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunSource {
    Bar,
    Onboarding,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunArgs {
    pub mode: Mode,
    pub audio_base64: String,
    pub source: RunSource,
    pub target_language: Option<String>,
    pub selected_text: Option<String>,
    pub record_ms: Option<f64>,
    /// Seconds of audio, needed for Ogg (a WAV says it in its header).
    pub audio_secs: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RunDelivery {
    Insert,
    Replace,
    Answer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RunOutput {
    Pasted,
    Copied,
    Answer,
    None,
}

impl RunOutput {
    fn as_str(self) -> &'static str {
        match self {
            RunOutput::Pasted => "pasted",
            RunOutput::Copied => "copied",
            RunOutput::Answer => "answer",
            RunOutput::None => "none",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct RunResult {
    pub id: String,
    pub mode: Mode,
    pub raw_text: String,
    pub refined_text: String,
    pub audio_secs: f64,
    pub stt_ms: f64,
    pub llm_ttft_ms: Option<f64>,
    pub llm_total_ms: f64,
    pub total_ms: f64,
    pub delivery: RunDelivery,
    pub output: RunOutput,
    pub hint: Option<HintKind>,
    pub app: Option<String>,
}

/// Provider-independent outcome of speech to text plus the rewrite.
#[derive(Debug, Clone, PartialEq)]
pub struct Outcome {
    pub raw_text: String,
    pub refined_text: String,
    pub delivery: RunDelivery,
    pub language: Option<String>,
    pub model: Option<String>,
    pub stt_ms: f64,
    pub llm_ttft_ms: Option<f64>,
    pub llm_total_ms: f64,
    pub prompt_tokens: Option<i64>,
    pub completion_tokens: Option<i64>,
    pub stt_cost_usd: f64,
    pub audio_secs: f64,
}

/// The decoded upload.
#[derive(Debug, Clone)]
pub struct Clip {
    pub bytes: Vec<u8>,
    pub mime: &'static str,
    pub ext: &'static str,
    pub secs: f64,
}

/// Checks the upload: WAV (duration from its header) or Ogg/Opus (duration from the window).
pub fn decode_clip(b64: &str, audio_secs: Option<f64>) -> AppResult<Clip> {
    if b64.len() > MAX_AUDIO_BYTES / 3 * 4 + 4 {
        return Err(AppError::invalid("The recording is too long"));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .map_err(|_| AppError::invalid("The recording is not valid base64"))?;
    let (mime, ext, secs) = if bytes.starts_with(b"RIFF") {
        let secs = wav::duration_secs(&bytes).ok_or_else(|| AppError::invalid("The recording is not a WAV file Comma can read"))?;
        ("audio/wav", "wav", secs)
    } else if bytes.starts_with(b"OggS") {
        let secs = audio_secs.filter(|s| s.is_finite() && *s >= 0.0).ok_or_else(|| AppError::invalid("Send the length of an Ogg recording"))?;
        ("audio/ogg", "ogg", secs)
    } else {
        return Err(AppError::invalid("The recording must be WAV or Ogg/Opus"));
    };
    if secs < MIN_AUDIO_SECS {
        return Err(AppError::new(ErrorCode::NoSpeech, "Didn't catch that"));
    }
    if secs > MAX_AUDIO_SECS {
        return Err(AppError::invalid("That recording is longer than 10 minutes"));
    }
    Ok(Clip { bytes, mime, ext, secs })
}

/// Ask Anything replaces the selection only when the model answered inline and there was one.
pub fn local_delivery(mode: Mode, delivery: Option<Delivery>, has_selection: bool) -> RunDelivery {
    match mode {
        Mode::Ask if delivery == Some(Delivery::Inline) && has_selection => RunDelivery::Replace,
        Mode::Ask => RunDelivery::Answer,
        _ => RunDelivery::Insert,
    }
}

pub fn server_delivery(mode: Mode, delivery: &str) -> RunDelivery {
    match (mode, delivery) {
        (Mode::Ask, "replace") => RunDelivery::Replace,
        (Mode::Ask, _) | (_, "answer") => RunDelivery::Answer,
        _ => RunDelivery::Insert,
    }
}

pub fn stt_cost(secs: f64, attempts: usize, keyterms: bool) -> f64 {
    secs / 3600.0 * STT_USD_PER_HOUR * attempts.max(1) as f64 * if keyterms { KEYTERMS_SURCHARGE } else { 1.0 }
}

/// Time for the server to answer: grows with the clip (and its selection), like the upload.
pub fn server_timeout(secs: f64, selected_chars: usize) -> Duration {
    let ms = 40_000.0 + (secs / 30.0).ceil() * 5_000.0 + (selected_chars as f64 / 1000.0).ceil() * 500.0;
    Duration::from_millis(ms.min(180_000.0) as u64)
}

/// Waits briefly for the context the shortcut start is still reading (Accessibility can be slow).
async fn take_context(state: &AppState) -> Captured {
    let deadline = Instant::now() + Duration::from_millis(800);
    loop {
        if let Ok(session) = state.session.lock() {
            if let Some((seq, ctx)) = &session.context
                && *seq == session.seq
            {
                return ctx.clone();
            }
            if session.seq == 0 {
                return Captured::default();
            }
        }
        if Instant::now() >= deadline {
            return Captured::default();
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Clears the busy flag and the cancel token however the run ends.
struct RunGuard<'a> {
    state: &'a AppState,
    shortcuts: Option<Shortcuts>,
}

impl Drop for RunGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut session) = self.state.session.lock() {
            session.cancel = None;
        }
        if let Some(s) = &self.shortcuts {
            s.set_busy(false);
        }
    }
}

pub async fn pipeline_run(app: &AppHandle, state: &AppState, args: RunArgs) -> AppResult<RunResult> {
    let started = Instant::now();
    let id = uuid::Uuid::new_v4().to_string();
    let source_label = match args.source {
        RunSource::Bar => WindowLabel::Bar.as_str(),
        RunSource::Onboarding => WindowLabel::Onboarding.as_str(),
    };
    let cancel = CancellationToken::new();
    let shortcuts = app.try_state::<Shortcuts>().map(|s| s.inner().clone());
    if let Some(s) = &shortcuts {
        s.set_busy(true);
    }
    if let Ok(mut session) = state.session.lock() {
        session.cancel = Some(cancel.clone());
    }
    let _guard = RunGuard { state, shortcuts };

    let result = run_inner(app, state, &args, &id, source_label, cancel, started).await;
    match &result {
        Ok(done) => {
            let _ = app.emit("run://done", json!({ "id": id, "result": done }));
        }
        Err(e) => {
            let _ = app.emit("run://error", json!({ "id": id, "code": e.code, "message": e.message, "reason": e.reason }));
        }
    }
    let _ = app.emit("history://changed", json!({ "id": id }));
    result
}

async fn run_inner(
    app: &AppHandle,
    state: &AppState,
    args: &RunArgs,
    id: &str,
    source_label: &'static str,
    cancel: CancellationToken,
    started: Instant,
) -> AppResult<RunResult> {
    let clip = decode_clip(&args.audio_base64, args.audio_secs)?;
    let settings = state.snapshot()?;
    let ctx = match args.source {
        RunSource::Bar => take_context(state).await,
        RunSource::Onboarding => Captured {
            app: Some("Comma setup".into()),
            pid: None,
            selected_text: args.selected_text.clone().filter(|t| !t.trim().is_empty()),
        },
    };
    let target = args
        .target_language
        .clone()
        .filter(|t| !t.trim().is_empty())
        .or_else(|| settings.languages.translate_targets.first().cloned());
    let provider = if settings.mode == AppMode::Account { "comma" } else { "local" };

    let emit_stage = |stage: &str, elapsed: f64| {
        let _ = app.emit_to(source_label, "run://stage", json!({ "id": id, "stage": stage, "ms": elapsed }));
    };
    let outcome = if settings.mode == AppMode::Account {
        run_account(state, &clip, args, &ctx, target.as_deref()).await
    } else {
        run_local(app, state, &clip, args.mode, &ctx, target, id, source_label, cancel.clone()).await
    };
    let keep = settings.privacy.keep_audio.then_some((clip.bytes.as_slice(), clip.ext));
    let outcome = match outcome {
        Ok(o) => o,
        Err(e) => {
            if !matches!(e.code, ErrorCode::NoSpeech | ErrorCode::Cancelled) {
                let record = RunRecord {
                    id: id.to_owned(),
                    ts: now_ms(),
                    mode: mode_str(args.mode).into(),
                    provider: provider.into(),
                    app: ctx.app.clone(),
                    audio_secs: clip.secs,
                    total_ms: Some(ms(started.elapsed())),
                    ok: false,
                    error: Some(e.message.clone()),
                    ..Default::default()
                };
                state.db.insert_run(&record, keep)?;
            }
            return Err(e);
        }
    };
    if cancel.is_cancelled() {
        return Err(AppError::new(ErrorCode::Cancelled, "Cancelled"));
    }
    if outcome.refined_text.trim().is_empty() {
        return Err(AppError::new(ErrorCode::NoSpeech, "Didn't catch that"));
    }

    // Output.
    let paste_started = Instant::now();
    let output = match (args.source, outcome.delivery) {
        (RunSource::Onboarding, _) => RunOutput::None,
        (_, RunDelivery::Answer) => RunOutput::Answer,
        (RunSource::Bar, _) => insert(state, &outcome.refined_text, ctx.pid).await,
    };
    if output != RunOutput::None {
        emit_stage("paste", ms(paste_started.elapsed()));
    }
    if let Ok(mut session) = state.session.lock() {
        session.target_pid = ctx.pid;
        session.last_text = Some(outcome.refined_text.clone());
    }

    let total_ms = ms(started.elapsed());
    let record = RunRecord {
        id: id.to_owned(),
        ts: now_ms(),
        mode: mode_str(args.mode).into(),
        provider: provider.into(),
        app: ctx.app.clone(),
        raw_text: outcome.raw_text.clone(),
        refined_text: outcome.refined_text.clone(),
        language: outcome.language.clone(),
        model: outcome.model.clone(),
        audio_secs: outcome.audio_secs,
        stt_ms: Some(outcome.stt_ms),
        llm_ttft_ms: outcome.llm_ttft_ms,
        llm_total_ms: Some(outcome.llm_total_ms),
        total_ms: Some(total_ms),
        prompt_tokens: outcome.prompt_tokens,
        completion_tokens: outcome.completion_tokens,
        stt_cost_usd: Some(outcome.stt_cost_usd),
        words: db::count_words(&outcome.refined_text),
        ok: true,
        error: None,
        output: Some(output.as_str().into()),
        ..Default::default()
    };
    state.db.insert_run(&record, keep)?;
    let _ = state.db.prune(settings.privacy.history_days, now_ms());

    let hint = if output == RunOutput::Copied && hint_take(state, HintKind::Copied)? {
        Some(HintKind::Copied)
    } else if args.mode == Mode::Dictate
        && args.source == RunSource::Bar
        && outcome.audio_secs >= LONG_DICTATION_SECS
        && state.db.long_dictations(LONG_DICTATION_SECS)? >= LONG_DICTATIONS_BEFORE_HINT
        && hint_take(state, HintKind::HandsFree)?
    {
        Some(HintKind::HandsFree)
    } else {
        None
    };

    Ok(RunResult {
        id: id.to_owned(),
        mode: args.mode,
        raw_text: outcome.raw_text,
        refined_text: outcome.refined_text,
        audio_secs: outcome.audio_secs,
        stt_ms: outcome.stt_ms,
        llm_ttft_ms: outcome.llm_ttft_ms,
        llm_total_ms: outcome.llm_total_ms,
        total_ms,
        delivery: outcome.delivery,
        output,
        hint,
        app: ctx.app,
    })
}

fn mode_str(mode: Mode) -> &'static str {
    match mode {
        Mode::Dictate => "dictate",
        Mode::Ask => "ask",
        Mode::Translate => "translate",
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_local(
    app: &AppHandle,
    state: &AppState,
    clip: &Clip,
    mode: Mode,
    ctx: &Captured,
    target: Option<String>,
    id: &str,
    source_label: &str,
    cancel: CancellationToken,
) -> AppResult<Outcome> {
    let s = state.snapshot()?;
    if s.llm.model.is_empty() {
        return Err(AppError::new(ErrorCode::NotConfigured, "Pick an LLM model in Settings first"));
    }
    let stt = state.elevenlabs()?;
    let endpoint = state.llm_endpoint(None)?;
    let terms: Vec<String> = state.db.terms()?.into_iter().map(|t| t.term).collect();
    let keyterms = !sanitize_keyterms(&terms).is_empty();
    let opts = SttOptions { languages: s.languages.spoken.clone(), auto_detect: s.languages.auto_detect, keyterms: terms.clone(), cancel: None };
    let mut rc = RefineContext::new(mode, s.llm.model.clone());
    rc.reasoning_effort = s.llm.reasoning_effort;
    rc.languages = s.languages.spoken.clone();
    rc.target_language = target;
    rc.dictionary = terms;
    rc.app = ctx.app.clone();
    rc.selected_text = ctx.selected_text.clone();
    rc.timeout = Duration::from_secs(60);
    let audio = Audio { bytes: clip.bytes.clone(), mime: clip.mime.into() };

    let delta_target = source_label.to_owned();
    let run = pipeline::run(&stt, &endpoint, audio, &opts, &rc, cancel, |event| match event {
        Event::Stage { stage, elapsed } => {
            let stage = if stage == Stage::Stt { "stt" } else { "llm" };
            let _ = app.emit_to(delta_target.as_str(), "run://stage", json!({ "id": id, "stage": stage, "ms": ms(elapsed) }));
        }
        Event::Delta(text) => {
            let _ = app.emit_to(delta_target.as_str(), "run://delta", json!({ "id": id, "text": text }));
        }
    })
    .await?;
    let secs = run.transcript.duration.map_or(clip.secs, |d| d.as_secs_f64());
    Ok(Outcome {
        delivery: local_delivery(mode, run.refined.delivery, ctx.selected_text.is_some()),
        raw_text: run.transcript.text.clone(),
        refined_text: run.refined.text.trim().to_owned(),
        language: comma_voice::stt::to_iso1(&run.transcript.language).or(Some(run.transcript.language.clone())).filter(|l| !l.is_empty()),
        model: Some(run.refined.model.clone()),
        stt_ms: ms(run.transcript.timing),
        llm_ttft_ms: run.refined.ttft.map(ms),
        llm_total_ms: ms(run.refined.total),
        prompt_tokens: run.refined.usage.prompt_tokens.map(|t| t as i64),
        completion_tokens: run.refined.usage.completion_tokens.map(|t| t as i64),
        stt_cost_usd: stt_cost(secs, run.transcript.attempts.len(), keyterms),
        audio_secs: secs,
    })
}

async fn run_account(state: &AppState, clip: &Clip, args: &RunArgs, ctx: &Captured, target: Option<&str>) -> AppResult<Outcome> {
    let mut meta = json!({ "mode": mode_str(args.mode) });
    if args.mode == Mode::Translate
        && let Some(t) = target
    {
        meta["target_language"] = json!(t);
    }
    if let Some(app) = &ctx.app {
        meta["app_name"] = json!(app.chars().take(200).collect::<String>());
    }
    let selected_chars = ctx.selected_text.as_ref().map_or(0, |t| t.chars().count());
    if args.mode == Mode::Ask
        && let Some(sel) = &ctx.selected_text
    {
        meta["selected_text"] = json!(sel.chars().take(MAX_SELECTED_CHARS).collect::<String>());
    }
    if let Some(record) = args.record_ms {
        meta["client_timings"] = json!({ "record_ms": record.round() });
    }
    let timeout = server_timeout(clip.secs, selected_chars);
    let run = with_access(state, |token| {
        let url = state.server_url();
        let meta = meta.clone();
        let bytes = clip.bytes.clone();
        let mime = clip.mime;
        let ext = clip.ext;
        async move {
            let url = url?;
            Server { http: &state.http, base_url: &url }.voice_run_with(&token, bytes, mime, ext, &meta, timeout).await
        }
    })
    .await?;
    Ok(Outcome {
        delivery: server_delivery(args.mode, &run.delivery),
        raw_text: run.raw_text,
        refined_text: run.refined_text.trim().to_owned(),
        language: Some(run.detected_language).filter(|l| !l.is_empty()),
        model: Some("Comma".into()),
        stt_ms: run.timings.stt_ms,
        llm_ttft_ms: Some(run.timings.llm_ttft_ms),
        llm_total_ms: run.timings.llm_total_ms,
        prompt_tokens: Some(run.usage.prompt_tokens),
        completion_tokens: Some(run.usage.completion_tokens),
        stt_cost_usd: run.usage.stt_cost_usd,
        audio_secs: run.usage.audio_seconds,
    })
}

// ---- account session ------------------------------------------------------------------------------

fn signed_out() -> AppError {
    AppError::new(ErrorCode::NotConfigured, "You're signed out of Comma. Sign in again in Settings").with_reason("signed_out")
}

/// A valid access token, refreshed when it is about to expire or `force`d after a 401. Refreshes
/// never overlap (the server signs a device out when a refresh token is reused).
pub async fn access_token(state: &AppState, force: bool) -> AppResult<String> {
    let _lock = state.refresh_lock.lock().await;
    let s = state.snapshot()?.account;
    let Some(refresh) = state.secrets.get(crate::secrets::ACCOUNT_REFRESH)? else { return Err(signed_out()) };
    if !force
        && s.access_expires_at > crate::commands::now_secs() + 30
        && let Some(access) = state.secrets.get(crate::secrets::ACCOUNT_ACCESS)?
    {
        return Ok(access);
    }
    match (Server { http: &state.http, base_url: &s.server_url }).refresh(&refresh).await {
        Ok(tokens) => {
            crate::commands::store_session(state, &tokens)?;
            Ok(tokens.access_token)
        }
        Err(e) if e.code == ErrorCode::Server && e.reason.as_deref().is_some_and(|r| r.contains("refresh_token") || r == "unauthorized") => {
            crate::commands::clear_session(state)?;
            Err(signed_out())
        }
        Err(e) => Err(e),
    }
}

/// Calls `f` with an access token; on a 401 refreshes once and retries.
pub async fn with_access<T, F, Fut>(state: &AppState, f: F) -> AppResult<T>
where
    F: Fn(String) -> Fut,
    Fut: std::future::Future<Output = AppResult<T>>,
{
    let token = access_token(state, false).await?;
    match f(token).await {
        Err(e) if account::is_unauthorized(&e) => f(access_token(state, true).await?).await,
        other => other,
    }
}

// ---- output -------------------------------------------------------------------------------------

/// Pastes at the cursor of the app the run started in, or copies when Comma can't paste there.
pub async fn insert(state: &AppState, text: &str, pid: Option<i32>) -> RunOutput {
    use comma_input::context::{self, Editable};
    let text = text.to_owned();
    let can_paste = context::accessibility_trusted() && pid.is_none_or(|p| context::focused_editable(p) != Editable::No);
    let paste_lock = state.paste_lock.clone();
    tokio::task::spawn_blocking(move || {
        let _one_at_a_time = paste_lock.lock();
        output_blocking(&text, can_paste, pid)
    })
    .await
    .unwrap_or(RunOutput::Copied)
}

#[cfg(target_os = "macos")]
fn output_blocking(text: &str, can_paste: bool, pid: Option<i32>) -> RunOutput {
    use comma_input::paste::{MacKeys, MacPasteboard, copy_text, paste_and_restore};
    let pb = MacPasteboard;
    if !can_paste {
        copy_text(&pb, text);
        return RunOutput::Copied;
    }
    // Clicking the bar can activate Comma; give the keystroke back to the app the run started in.
    if let Some(pid) = pid
        && comma_input::context::frontmost_app().is_some_and(|f| f.pid != pid)
    {
        comma_input::context::activate(pid);
        std::thread::sleep(Duration::from_millis(120));
    }
    match paste_and_restore(&pb, &MacKeys, text, RESTORE_AFTER, std::thread::sleep) {
        Ok(_) => RunOutput::Pasted,
        Err(e) => {
            eprintln!("comma: paste failed ({e}); copied instead");
            copy_text(&pb, text);
            RunOutput::Copied
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn output_blocking(_text: &str, _can_paste: bool, _pid: Option<i32>) -> RunOutput {
    RunOutput::Copied
}

/// The answer card's Insert: paste into the app the run came from.
pub async fn insert_answer(state: &AppState, text: &str) -> RunOutput {
    let pid = state.session.lock().ok().and_then(|s| s.target_pid);
    insert(state, text, pid).await
}

pub fn copy(text: &str) {
    #[cfg(target_os = "macos")]
    comma_input::paste::copy_text(&comma_input::paste::MacPasteboard, text);
    #[cfg(not(target_os = "macos"))]
    let _ = text;
}

/// Shared by every paste so two never interleave their clipboard save and restore.
pub type PasteLock = Arc<Mutex<()>>;

/// Re-runs only the rewrite of a stored run with the current LLM settings (Local mode).
pub async fn rerun(state: &AppState, id: &str) -> AppResult<RunRecord> {
    let s = state.snapshot()?;
    if s.mode == AppMode::Account {
        return Err(AppError::new(ErrorCode::Unsupported, "Rerunning the rewrite works with your own keys only"));
    }
    let run = state.db.get_run(id)?;
    if run.raw_text.trim().is_empty() {
        return Err(AppError::invalid("This run has no transcript to rewrite"));
    }
    let mode: Mode = serde_json::from_value(Value::String(run.mode.clone())).map_err(|_| AppError::internal("unknown mode in history"))?;
    if s.llm.model.is_empty() {
        return Err(AppError::new(ErrorCode::NotConfigured, "Pick an LLM model in Settings first"));
    }
    let endpoint = state.llm_endpoint(None)?;
    let mut rc = RefineContext::new(mode, s.llm.model.clone());
    rc.reasoning_effort = s.llm.reasoning_effort;
    rc.languages = s.languages.spoken.clone();
    rc.target_language = s.languages.translate_targets.first().cloned();
    rc.dictionary = state.db.terms()?.into_iter().map(|t| t.term).collect();
    rc.app = run.app.clone();
    let out = pipeline::refine(&endpoint, &run.raw_text, &rc, CancellationToken::new(), |_| {}).await?;
    state.db.update_rewrite(
        id,
        out.text.trim(),
        &out.model,
        out.ttft.map(ms),
        ms(out.total),
        (out.usage.prompt_tokens.map(|t| t as i64), out.usage.completion_tokens.map(|t| t as i64)),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delivery_rules() {
        assert_eq!(local_delivery(Mode::Dictate, None, true), RunDelivery::Insert);
        assert_eq!(local_delivery(Mode::Ask, Some(Delivery::Inline), true), RunDelivery::Replace);
        assert_eq!(local_delivery(Mode::Ask, Some(Delivery::Inline), false), RunDelivery::Answer, "nothing to replace");
        assert_eq!(local_delivery(Mode::Ask, Some(Delivery::External), true), RunDelivery::Answer);
        assert_eq!(server_delivery(Mode::Ask, "replace"), RunDelivery::Replace);
        assert_eq!(server_delivery(Mode::Ask, "insert"), RunDelivery::Answer);
        assert_eq!(server_delivery(Mode::Translate, "insert"), RunDelivery::Insert);
    }

    #[test]
    fn clip_checks() {
        let b64 = |b: &[u8]| base64::engine::general_purpose::STANDARD.encode(b);
        let one_sec = b64(&wav::test_clip());
        let clip = decode_clip(&one_sec, None).unwrap();
        assert_eq!((clip.mime, clip.ext, clip.secs), ("audio/wav", "wav", 1.0));
        let short = b64(&wav::encode_wav(&[0; 1600], 16_000));
        assert_eq!(decode_clip(&short, None).unwrap_err().code, ErrorCode::NoSpeech);
        let ogg = b64(b"OggS\0\x02rest");
        assert!(decode_clip(&ogg, None).is_err(), "Ogg needs its length");
        assert_eq!(decode_clip(&ogg, Some(2.0)).unwrap().mime, "audio/ogg");
        assert!(decode_clip(&b64(b"ID3"), None).is_err());
        assert!(decode_clip(&ogg, Some(601.0)).is_err());
    }

    #[test]
    fn cost_and_timeout() {
        assert!((stt_cost(3600.0, 1, false) - 0.2).abs() < 1e-12);
        assert!((stt_cost(1800.0, 2, true) - 0.24).abs() < 1e-12);
        assert_eq!(server_timeout(5.0, 0), Duration::from_secs(45));
        assert_eq!(server_timeout(95.0, 2500), Duration::from_millis(61_500));
        assert_eq!(server_timeout(600.0, 0), Duration::from_secs(140));
    }

    #[test]
    fn hint_limits() {
        assert_eq!(HintKind::AskHold.limit(), Some(3));
        assert_eq!(HintKind::InputMonitoring.limit(), None);
        assert_eq!(serde_json::to_value(HintKind::HandsFree).unwrap(), "hands_free");
    }
}
