//! The shortcuts (spec 3.2): Fn-based ones through the listen-only Fn tap in `comma-input` (needs
//! Input Monitoring), ordinary ones and the fallbacks through `tauri-plugin-global-shortcut`.
//!
//! Both sources become `comma_input::Input`s that one dispatcher thread feeds to the state
//! machine; its actions become `shortcut://*` events for the bar (or the onboarding window while
//! it captures them) and the context capture for the run. Esc is listened for only while a
//! recording, a run or an answer card is open.

use std::collections::BTreeSet;
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use comma_input::{Action, FnBinding, FnBindings, FnTap, Hint, Input, Machine, MatcherOutput, Mode as KeyMode};
use comma_voice::prompts::Mode;
use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};

use crate::error::{AppError, AppResult};
use crate::settings::ShortcutSettings;
use crate::windows::WindowLabel;

const MODES: [Mode; 3] = [Mode::Dictate, Mode::Ask, Mode::Translate];
const PERMISSION_POLL: Duration = Duration::from_secs(2);
const ESCAPE: &str = "Escape";

pub fn key_mode(mode: Mode) -> KeyMode {
    match mode {
        Mode::Dictate => KeyMode::Dictate,
        Mode::Ask => KeyMode::Ask,
        Mode::Translate => KeyMode::Translate,
    }
}

pub fn run_mode(mode: KeyMode) -> Mode {
    match mode {
        KeyMode::Dictate => Mode::Dictate,
        KeyMode::Ask => Mode::Ask,
        KeyMode::Translate => Mode::Translate,
    }
}

