//! The Fn listener: a listen-only `CGEventTap` on its own thread (needs Input Monitoring).
//!
//! It subscribes to flags-changed, key-down and key-up events, reads only the keycode, the
//! autorepeat field and the modifier flags of each, and hands them to a [`Matcher`] that keeps
//! only the configured keys (see the privacy rule in [`crate::binding`]). Being listen-only, it
//! never blocks, changes or swallows an event.
//!
//! Without Input Monitoring, macOS still creates a listen-only tap (`CGEventTapCreate` returns a
//! port) but filters what it delivers, so a running tap is not proof of the permission. Callers
//! check [`input_monitoring_granted`] as well, and [`FnTap::delivered`] tells whether any event
//! has arrived since the tap started. Without the permission macOS still passes flags-changed
//! events (Fn alone), not key presses, so [`FnTap::keys_delivered`] is the proof that Input
//! Monitoring is in effect for this process even while the preflight still says no.
//!
//! [`TapMode::Swallow`] is an active tap instead (needs Accessibility): it drops the Fn key's own
//! events while an Fn shortcut is configured, and a trigger key (Space, Left Shift) pressed as part
//! of a shortcut or as a bare mode switch (see [`Matcher::consumes`]); every other event passes
//! untouched. A listen-only tap cannot drop anything: there a Space used to switch modes is also
//! typed into the focused app, and a Left Shift reaches it too.

use crate::binding::{FnBindings, Matcher, MatcherOutput};

/// How the tap treats the events it sees.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TapMode {
    /// Observe only; every event passes.
    #[default]
    ListenOnly,
    /// Active tap: swallow what [`Matcher::consumes`] names. Needs Accessibility.
    Swallow,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum TapError {
    /// `CGEventTapCreate` returned null: Input Monitoring is not allowed.
    #[error("Comma needs the Input Monitoring permission to use Fn shortcuts")]
    NotPermitted,
    #[error("the Fn listener could not start: {0}")]
    Failed(String),
}

#[cfg(target_os = "macos")]
pub use mac::{FnTap, input_monitoring_granted, request_input_monitoring};

#[cfg(not(target_os = "macos"))]
pub use stub::{FnTap, input_monitoring_granted, request_input_monitoring};

/// What the tap callback shares with the owning [`FnTap`].
struct Shared {
    matcher: std::sync::Mutex<Matcher>,
    listen_escape: std::sync::atomic::AtomicBool,
    /// Some event reached the callback since the tap started. Only this flag is kept, no count.
    delivered: std::sync::atomic::AtomicBool,
    /// A key press or release (not just a modifier change) reached the callback.
    keys_delivered: std::sync::atomic::AtomicBool,
    swallow: bool,
    handler: Box<dyn Fn(MatcherOutput) + Send + Sync>,
}

impl Shared {
    fn new(bindings: FnBindings, mode: TapMode, handler: Box<dyn Fn(MatcherOutput) + Send + Sync>) -> Self {
        Self {
            matcher: std::sync::Mutex::new(Matcher::new(bindings)),
            listen_escape: Default::default(),
            delivered: Default::default(),
            keys_delivered: Default::default(),
            swallow: mode == TapMode::Swallow,
            handler,
        }
    }

    fn set_bindings(&self, bindings: FnBindings) {
        if let Ok(mut m) = self.matcher.lock() {
            m.set_bindings(bindings);
        }
    }

    fn set_bare_switch(&self, on: bool) {
        if let Ok(mut m) = self.matcher.lock() {
            m.set_bare_switch(on);
        }
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::c_void;
    use std::ptr::NonNull;
    use std::sync::atomic::{AtomicBool, AtomicPtr, Ordering};
    use std::sync::{Arc, mpsc};
    use std::thread::JoinHandle;

    use objc2_core_foundation::{CFMachPort, CFRetained, CFRunLoop, kCFRunLoopCommonModes, kCFRunLoopDefaultMode};
    use objc2_core_graphics::{
        CGEvent, CGEventField, CGEventMask, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement, CGEventTapProxy,
        CGEventType, CGPreflightListenEventAccess, CGRequestListenEventAccess,
    };

    use super::{Shared, TapError, TapMode};
    use crate::binding::{FnBindings, MatcherOutput, RawEvent};

    /// CGPreflightListenEventAccess: whether Input Monitoring is allowed. Does not prompt.
    pub fn input_monitoring_granted() -> bool {
        CGPreflightListenEventAccess()
    }

    /// CGRequestListenEventAccess: adds Comma to the Input Monitoring list and shows the system
    /// prompt the first time. Returns whether it is allowed now.
    pub fn request_input_monitoring() -> bool {
        CGRequestListenEventAccess()
    }

    struct TapState {
        shared: Shared,
        /// The tap's mach port, to re-enable it when macOS disables it. Null until created.
        port: AtomicPtr<CFMachPort>,
        stop: AtomicBool,
    }

    pub struct FnTap {
        state: Arc<TapState>,
        thread: Option<JoinHandle<()>>,
    }

    impl std::fmt::Debug for FnTap {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.debug_struct("FnTap").field("running", &self.thread.is_some()).field("swallow", &self.state.shared.swallow).finish()
        }
    }

