//! The shortcuts (spec 3.2): Fn-based ones through the listen-only Fn tap in `comma-input` (needs
//! Input Monitoring), ordinary ones and the fallbacks through `tauri-plugin-global-shortcut`.
//!
//! Both sources become `comma_input::Input`s that one dispatcher thread feeds to the state
//! machine; its actions become `shortcut://*` events for the bar (or the window that captures them)
//! and the context capture for the run. Esc is listened for only while a recording, a run or an
//! answer card is open. During hands-free Dictate the tap is told to report a bare Space or Left
//! Shift as the Ask or Translate shortcut (spec 2.3.2 mode switch).
//!
//! Paste last result (default Ctrl+Cmd+V) is an ordinary plugin shortcut, registered whenever it
//! is turned on, and pastes the most recent result again (`run::paste_last`).
//!
//! macOS creates a listen-only tap even without Input Monitoring and then filters what it gets
//! (flags-changed events such as Fn alone still arrive, key presses do not), so a running tap does
//! not prove the permission. The Fn shortcuts count as working when the tap runs and either the
//! preflight says yes or a key press reached the tap (the preflight can stay "no" until relaunch);
//! until then the fallbacks are registered too. A poller re-checks every two seconds.
//!
//! Prompts: nothing here asks macOS for a permission. Creating the tap and the preflight are
//! silent checks (tccd logs them as `preflight=yes`); only `input_monitoring_request`, on a click,
//! calls `CGRequestListenEventAccess`, and only once per process.

use std::collections::BTreeSet;
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use comma_input::{Action, FnBinding, FnBindings, FnTap, Hint, Input, Machine, MatcherOutput, Mode as KeyMode, TapMode};
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

/// `Fn` or `Fn+<key>`, well formed or not.
pub fn is_fn(accel: &str) -> bool {
    accel == "Fn" || accel.starts_with("Fn+")
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

/// The Fn tap itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TapStatus {
    Running,
    /// Not needed (no Fn shortcut), or not tried yet (before onboarding asked for the permission).
    Off,
    /// `FnTap::start` failed; see `tap_error`.
    Failed,
}