/// Settings validation: an Fn shortcut `comma-input` understands, or an accelerator the plugin
/// can register (at least one modifier, so a bare letter never becomes global).
pub fn validate(accel: &str) -> AppResult<()> {
    match comma_input::parse_fn(accel) {
        Ok(Some(_)) => Ok(()),
        Err(message) => Err(AppError::invalid(message)),
        Ok(None) => {
            let shortcut = Shortcut::from_str(accel).map_err(|_| AppError::invalid(format!("{accel} is not a shortcut Comma knows")))?;
            if shortcut.mods.is_empty() {
                return Err(AppError::invalid("Use at least one of Control, Option, Shift or Command, or Fn"));
            }
            Ok(())
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Listener {
    Fn,
    Fallback,
}

#[derive(Debug, Clone, Serialize)]
pub struct ActiveShortcuts {
    pub dictate: String,
    pub ask: String,
    pub translate: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ShortcutError {
    pub mode: Mode,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ShortcutsStatus {
    pub listener: Listener,
    pub active: ActiveShortcuts,
    pub errors: Vec<ShortcutError>,
    /// System Settings > Keyboard > "Press Globe key to": a listen-only tap cannot stop it.
    pub globe_key: GlobeKey,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GlobeKey {
    None,
    InputSource,
    Emoji,
    Dictation,
    Unknown,
}

/// Reads `AppleFnUsageType` (0 do nothing, 1 change input source, 2 emoji, 3 dictation).
pub fn globe_key() -> GlobeKey {
    let out = std::process::Command::new("/usr/bin/defaults").args(["read", "com.apple.HIToolbox", "AppleFnUsageType"]).output();
    match out.ok().filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned()).as_deref() {
        Some("0") => GlobeKey::None,
        Some("1") => GlobeKey::InputSource,
        Some("2") => GlobeKey::Emoji,
        Some("3") => GlobeKey::Dictation,
        _ => GlobeKey::Unknown,
    }
}

/// Which accelerator each mode uses given whether the Fn tap can run. Pure, for tests.
pub fn plan(configured: &ShortcutSettings, fn_available: bool) -> (FnBindings, Vec<(Mode, String)>) {
    let fallback = ShortcutSettings::fallback();
    let mut fn_bindings = FnBindings::default();
    let mut plugin = Vec::new();
    let taken: BTreeSet<&str> = MODES.iter().map(|&m| configured.get(m)).collect();
    for mode in MODES {
        let accel = configured.get(mode);
        match comma_input::parse_fn(accel) {
            Ok(Some(binding)) if fn_available => set_binding(&mut fn_bindings, mode, binding),
            Ok(Some(_)) => {
                let alt = fallback.get(mode);
                if !taken.contains(alt) {
                    plugin.push((mode, alt.to_owned()));
                }
            }
            Ok(None) => plugin.push((mode, accel.to_owned())),
            Err(_) => {}
        }
    }
    (fn_bindings, plugin)
}

fn set_binding(b: &mut FnBindings, mode: Mode, binding: FnBinding) {
    match mode {
        Mode::Dictate => b.dictate = Some(binding),
        Mode::Ask => b.ask = Some(binding),
        Mode::Translate => b.translate = Some(binding),
    }
}

enum Msg {
    Inputs(Vec<Input>),
    Held(Vec<&'static str>),
    Busy(bool),
    CardOpen(bool),
}

struct Registration {
    tap: Option<FnTap>,
    /// Plugin shortcuts and the mode each starts.
    plugin: Vec<(Shortcut, Mode)>,
    escape_registered: bool,
    status: ShortcutsStatus,
    configured: ShortcutSettings,
}

/// Managed state. Cheap to clone.
#[derive(Clone)]
pub struct Shortcuts {
    tx: mpsc::Sender<Msg>,
    reg: Arc<Mutex<Registration>>,
    capture: Arc<Mutex<Option<WindowLabel>>>,
    probe: Arc<AtomicBool>,
}

/// Called with each action after its event is emitted, on the dispatcher thread.
pub type ActionHook = Arc<dyn Fn(&AppHandle, &Action, Target) + Send + Sync>;

/// Where an action's events went.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    Bar,
    Onboarding,
}

impl Shortcuts {
    /// `probe`: try the Fn tap even when the permission preflight says no (it can be wrong, and
    /// the first try adds Comma to the Input Monitoring list). Off until onboarding explained it.
    pub fn start(app: &AppHandle, configured: ShortcutSettings, probe: bool, hook: ActionHook) -> Self {
        let (tx, rx) = mpsc::channel();
        let reg = Arc::new(Mutex::new(Registration {
            tap: None,
            plugin: Vec::new(),
            escape_registered: false,
            status: ShortcutsStatus {
                listener: Listener::Fallback,
                active: ActiveShortcuts { dictate: String::new(), ask: String::new(), translate: String::new() },
                errors: Vec::new(),
                globe_key: GlobeKey::Unknown,
            },
            configured: configured.clone(),
        }));
        let me = Self { tx, reg, capture: Arc::new(Mutex::new(None)), probe: Arc::new(AtomicBool::new(probe)) };
        me.reconfigure(app, &configured);

        let dispatcher = me.clone();
        let handle = app.clone();
        std::thread::Builder::new()
            .name("comma-shortcuts".into())
            .spawn(move || dispatcher.dispatch(&handle, rx, hook))
            .expect("spawn the shortcut dispatcher");

        // Input Monitoring can be granted (or revoked) while Comma runs.
        let poller = me.clone();
        let handle = app.clone();
        std::thread::Builder::new()
            .name("comma-input-monitoring".into())
            .spawn(move || {
                let mut last = poller.status().map(|s| s.listener).ok();
                loop {
                    std::thread::sleep(PERMISSION_POLL);
                    let waiting = poller.reg.lock().map(|r| r.status.listener == Listener::Fallback).unwrap_or(false);
                    if waiting && (comma_input::input_monitoring_granted() || poller.probe.load(Ordering::Relaxed)) {
                        let configured = poller.reg.lock().map(|r| r.configured.clone()).ok();
                        if let Some(configured) = configured {
                            poller.reconfigure(&handle, &configured);
                        }
                    }
                    let now = poller.status().map(|s| s.listener).ok();
                    if now != last {
                        last = now;
                        let _ = handle.emit("settings://changed", json!({}));
                    }
                }
            })
            .expect("spawn the permission poller");
        me
    }

    pub fn status(&self) -> AppResult<ShortcutsStatus> {
        Ok(self.reg.lock().map_err(|_| AppError::internal("shortcut lock poisoned"))?.status.clone())
    }

    /// After the user asked for Input Monitoring: keep trying the tap.
    pub fn enable_probe(&self) {
        self.probe.store(true, Ordering::Relaxed);
    }

    /// Whether the Fn tap runs, the best answer to "is Input Monitoring allowed".
    pub fn fn_running(&self) -> bool {
        self.reg.lock().map(|r| r.tap.is_some()).unwrap_or(false)
    }

    pub fn set_busy(&self, busy: bool) {
        let _ = self.tx.send(Msg::Busy(busy));
    }

    pub fn set_card_open(&self, open: bool) {
        let _ = self.tx.send(Msg::CardOpen(open));
    }

    pub fn set_capture(&self, owner: Option<WindowLabel>) {
        if let Ok(mut c) = self.capture.lock() {
            *c = owner;
        }
    }

    /// From the global-shortcut plugin's handler.
    pub fn on_plugin_event(&self, shortcut: &Shortcut, event: ShortcutEvent) {
        let Ok(reg) = self.reg.lock() else { return };
        if reg.escape_registered && *shortcut == escape_shortcut() {
            if event.state == ShortcutState::Pressed {
                let _ = self.tx.send(Msg::Inputs(vec![Input::Escape]));
            }
            return;
        }
        let Some(&(_, mode)) = reg.plugin.iter().find(|(s, _)| s == shortcut) else { return };
        let input = match event.state {
            ShortcutState::Pressed => Input::Down(key_mode(mode)),
            ShortcutState::Released => Input::Up(key_mode(mode)),
        };
        let _ = self.tx.send(Msg::Inputs(vec![input]));
    }

    /// Applies `configured`: starts or stops the Fn tap, and registers the ordinary shortcuts.
    pub fn reconfigure(&self, app: &AppHandle, configured: &ShortcutSettings) {
        let granted = comma_input::input_monitoring_granted() || self.probe.load(Ordering::Relaxed);
        let any_fn = MODES.iter().any(|&m| matches!(comma_input::parse_fn(configured.get(m)), Ok(Some(_))));
        let Ok(mut reg) = self.reg.lock() else { return };
        reg.configured = configured.clone();

        // The tap runs only when an Fn shortcut is configured and the permission is there.
        let mut fn_running = false;
        if any_fn && granted {
            let (bindings, _) = plan(configured, true);
            if let Some(tap) = &reg.tap {
                tap.set_bindings(bindings);
                fn_running = true;
            } else {
                let tx = self.tx.clone();
                match FnTap::start(bindings, move |out: MatcherOutput| {
                    if !out.inputs.is_empty() {
                        let _ = tx.send(Msg::Inputs(out.inputs));
                    }
                    if let Some(held) = out.held {
                        let _ = tx.send(Msg::Held(held));
                    }
                }) {
                    Ok(tap) => {
                        reg.tap = Some(tap);
                        fn_running = true;
                    }
                    Err(e) => eprintln!("comma: Fn listener not started: {e}"),
                }
            }
        } else if let Some(tap) = reg.tap.take() {
            tap.stop();
        }

        let (_, plugin) = plan(configured, fn_running);
        let gs = app.global_shortcut();
        for (shortcut, _) in reg.plugin.drain(..) {
            let _ = gs.unregister(shortcut);
        }
        let mut errors = Vec::new();
        for (mode, accel) in &plugin {
            match Shortcut::from_str(accel) {
                Ok(shortcut) => match gs.register(shortcut) {
                    Ok(()) => reg.plugin.push((shortcut, *mode)),
                    Err(e) => errors.push(ShortcutError { mode: *mode, message: format!("{accel} could not be registered. Another app may use it ({e})") }),
                },
                Err(_) => errors.push(ShortcutError { mode: *mode, message: format!("{accel} is not a valid shortcut") }),
            }
        }
        let active_for = |mode: Mode| -> String {
            let accel = configured.get(mode);
            if fn_running || !matches!(comma_input::parse_fn(accel), Ok(Some(_))) {
                accel.to_owned()
            } else {
                plugin.iter().find(|(m, _)| *m == mode).map(|(_, a)| a.clone()).unwrap_or_default()
            }
        };
        reg.status = ShortcutsStatus {
            listener: if fn_running || !any_fn { Listener::Fn } else { Listener::Fallback },
            active: ActiveShortcuts { dictate: active_for(Mode::Dictate), ask: active_for(Mode::Ask), translate: active_for(Mode::Translate) },
            errors,
            globe_key: if any_fn { globe_key() } else { GlobeKey::None },
        };
        if !any_fn {
            // Nothing needs the tap; report it as fine.
            reg.status.listener = Listener::Fn;
        }
    }

    fn target(&self, app: &AppHandle) -> Target {
        let owner = self.capture.lock().ok().and_then(|c| *c);
        match owner {
            Some(WindowLabel::Onboarding)
                if app.get_webview_window(WindowLabel::Onboarding.as_str()).is_some_and(|w| w.is_focused().unwrap_or(false)) =>
            {
                Target::Onboarding
            }
            _ => Target::Bar,
        }
    }

    fn set_escape(&self, app: &AppHandle, on: bool) {
        let Ok(mut reg) = self.reg.lock() else { return };
        if let Some(tap) = &reg.tap {
            tap.set_listen_escape(on);
            return;
        }
        if on != reg.escape_registered {
            let gs = app.global_shortcut();
            let ok = if on { gs.register(escape_shortcut()).is_ok() } else { gs.unregister(escape_shortcut()).is_ok() };
            if ok || !on {
                reg.escape_registered = on;
            }
        }
    }

    fn dispatch(&self, app: &AppHandle, rx: mpsc::Receiver<Msg>, hook: ActionHook) {
        let mut machine = Machine::new(comma_input::Config::default());
        let mut busy = false;
        let mut card = false;
        let mut escape = false;
        loop {
            let msg = match machine.deadline() {
                Some(deadline) => match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                    Ok(msg) => Some(msg),
                    Err(RecvTimeoutError::Timeout) => None,
                    Err(RecvTimeoutError::Disconnected) => return,
                },
                None => match rx.recv() {
                    Ok(msg) => Some(msg),
                    Err(_) => return,
                },
            };
            let now = Instant::now();
            let actions = match msg {
                None => machine.tick(now),
                Some(Msg::Held(held)) => {
                    let _ = app.emit("shortcut://keys", json!({ "held": held }));
                    Vec::new()
                }
                Some(Msg::Busy(b)) => {
                    busy = b;
                    Vec::new()
                }
                Some(Msg::CardOpen(open)) => {
                    card = open;
                    Vec::new()
                }
                Some(Msg::Inputs(inputs)) => {
                    let mut out = Vec::new();
                    for input in inputs {
                        match input {
                            // A run in flight or an answer card: Esc stops or closes it; new presses wait.
                            Input::Escape if !machine.is_recording() && (busy || card) => {
                                let mode = if card { Mode::Ask } else { Mode::Dictate };
                                let _ = app.emit_to(WindowLabel::Bar.as_str(), "shortcut://cancel", json!({ "mode": mode }));
                                hook(app, &Action::Cancel(key_mode(mode)), Target::Bar);
                            }
                            Input::Down(_) | Input::Up(_) if busy && !machine.is_recording() => {}
                            input => out.extend(machine.handle(input, now)),
                        }
                    }
                    out
                }
            };
            for action in &actions {
                let target = if matches!(action, Action::Start(_)) { self.target(app) } else { self.last_target(app) };
                self.remember_target(target);
                emit_action(app, action, target);
                hook(app, action, target);
            }
            let want = machine.is_recording() || busy || card;
            if want != escape {
                escape = want;
                self.set_escape(app, want);
            }
        }
    }

    fn remember_target(&self, target: Target) {
        LAST_TARGET.with_borrow_mut(|t| *t = target);
    }

    fn last_target(&self, _app: &AppHandle) -> Target {
        LAST_TARGET.with_borrow(|t| *t)
    }
}

thread_local! {
    /// The target of the recording in progress (the dispatcher is one thread).
    static LAST_TARGET: std::cell::RefCell<Target> = const { std::cell::RefCell::new(Target::Bar) };
}

fn escape_shortcut() -> Shortcut {
    Shortcut::from_str(ESCAPE).expect("Escape parses")
}

fn emit_action<R: Runtime>(app: &AppHandle<R>, action: &Action, target: Target) {
    let label = match target {
        Target::Bar => WindowLabel::Bar.as_str(),
        Target::Onboarding => WindowLabel::Onboarding.as_str(),
    };
    let (name, payload) = match action {
        Action::Start(m) => ("shortcut://down", json!({ "mode": run_mode(*m) })),
        Action::Switch { mode, hands_free } => ("shortcut://switch", json!({ "mode": run_mode(*mode), "hands_free": hands_free })),
        Action::Stop(m) => ("shortcut://up", json!({ "mode": run_mode(*m) })),
        Action::Cancel(m) => ("shortcut://cancel", json!({ "mode": run_mode(*m) })),
        Action::Hint(Hint::AskHold) => return,
    };
    let _ = app.emit_to(label, name, payload);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sc(d: &str, a: &str, t: &str) -> ShortcutSettings {
        ShortcutSettings { dictate: d.into(), ask: a.into(), translate: t.into() }
    }

    #[test]
    fn validates_fn_and_ordinary_shortcuts() {
        assert!(validate("Fn").is_ok());
        assert!(validate("Fn+ShiftLeft").is_ok());
        assert!(validate("Alt+Shift+Space").is_ok());
        assert!(validate("Fn+Q").is_err());
        assert!(validate("Space").is_err(), "a bare key would be global");
        assert!(validate("Alt+Bogus").is_err());
    }

    #[test]
    fn plans_fn_with_permission_and_fallbacks_without() {
        let defaults = ShortcutSettings::default();
        let (fns, plugin) = plan(&defaults, true);
        assert!(fns.dictate.is_some() && fns.ask.is_some() && fns.translate.is_some());
        assert!(plugin.is_empty());

        let (fns, plugin) = plan(&defaults, false);
        assert!(fns.is_empty());
        assert_eq!(plugin, vec![(Mode::Dictate, "Alt+Space".into()), (Mode::Ask, "Alt+Shift+Space".into()), (Mode::Translate, "Alt+Control+Space".into())]);

        // A user-chosen ordinary shortcut is always registered as is; a fallback that would clash
        // with it is left out.
        let mixed = sc("Fn", "Alt+Space", "Control+Shift+T");
        let (fns, plugin) = plan(&mixed, true);
        assert!(fns.dictate.is_some() && fns.ask.is_none());
        assert_eq!(plugin, vec![(Mode::Ask, "Alt+Space".into()), (Mode::Translate, "Control+Shift+T".into())]);
        let (_, plugin) = plan(&mixed, false);
        assert_eq!(plugin, vec![(Mode::Ask, "Alt+Space".into()), (Mode::Translate, "Control+Shift+T".into())]);
    }
}