    impl FnTap {
        /// Starts the listener. `handler` runs on the tap thread for every non-empty output; keep
        /// it short (forward to a channel), since macOS disables a tap that stalls.
        pub fn start(bindings: FnBindings, mode: TapMode, handler: impl Fn(MatcherOutput) + Send + Sync + 'static) -> Result<FnTap, TapError> {
            let state = Arc::new(TapState {
                shared: Shared::new(bindings, mode, Box::new(handler)),
                port: AtomicPtr::new(std::ptr::null_mut()),
                stop: AtomicBool::new(false),
            });
            let (tx, rx) = mpsc::channel::<Result<(), TapError>>();
            let thread_state = Arc::clone(&state);
            let thread = std::thread::Builder::new()
                .name("comma-fn-tap".into())
                .spawn(move || run(thread_state, tx))
                .map_err(|e| TapError::Failed(e.to_string()))?;
            match rx.recv() {
                Ok(Ok(())) => Ok(FnTap { state, thread: Some(thread) }),
                Ok(Err(e)) => {
                    let _ = thread.join();
                    Err(e)
                }
                Err(_) => Err(TapError::Failed("the listener thread ended".into())),
            }
        }

        pub fn set_bindings(&self, bindings: FnBindings) {
            self.state.shared.set_bindings(bindings);
        }

        /// Esc is matched only while this is on (during a recording, or with the answer card open).
        pub fn set_listen_escape(&self, on: bool) {
            self.state.shared.listen_escape.store(on, Ordering::Relaxed);
        }

        /// During hands-free Dictate: the next Space or Left Shift alone switches the mode.
        pub fn set_bare_switch(&self, on: bool) {
            self.state.shared.set_bare_switch(on);
        }

        /// Whether any keyboard event has reached the tap since it started.
        pub fn delivered(&self) -> bool {
            self.state.shared.delivered.load(Ordering::Relaxed)
        }

        /// Whether a key press or release has reached the tap: macOS delivers those only with
        /// Input Monitoring in effect for this process.
        pub fn keys_delivered(&self) -> bool {
            self.state.shared.keys_delivered.load(Ordering::Relaxed)
        }

        pub fn mode(&self) -> TapMode {
            if self.state.shared.swallow { TapMode::Swallow } else { TapMode::ListenOnly }
        }

        pub fn stop(mut self) {
            self.shutdown();
        }

        fn shutdown(&mut self) {
            self.state.stop.store(true, Ordering::Relaxed);
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }

    impl Drop for FnTap {
        fn drop(&mut self) {
            self.shutdown();
        }
    }

    fn run(state: Arc<TapState>, ready: mpsc::Sender<Result<(), TapError>>) {
        let mask: CGEventMask =
            (1 << CGEventType::KeyDown.0) | (1 << CGEventType::KeyUp.0) | (1 << CGEventType::FlagsChanged.0);
        let user_info = Arc::as_ptr(&state) as *mut c_void;
        // Swallowing happens as early as possible, before the system acts on the Globe key.
        let (location, options) = if state.shared.swallow {
            (CGEventTapLocation::HIDEventTap, CGEventTapOptions::Default)
        } else {
            (CGEventTapLocation::SessionEventTap, CGEventTapOptions::ListenOnly)
        };
        // SAFETY: `callback` matches CGEventTapCallBack and only reads `user_info` as the
        // `TapState` this thread keeps alive (its Arc) until the tap is invalidated below.
        let port = unsafe {
            CGEvent::tap_create(
                location,
                CGEventTapPlacement::HeadInsertEventTap,
                options,
                mask,
                Some(callback),
                user_info,
            )
        };
        let Some(port) = port else {
            let _ = ready.send(Err(if state.shared.swallow {
                TapError::Failed("an active tap needs the Accessibility permission".into())
            } else {
                TapError::NotPermitted
            }));
            return;
        };
        let Some(source) = CFMachPort::new_run_loop_source(None, Some(&port), 0) else {
            port.invalidate();
            let _ = ready.send(Err(TapError::Failed("no run loop source".into())));
            return;
        };
        let Some(run_loop) = CFRunLoop::current() else {
            port.invalidate();
            let _ = ready.send(Err(TapError::Failed("no run loop".into())));
            return;
        };
        state.port.store(CFRetained::as_ptr(&port).as_ptr(), Ordering::Release);
        // SAFETY: kCFRunLoopCommonModes is an immutable framework constant.
        run_loop.add_source(Some(&source), unsafe { kCFRunLoopCommonModes });
        CGEvent::tap_enable(&port, true);
        let _ = ready.send(Ok(()));

        while !state.stop.load(Ordering::Relaxed) {
            // SAFETY: kCFRunLoopDefaultMode is an immutable framework constant.
            CFRunLoop::run_in_mode(unsafe { kCFRunLoopDefaultMode }, 0.25, false);
        }

        CGEvent::tap_enable(&port, false);
        // SAFETY: as above.
        run_loop.remove_source(Some(&source), unsafe { kCFRunLoopCommonModes });
        state.port.store(std::ptr::null_mut(), Ordering::Release);
        port.invalidate();
    }