/// Which source a registered shortcut comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Via {
    Fn,
    Plugin,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Registered {
    pub mode: Mode,
    pub shortcut: String,
    pub via: Via,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ActiveShortcuts {
    pub dictate: String,
    pub ask: String,
    pub translate: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ShortcutError {
    pub mode: Mode,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ShortcutsStatus {
    pub listener: Listener,
    pub active: ActiveShortcuts,
    pub errors: Vec<ShortcutError>,
    /// System Settings > Keyboard > "Press Globe key to": a listen-only tap cannot stop it.
    pub globe_key: GlobeKey,
    pub tap: TapStatus,
    pub tap_error: Option<String>,
    /// Some keyboard event reached the tap since it started.
    pub tap_delivered: bool,
    /// A key press reached the tap: Input Monitoring is in effect for this process.
    pub tap_keys: bool,
    /// The user asked for Input Monitoring in this process; asking again would not prompt.
    pub requested: bool,
    /// The active tap that swallows Fn (experimental): `off`, `on`, or `unavailable` (no Accessibility).
    pub swallow: SwallowStatus,
    /// `CGPreflightListenEventAccess` as this process sees it.
    pub input_monitoring: bool,
    /// The permission is there but the tap cannot start: macOS applies it after a restart.
    pub restart_required: bool,
    /// Everything registered now, Fn bindings on the tap and plugin shortcuts.
    pub registered: Vec<Registered>,
    /// Paste last result could not be registered (taken by another app); `None` when it works or is off.
    pub paste_last_error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SwallowStatus {
    Off,
    On,
    Unavailable,
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

fn read_hitoolbox(key: &str) -> Option<String> {
    let out = std::process::Command::new("/usr/bin/defaults").args(["read", "com.apple.HIToolbox", key]).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

/// `AppleFnUsageType` (0 do nothing, 1 change input source, 2 emoji, 3 dictation). Read-only:
/// Comma never changes it. When the key was never written, macOS uses its default, which
/// `default_globe_key` works out from the enabled input sources.
pub fn globe_key() -> GlobeKey {
    match read_hitoolbox("AppleFnUsageType").as_deref() {
        Some("0") => GlobeKey::None,
        Some("1") => GlobeKey::InputSource,
        Some("2") => GlobeKey::Emoji,
        Some("3") => GlobeKey::Dictation,
        Some(_) => GlobeKey::Unknown,
        None => read_hitoolbox("AppleEnabledInputSources").map_or(GlobeKey::Unknown, |s| default_globe_key(&s)),
    }
}

/// The macOS default for "Press Globe key to": Change Input Source with more than one keyboard
/// layout or input mode enabled, else Show Emoji & Symbols. `sources` is `defaults read` output.
pub fn default_globe_key(sources: &str) -> GlobeKey {
    let typing = sources
        .lines()
        .filter(|l| {
            let l = l.replace(' ', "");
            l.contains("InputSourceKind=\"KeyboardLayout\"") || l.contains("InputSourceKind=\"InputMode\"")
        })
        .count();
    if typing > 1 { GlobeKey::InputSource } else { GlobeKey::Emoji }
}

/// Which accelerator each mode uses given whether the Fn shortcuts can be trusted. Pure, for tests.
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

fn any_fn(configured: &ShortcutSettings) -> bool {
    MODES.iter().any(|&m| matches!(comma_input::parse_fn(configured.get(m)), Ok(Some(_))))
}

/// Start the tap when an Fn shortcut is configured and the permission is there, or once the user
/// was asked for it (`probe`: the first try is what adds Comma to the Input Monitoring list).
/// While the recorder suspends the shortcuts the tap keeps running with no bindings.
pub fn want_tap(any_fn: bool, granted: bool, probe: bool) -> bool {
    any_fn && (granted || probe)
}

/// The Fn shortcuts work only with a running tap and the permission in effect: the preflight, or
/// a key press that reached the tap (macOS delivers those only with the permission, and the
/// preflight can stay "no" until relaunch). A tap created without it gets Fn alone at most.
pub fn fn_trusted(tap_running: bool, granted: bool, keys_delivered: bool) -> bool {
    tap_running && (granted || keys_delivered)
}

pub fn listener_for(any_fn: bool, trusted: bool) -> Listener {
    if !any_fn || trusted { Listener::Fn } else { Listener::Fallback }
}

/// Allowed in System Settings but the tap does not start: macOS applies the change on relaunch.
pub fn restart_required(any_fn: bool, granted: bool, tap: TapStatus) -> bool {
    any_fn && granted && tap == TapStatus::Failed
}

/// Where a shortcut's input came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    Fn,
    Plugin,
}

enum Msg {
    Inputs(Vec<Input>, Source),
    Held(Vec<&'static str>),
    Busy(bool),
    CardOpen(bool),
    PasteLast,
}

struct Registration {
    tap: Option<FnTap>,
    tap_error: Option<String>,
    /// Plugin shortcuts and the mode each starts.
    plugin: Vec<(Shortcut, Mode)>,
    /// Paste last result, while registered.
    paste_last: Option<Shortcut>,
    escape_registered: bool,
    /// `fn_trusted` at the last reconfigure: the tap also gets Esc then.
    trusted: bool,
    /// The last active tap could not start (no Accessibility).
    swallow_failed: bool,
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
    /// The shortcut recorder is open: nothing is registered or matched, so the keys reach it.
    suspended: Arc<AtomicBool>,
    /// `CGRequestListenEventAccess` was called in this process.
    requested: Arc<AtomicBool>,
    /// Use the active tap that swallows Fn (experimental, off by default).
    swallow: Arc<AtomicBool>,
}

/// Called with each action after its event is emitted, on the dispatcher thread.
pub type ActionHook = Arc<dyn Fn(&AppHandle, &Action, Target) + Send + Sync>;

/// Where an action's events went.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Target {
    Bar,
    /// The onboarding try steps.
    Onboarding,
    /// Settings > Permissions while it tests the Fn key: nothing records.
    Hub,
}

impl Target {
    fn label(self) -> &'static str {
        match self {
            Target::Bar => WindowLabel::Bar.as_str(),
            Target::Onboarding => WindowLabel::Onboarding.as_str(),
            Target::Hub => WindowLabel::Hub.as_str(),
        }
    }
}

fn empty_status() -> ShortcutsStatus {
    ShortcutsStatus {
        listener: Listener::Fallback,
        active: ActiveShortcuts { dictate: String::new(), ask: String::new(), translate: String::new() },
        errors: Vec::new(),
        globe_key: GlobeKey::Unknown,
        tap: TapStatus::Off,
        tap_error: None,
        tap_delivered: false,
        tap_keys: false,
        requested: false,
        swallow: SwallowStatus::Off,
        input_monitoring: false,
        restart_required: false,
        registered: Vec::new(),
        paste_last_error: None,
    }
}

/// One line for the log when the listener changes. Names only configured shortcuts.
pub fn describe(s: &ShortcutsStatus) -> String {
    let tap = match s.tap {
        TapStatus::Running if s.tap_keys => "running, delivering key presses".to_owned(),
        TapStatus::Running if s.tap_delivered => "running, delivering (modifiers only so far)".to_owned(),
        TapStatus::Running => "running, nothing delivered yet".to_owned(),
        TapStatus::Off => "off".to_owned(),
        TapStatus::Failed => format!("failed ({})", s.tap_error.as_deref().unwrap_or("unknown")),
    };
    let registered: Vec<String> = s.registered.iter().map(|r| format!("{:?}={} ({:?})", r.mode, r.shortcut, r.via).to_lowercase()).collect();
    format!(
        "listener {:?}, tap {tap}, input monitoring {}{}, registered [{}]{}",
        s.listener,
        if s.input_monitoring { "allowed" } else { "not allowed" },
        if s.restart_required { ", restart required" } else { "" },
        registered.join(", "),
        if s.errors.is_empty() { String::new() } else { format!(", {} registration error(s)", s.errors.len()) },
    )
    .to_lowercase()
}

impl Shortcuts {
    /// `probe`: try the Fn tap before the permission preflight says yes (the first try adds Comma
    /// to the Input Monitoring list). Off until onboarding explained it.
    pub fn start(app: &AppHandle, configured: ShortcutSettings, probe: bool, hook: ActionHook) -> Self {
        let (tx, rx) = mpsc::channel();
        let reg = Arc::new(Mutex::new(Registration {
            tap: None,
            tap_error: None,
            plugin: Vec::new(),
            paste_last: None,
            escape_registered: false,
            trusted: false,
            swallow_failed: false,
            status: empty_status(),
            configured: configured.clone(),
        }));
        let me = Self {
            tx,
            reg,
            capture: Arc::new(Mutex::new(None)),
            probe: Arc::new(AtomicBool::new(probe)),
            suspended: Arc::new(AtomicBool::new(false)),
            requested: Arc::new(AtomicBool::new(false)),
            swallow: Arc::new(AtomicBool::new(false)),
        };
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
            .name("comma-permissions".into())
            .spawn(move || poller.poll(&handle))
            .expect("spawn the permission poller");
        me
    }

    fn poll(&self, app: &AppHandle) {
        let mut granted = comma_input::input_monitoring_granted();
        let mut permissions = None;
        loop {
            let now = crate::permissions::status();
            if permissions != Some(now) {
                log::info!(
                    "permissions: microphone {:?}, accessibility {:?}, input monitoring {:?}",
                    now.microphone,
                    now.accessibility,
                    now.input_monitoring
                );
                permissions = Some(now);
            }
            std::thread::sleep(PERMISSION_POLL);
            let now_granted = comma_input::input_monitoring_granted();
            if now_granted != granted {
                granted = now_granted;
                log::info!("Input Monitoring is {}; starting a fresh Fn listener", if granted { "allowed now" } else { "no longer allowed" });
                self.restart(app);
                continue;
            }
            let retry = self.reg.lock().map(|r| r.tap.is_none() && r.status.listener == Listener::Fallback).unwrap_or(false);
            if retry && (granted || self.probe.load(Ordering::Relaxed)) {
                let configured = self.reg.lock().map(|r| r.configured.clone()).ok();
                if let Some(configured) = configured {
                    self.reconfigure(app, &configured);
                }
            }
            self.refresh_delivered(app);
        }
    }

    /// Picks up the tap's first delivered event, and its first key press (which proves the
    /// permission and switches from the fallbacks to the Fn shortcuts).
    fn refresh_delivered(&self, app: &AppHandle) {
        let (changed, keys_now) = {
            let Ok(mut reg) = self.reg.lock() else { return };
            let delivered = reg.tap.as_ref().is_some_and(FnTap::delivered);
            let keys = reg.tap.as_ref().is_some_and(FnTap::keys_delivered);
            let keys_now = keys && !reg.status.tap_keys;
            if delivered == reg.status.tap_delivered && !keys_now {
                (None, false)
            } else {
                reg.status.tap_delivered = delivered;
                (Some(reg.status.clone()), keys_now)
            }
        };
        if keys_now {
            log::info!("Fn listener: a key press arrived, so Input Monitoring is in effect");
            let configured = self.reg.lock().map(|r| r.configured.clone()).ok();
            if let Some(configured) = configured {
                self.reconfigure(app, &configured);
            }
        } else if let Some(status) = changed {
            log::info!("Fn listener: {}", describe(&status));
            emit_status(app, &status);
        }
    }

    /// Input Monitoring is in effect for this process (preflight, or a key press reached the tap).
    pub fn input_monitoring_effective(&self) -> bool {
        // An active tap (Swallow Fn) runs on Accessibility and gets keys either way: no proof there.
        comma_input::input_monitoring_granted()
            || self.reg.lock().is_ok_and(|r| r.tap.as_ref().is_some_and(|t| t.mode() == TapMode::ListenOnly && t.keys_delivered()))
    }

    /// Whether `CGRequestListenEventAccess` may run: once per process, on a click.
    pub fn take_request(&self) -> bool {
        !self.requested.swap(true, Ordering::Relaxed)
    }

    /// Turns the experimental Fn-swallowing tap on or off and restarts the listener.
    pub fn set_swallow(&self, app: &AppHandle, on: bool) {
        if self.swallow.swap(on, Ordering::Relaxed) != on {
            log::info!("Fn listener: swallowing Fn {}", if on { "on" } else { "off" });
            if let Ok(mut reg) = self.reg.lock() {
                reg.swallow_failed = false;
            }
            self.restart(app);
        }
    }

    pub fn status(&self) -> AppResult<ShortcutsStatus> {
        Ok(self.reg.lock().map_err(|_| AppError::internal("shortcut lock poisoned"))?.status.clone())
    }

    /// After the user asked for Input Monitoring: keep trying the tap.
    pub fn enable_probe(&self) {
        self.probe.store(true, Ordering::Relaxed);
    }

    /// Whether the Fn shortcuts work (tap running and permission in effect).
    pub fn fn_trusted(&self) -> bool {
        self.reg.lock().map(|r| r.trusted).unwrap_or(false)
    }

    /// Stops the tap and the plugin shortcuts and sets everything up again.
    pub fn restart(&self, app: &AppHandle) {
        let configured = {
            let Ok(mut reg) = self.reg.lock() else { return };
            if let Some(tap) = reg.tap.take() {
                tap.stop();
            }
            reg.tap_error = None;
            reg.configured.clone()
        };
        self.reconfigure(app, &configured);
    }

    /// Re-checks the permission and tries the tap even when the preflight says no.
    pub fn probe(&self, app: &AppHandle) {
        self.enable_probe();
        self.restart(app);
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

    /// While the shortcut recorder is open, every shortcut is off so its keys reach the recorder
    /// (a registered combination never arrives in a window). Turned back on when it closes.
    pub fn set_suspended(&self, app: &AppHandle, on: bool) {
        if self.suspended.swap(on, Ordering::Relaxed) == on {
            return;
        }
        let configured = self.reg.lock().map(|r| r.configured.clone()).ok();
        if let Some(configured) = configured {
            self.reconfigure(app, &configured);
        }
    }

    /// From the global-shortcut plugin's handler.
    pub fn on_plugin_event(&self, shortcut: &Shortcut, event: ShortcutEvent) {
        let Ok(reg) = self.reg.lock() else { return };
        if reg.escape_registered && *shortcut == escape_shortcut() {
            if event.state == ShortcutState::Pressed {
                let _ = self.tx.send(Msg::Inputs(vec![Input::Escape], Source::Plugin));
            }
            return;
        }
        if reg.paste_last.as_ref() == Some(shortcut) {
            if event.state == ShortcutState::Pressed {
                let _ = self.tx.send(Msg::PasteLast);
            }
            return;
        }
        let Some(&(_, mode)) = reg.plugin.iter().find(|(s, _)| s == shortcut) else { return };
        let input = match event.state {
            ShortcutState::Pressed => Input::Down(key_mode(mode)),
            ShortcutState::Released => Input::Up(key_mode(mode)),
        };
        let _ = self.tx.send(Msg::Inputs(vec![input], Source::Plugin));
    }

    /// Applies `configured`: starts or stops the Fn tap, and registers the ordinary shortcuts.
    pub fn reconfigure(&self, app: &AppHandle, configured: &ShortcutSettings) {
        let granted = comma_input::input_monitoring_granted();
        let any_fn = any_fn(configured);
        let suspended = self.suspended.load(Ordering::Relaxed);
        let probe = self.probe.load(Ordering::Relaxed);
        let want_swallow = self.swallow.load(Ordering::Relaxed);
        let (before, after) = {
            let Ok(mut reg) = self.reg.lock() else { return };
            let before = reg.status.clone();
            reg.configured = configured.clone();
            // The wanted tap kind changed: start over with the other one.
            let mode = if want_swallow && !reg.swallow_failed { TapMode::Swallow } else { TapMode::ListenOnly };
            if reg.tap.as_ref().is_some_and(|t| t.mode() != mode)
                && let Some(tap) = reg.tap.take()
            {
                tap.stop();
            }

            // The tap always gets the Fn bindings: when Fn gets through without the permission, it works.
            let tap_bindings = if suspended { FnBindings::default() } else { plan(configured, true).0 };
            if want_tap(any_fn, granted, probe) {
                if let Some(tap) = &reg.tap {
                    tap.set_bindings(tap_bindings);
                } else {
                    let start = |mode: TapMode| {
                        let tx = self.tx.clone();
                        FnTap::start(tap_bindings, mode, move |out: MatcherOutput| {
                            if !out.inputs.is_empty() {
                                let _ = tx.send(Msg::Inputs(out.inputs, Source::Fn));
                            }
                            if let Some(held) = out.held {
                                let _ = tx.send(Msg::Held(held));
                            }
                        })
                    };
                    let mut started = start(mode);
                    if mode == TapMode::Swallow
                        && let Err(e) = &started
                    {
                        log::warn!("Fn listener: cannot swallow Fn ({e}); listening only");
                        reg.swallow_failed = true;
                        started = start(TapMode::ListenOnly);
                    }
                    match started {
                        Ok(tap) => {
                            reg.tap = Some(tap);
                            reg.tap_error = None;
                        }
                        Err(e) => reg.tap_error = Some(e.to_string()),
                    }
                }
            } else if let Some(tap) = reg.tap.take() {
                tap.stop();
            }

            let tap_running = reg.tap.is_some();
            let keys = reg.tap.as_ref().is_some_and(FnTap::keys_delivered);
            let trusted = fn_trusted(tap_running, granted, keys);
            reg.trusted = trusted;
            let (_, plugin) = plan(configured, trusted);
            let gs = app.global_shortcut();
            for (shortcut, _) in reg.plugin.drain(..) {
                let _ = gs.unregister(shortcut);
            }
            if let Some(shortcut) = reg.paste_last.take() {
                let _ = gs.unregister(shortcut);
            }
            let mut paste_last_error = None;
            if let Some(accel) = configured.paste_last().filter(|_| !suspended) {
                match Shortcut::from_str(accel).map_err(|e| e.to_string()).and_then(|s| gs.register(s).map(|()| s).map_err(|e| e.to_string())) {
                    Ok(shortcut) => reg.paste_last = Some(shortcut),
                    Err(e) => paste_last_error = Some(format!("{accel} could not be registered. Another app may use it ({e})")),
                }
            }
            let mut errors = Vec::new();
            let mut registered = Vec::new();
            if tap_running && !suspended {
                for mode in MODES {
                    let accel = configured.get(mode);
                    if matches!(comma_input::parse_fn(accel), Ok(Some(_))) {
                        registered.push(Registered { mode, shortcut: accel.to_owned(), via: Via::Fn });
                    }
                }
            }
            for (mode, accel) in plugin.iter().filter(|_| !suspended) {
                match Shortcut::from_str(accel) {
                    Ok(shortcut) => match gs.register(shortcut) {
                        Ok(()) => {
                            reg.plugin.push((shortcut, *mode));
                            registered.push(Registered { mode: *mode, shortcut: accel.clone(), via: Via::Plugin });
                        }
                        Err(e) => errors.push(ShortcutError { mode: *mode, message: format!("{accel} could not be registered. Another app may use it ({e})") }),
                    },
                    Err(_) => errors.push(ShortcutError { mode: *mode, message: format!("{accel} is not a valid shortcut") }),
                }
            }
            let active_for = |mode: Mode| -> String {
                let accel = configured.get(mode);
                if trusted || !matches!(comma_input::parse_fn(accel), Ok(Some(_))) {
                    accel.to_owned()
                } else {
                    plugin.iter().find(|(m, _)| *m == mode).map(|(_, a)| a.clone()).unwrap_or_default()
                }
            };
            let tap = if tap_running {
                TapStatus::Running
            } else if reg.tap_error.is_some() {
                TapStatus::Failed
            } else {
                TapStatus::Off
            };
            reg.status = ShortcutsStatus {
                listener: listener_for(any_fn, trusted),
                active: ActiveShortcuts { dictate: active_for(Mode::Dictate), ask: active_for(Mode::Ask), translate: active_for(Mode::Translate) },
                errors,
                globe_key: if any_fn { globe_key() } else { GlobeKey::None },
                tap,
                tap_error: reg.tap_error.clone(),
                tap_delivered: reg.tap.as_ref().is_some_and(FnTap::delivered),
                tap_keys: keys,
                requested: self.requested.load(Ordering::Relaxed),
                swallow: match reg.tap.as_ref().map(FnTap::mode) {
                    Some(TapMode::Swallow) => SwallowStatus::On,
                    _ if want_swallow && reg.swallow_failed => SwallowStatus::Unavailable,
                    _ => SwallowStatus::Off,
                },
                input_monitoring: granted,
                restart_required: restart_required(any_fn, granted, tap),
                registered,
                paste_last_error,
            };
            (before, reg.status.clone())
        };
        if before != after {
            log::info!("shortcuts: {}", describe(&after));
            for e in &after.errors {
                log::warn!("shortcut for {:?} not registered: {}", e.mode, e.message);
            }
            if let Some(e) = &after.paste_last_error {
                log::warn!("paste last result not registered: {e}");
            }
            emit_status(app, &after);
        }
    }

    fn target(&self, app: &AppHandle) -> Target {
        let owner = self.capture.lock().ok().and_then(|c| *c);
        let focused = |label: WindowLabel| app.get_webview_window(label.as_str()).is_some_and(|w| w.is_focused().unwrap_or(false));
        match owner {
            Some(WindowLabel::Onboarding) if focused(WindowLabel::Onboarding) => Target::Onboarding,
            Some(WindowLabel::Hub) if focused(WindowLabel::Hub) => Target::Hub,
            _ => Target::Bar,
        }
    }

    fn set_escape(&self, app: &AppHandle, on: bool) {
        let Ok(mut reg) = self.reg.lock() else { return };
        if let Some(tap) = &reg.tap {
            tap.set_listen_escape(on);
        }
        // Without the permission the tap may not see Esc: register it as an ordinary shortcut too.
        let want_plugin = on && !reg.trusted;
        if want_plugin != reg.escape_registered {
            let gs = app.global_shortcut();
            let ok = if want_plugin { gs.register(escape_shortcut()).is_ok() } else { gs.unregister(escape_shortcut()).is_ok() };
            if ok || !want_plugin {
                reg.escape_registered = want_plugin;
            }
        }
    }

    /// Hands-free Dictate: the tap reports a bare Space or Left Shift as a mode switch.
    fn set_bare_switch(&self, on: bool) {
        if let Ok(reg) = self.reg.lock()
            && let Some(tap) = &reg.tap
        {
            tap.set_bare_switch(on);
        }
    }

    fn dispatch(&self, app: &AppHandle, rx: mpsc::Receiver<Msg>, hook: ActionHook) {
        let mut machine = Machine::new(comma_input::Config::default());
        let mut busy = false;
        let mut card = false;
        let mut escape = false;
        let mut bare = false;
        let mut source = Source::Fn;
        let mut target = Target::Bar;
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
                Some(Msg::PasteLast) => {
                    crate::run::paste_last(app);
                    Vec::new()
                }
                Some(Msg::Inputs(inputs, from)) => {
                    source = from;
                    let mut out = Vec::new();
                    for input in inputs {
                        match input {
                            // A run in flight or an answer card: Esc stops or closes it; new presses wait.
                            Input::Escape if !machine.is_recording() && (busy || card) => {
                                let mode = if card { Mode::Ask } else { Mode::Dictate };
                                log::info!("shortcut: esc closes the {}", if card { "answer card" } else { "run in flight" });
                                let _ = app.emit_to(WindowLabel::Bar.as_str(), "shortcut://cancel", json!({ "mode": mode }));
                                hook(app, &Action::Cancel(key_mode(mode)), Target::Bar);
                            }
                            // A run in flight: no new recording, but a finishing press still drains.
                            Input::Down(_) if busy && machine.would_start(input) => {}
                            input => out.extend(machine.handle(input, now)),
                        }
                    }
                    out
                }
            };
            for action in &actions {
                if matches!(action, Action::Start(_)) {
                    target = self.target(app);
                }
                emit_action(app, action, target, source);
                hook(app, action, target);
            }
            if machine.bare_switch() != bare {
                bare = machine.bare_switch();
                self.set_bare_switch(bare);
            }
            let want = machine.is_recording() || busy || card;
            if want != escape {
                escape = want;
                self.set_escape(app, want);
            }
        }
    }
}

fn escape_shortcut() -> Shortcut {
    Shortcut::from_str(ESCAPE).expect("Escape parses")
}

fn emit_status<R: Runtime>(app: &AppHandle<R>, status: &ShortcutsStatus) {
    let _ = app.emit("shortcut://status", status);
    let _ = app.emit("settings://changed", json!({}));
}

/// The `shortcut://action` payload: what the state machine decided, for the devtool and the key test.
/// A dismissed tap is a `cancel` with `quiet`: too short to hold speech, so the bar goes away
/// without the cancel sound or shake and nothing runs.
pub fn action_payload(action: &Action, target: Target, source: Source) -> serde_json::Value {
    let (name, mode, hands_free, quiet, hint) = match action {
        Action::Start(m) => ("start", *m, None, false, None),
        Action::Switch { mode, hands_free } => ("switch", *mode, Some(*hands_free), false, None),
        Action::Stop(m) => ("stop", *m, None, false, None),
        Action::Cancel(m) => ("cancel", *m, None, false, None),
        Action::Dismiss(m) => ("cancel", *m, None, true, None),
        Action::Hint(Hint::AskHold) => ("hint", KeyMode::Ask, None, false, Some("ask_hold")),
        Action::Hint(Hint::FinishWithFn) => ("hint", KeyMode::Dictate, None, false, Some("finish_with_fn")),
    };
    let mut payload = json!({ "action": name, "mode": run_mode(mode), "source": source, "target": target });
    if let Some(h) = hands_free {
        payload["hands_free"] = json!(h);
    }
    if quiet {
        payload["quiet"] = json!(true);
    }
    if let Some(h) = hint {
        payload["hint"] = json!(h);
    }
    payload
}

fn emit_action<R: Runtime>(app: &AppHandle<R>, action: &Action, target: Target, source: Source) {
    let payload = action_payload(action, target, source);
    log::info!("shortcut: {} {} via {} to {}", payload["action"], payload["mode"], payload["source"], payload["target"]);
    let _ = app.emit("shortcut://action", payload);
    let (name, payload) = match action {
        Action::Start(m) => ("shortcut://down", json!({ "mode": run_mode(*m) })),
        Action::Switch { mode, hands_free } => ("shortcut://switch", json!({ "mode": run_mode(*mode), "hands_free": hands_free })),
        Action::Stop(m) => ("shortcut://up", json!({ "mode": run_mode(*m) })),
        Action::Dismiss(m) => ("shortcut://cancel", json!({ "mode": run_mode(*m), "quiet": true })),
        Action::Cancel(m) => ("shortcut://cancel", json!({ "mode": run_mode(*m) })),
        Action::Hint(_) => return,
    };
    let _ = app.emit_to(target.label(), name, payload);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sc(d: &str, a: &str, t: &str) -> ShortcutSettings {
        ShortcutSettings { dictate: d.into(), ask: a.into(), translate: t.into(), ..ShortcutSettings::default() }
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

    /// The bug behind "Fn does nothing": macOS created the tap without Input Monitoring, Comma took
    /// that as the permission, reported `fn`, registered no fallback and showed no hint.
    #[test]
    fn a_tap_without_the_permission_is_not_trusted() {
        assert!(!fn_trusted(true, false, false), "running tap, preflight no, only Fn arrives");
        assert!(fn_trusted(true, true, false));
        assert!(fn_trusted(true, false, true), "a key press arrived: allowed, the preflight is stale");
        assert!(!fn_trusted(false, true, true));
        assert_eq!(listener_for(true, fn_trusted(true, false, false)), Listener::Fallback);
        assert_eq!(listener_for(true, true), Listener::Fn);
        assert_eq!(listener_for(false, false), Listener::Fn, "nothing needs the tap");
        // Untrusted means the fallbacks are registered next to the tap.
        let (_, plugin) = plan(&ShortcutSettings::default(), fn_trusted(true, false, false));
        assert_eq!(plugin.len(), 3);
    }

    #[test]
    fn the_tap_is_tried_with_the_permission_or_after_asking() {
        assert!(!want_tap(true, false, false), "before onboarding explained it");
        assert!(want_tap(true, false, true), "probing adds Comma to the list");
        assert!(want_tap(true, true, false));
        assert!(!want_tap(false, true, true), "no Fn shortcut configured");
    }

    #[test]
    fn restart_is_required_only_when_allowed_but_the_tap_fails() {
        assert!(restart_required(true, true, TapStatus::Failed));
        assert!(!restart_required(true, false, TapStatus::Failed), "not allowed yet: ask, not restart");
        assert!(!restart_required(true, true, TapStatus::Running));
        assert!(!restart_required(false, true, TapStatus::Failed));
    }

    #[test]
    fn status_serializes_like_the_shared_contract() {
        let mut s = empty_status();
        s.tap = TapStatus::Running;
        s.registered = vec![Registered { mode: Mode::Dictate, shortcut: "Fn".into(), via: Via::Fn }];
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["listener"], "fallback");
        assert_eq!(v["tap"], "running");
        assert_eq!(v["tap_error"], serde_json::Value::Null);
        assert_eq!((v["tap_keys"].clone(), v["requested"].clone(), v["swallow"].clone()), (json!(false), json!(false), json!("off")));
        assert_eq!(v["registered"][0], json!({ "mode": "dictate", "shortcut": "Fn", "via": "fn" }));
        assert_eq!(serde_json::to_value(Target::Hub).unwrap(), "hub");
    }

    #[test]
    fn describe_names_only_configured_shortcuts() {
        let mut s = empty_status();
        s.tap = TapStatus::Running;
        s.registered = vec![
            Registered { mode: Mode::Dictate, shortcut: "Fn".into(), via: Via::Fn },
            Registered { mode: Mode::Dictate, shortcut: "Alt+Space".into(), via: Via::Plugin },
        ];
        let line = describe(&s);
        assert_eq!(line, "listener fallback, tap running, nothing delivered yet, input monitoring not allowed, registered [dictate=fn (fn), dictate=alt+space (plugin)]");
    }

    #[test]
    fn an_unset_globe_key_follows_the_macos_default() {
        let two = r#"(
            { InputSourceKind = "Keyboard Layout"; "KeyboardLayout ID" = 252; "KeyboardLayout Name" = ABC; },
            { "Bundle ID" = "com.apple.inputmethod.SCIM"; "Input Mode" = "com.apple.inputmethod.SCIM.ITABC"; InputSourceKind = "Input Mode"; },
            { "Bundle ID" = "com.apple.inputmethod.SCIM"; InputSourceKind = "Keyboard Input Method"; },
            { "Bundle ID" = "com.apple.CharacterPaletteIM"; InputSourceKind = "Non Keyboard Input Method"; }
        )"#
        .replace("; ", ";\n");
        assert_eq!(default_globe_key(&two), GlobeKey::InputSource, "ABC plus Pinyin: Fn switches the input source");
        let one = "(\n{\nInputSourceKind = \"Keyboard Layout\";\n\"KeyboardLayout Name\" = ABC;\n},\n{\nInputSourceKind = \"Non Keyboard Input Method\";\n}\n)";
        assert_eq!(default_globe_key(one), GlobeKey::Emoji);
    }

    #[test]
    fn action_payloads() {
        let p = action_payload(&Action::Switch { mode: KeyMode::Ask, hands_free: false }, Target::Bar, Source::Fn);
        assert_eq!(p, json!({ "action": "switch", "mode": "ask", "source": "fn", "target": "bar", "hands_free": false }));
        let p = action_payload(&Action::Dismiss(KeyMode::Dictate), Target::Bar, Source::Fn);
        assert_eq!((p["action"].clone(), p["quiet"].clone()), (json!("cancel"), json!(true)), "a tap under the hold threshold");
        assert_eq!(action_payload(&Action::Cancel(KeyMode::Dictate), Target::Bar, Source::Fn).get("quiet"), None);
        let p = action_payload(&Action::Start(KeyMode::Dictate), Target::Hub, Source::Plugin);
        assert_eq!(p, json!({ "action": "start", "mode": "dictate", "source": "plugin", "target": "hub" }));
        let p = action_payload(&Action::Hint(Hint::FinishWithFn), Target::Bar, Source::Fn);
        assert_eq!((p["action"].clone(), p["hint"].clone()), (json!("hint"), json!("finish_with_fn")));
    }
}