    unsafe extern "C-unwind" fn callback(
        _proxy: CGEventTapProxy,
        ty: CGEventType,
        event: NonNull<CGEvent>,
        user_info: *mut c_void,
    ) -> *mut CGEvent {
        // SAFETY: `user_info` is the `TapState` set in `run`, alive while the tap exists.
        let state = unsafe { &*(user_info as *const TapState) };
        // A panic must not unwind into CoreGraphics.
        let consumed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            if ty == CGEventType::TapDisabledByTimeout || ty == CGEventType::TapDisabledByUserInput {
                let port = state.port.load(Ordering::Acquire);
                // SAFETY: non-null only while `run` holds the retained port.
                if let Some(port) = unsafe { port.as_ref() } {
                    CGEvent::tap_enable(port, true);
                }
                let why = if ty == CGEventType::TapDisabledByTimeout { "timeout" } else { "user input" };
                log::warn!("Fn listener: macOS disabled the tap ({why}); re-enabled");
                return false;
            }
            state.shared.delivered.store(true, Ordering::Relaxed);
            if ty == CGEventType::KeyDown || ty == CGEventType::KeyUp {
                state.shared.keys_delivered.store(true, Ordering::Relaxed);
            }
            // SAFETY: CoreGraphics passes a valid event for the duration of the callback.
            let ev = unsafe { event.as_ref() };
            let keycode = CGEvent::integer_value_field(Some(ev), CGEventField::KeyboardEventKeycode) as u16;
            let raw = match ty {
                CGEventType::FlagsChanged => RawEvent::FlagsChanged { keycode, flags: CGEvent::flags(Some(ev)).0 },
                CGEventType::KeyDown => RawEvent::KeyDown {
                    keycode,
                    repeat: CGEvent::integer_value_field(Some(ev), CGEventField::KeyboardEventAutorepeat) != 0,
                },
                CGEventType::KeyUp => RawEvent::KeyUp { keycode },
                _ => return false,
            };
            let listen_escape = state.shared.listen_escape.load(Ordering::Relaxed);
            let out = match state.shared.matcher.lock() {
                Ok(mut m) => m.feed(raw, listen_escape),
                Err(_) => return false,
            };
            let consume = state.shared.swallow && out.consume;
            if !out.is_empty() {
                (state.shared.handler)(out);
            }
            consume
        }));
        if consumed.unwrap_or(false) {
            // Swallowed (active tap only): the system and other apps never see it.
            return std::ptr::null_mut();
        }
        event.as_ptr()
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        #[ignore = "creates an active HID tap for a moment; run with --ignored"]
        fn real_swallow_tap() {
            let bindings = FnBindings { dictate: Some(crate::binding::FnBinding::Fn), ..Default::default() };
            match FnTap::start(bindings, TapMode::Swallow, |_| {}) {
                Ok(tap) => {
                    println!("swallow tap started: {:?}", tap.mode());
                    std::thread::sleep(std::time::Duration::from_millis(300));
                    tap.stop();
                }
                Err(e) => println!("swallow tap: {e}"),
            }
        }

        #[test]
        #[ignore = "reads the Input Monitoring state; run with --ignored"]
        fn real_input_monitoring_state() {
            let granted = input_monitoring_granted();
            println!("input monitoring granted: {granted}");
            // Starting the tap agrees with the preflight answer.
            // Without the permission the tap is usually still created (it only receives less).
            let tap = FnTap::start(FnBindings::default(), TapMode::ListenOnly, |_| {});
            println!("tap start: {:?}", tap.as_ref().map(|_| ()));
            if let Ok(tap) = tap {
                println!("delivered: {}, keys: {}", tap.delivered(), tap.keys_delivered());
                tap.stop();
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod stub {
    use super::{Shared, TapError, TapMode};
    use crate::binding::{FnBindings, MatcherOutput};

    pub fn input_monitoring_granted() -> bool {
        false
    }

    pub fn request_input_monitoring() -> bool {
        false
    }

    #[derive(Debug)]
    pub struct FnTap;

    impl FnTap {
        pub fn start(bindings: FnBindings, mode: TapMode, handler: impl Fn(MatcherOutput) + Send + Sync + 'static) -> Result<FnTap, TapError> {
            let _ = Shared::new(bindings, mode, Box::new(handler));
            Err(TapError::Failed("only available on macOS".into()))
        }
        pub fn set_bindings(&self, _bindings: FnBindings) {}
        pub fn set_listen_escape(&self, _on: bool) {}
        pub fn set_bare_switch(&self, _on: bool) {}
        pub fn delivered(&self) -> bool {
            false
        }
        pub fn keys_delivered(&self) -> bool {
            false
        }
        pub fn mode(&self) -> TapMode {
            TapMode::ListenOnly
        }
        pub fn stop(self) {}
    }
}
