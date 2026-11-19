//! Comma's keyboard and output layer, without Tauri.
//!
//! - [`machine`]: the shortcut state machine (hold, press to toggle, double press for hands-free,
//!   Esc, mode switching).
//! - [`binding`]: Fn-based shortcuts and the matcher from raw key events to shortcut inputs.
//! - [`tap`]: the listen-only event tap that feeds the matcher (needs Input Monitoring).
//! - [`paste`]: paste at the cursor with the clipboard saved and restored.
//! - [`context`]: the frontmost app, its selected text and whether it has a text field.
//!
//! Privacy boundary: the tap reads the keycode, autorepeat flag and modifier flags of keyboard
//! events and passes them only to the matcher, which keeps the Fn key, the configured trigger keys
//! and (while asked) Esc. Any other key is at most the anonymous [`machine::Input::OtherKey`] while
//! Fn is held, and is never stored, logged or sent. [`context`] reads another app only when a run
//! starts: its name, and the selected text for Ask Anything.

pub mod binding;
pub mod context;
pub mod machine;
pub mod paste;
pub mod tap;

pub use binding::{FnBinding, FnBindings, FnKey, Matcher, MatcherOutput, RawEvent, parse_fn};
pub use machine::{Action, Config, Hint, Input, Machine, Mode};
pub use tap::{FnTap, TapError, TapMode, input_monitoring_granted, request_input_monitoring};

/// Raw key events through the matcher into the state machine, the way the desktop dispatcher
/// wires them (including the bare switch during hands-free Dictate), on the default shortcuts.
#[cfg(test)]
mod end_to_end {
    use std::time::{Duration, Instant};

    use crate::{Action, FnBinding, FnBindings, FnKey, Hint, Machine, Matcher, Mode, RawEvent};
    use Action::*;
    use Mode::*;

    const FN: u16 = 63;
    const FN_FLAG: u64 = 0x80_0000;
    const SPACE: u16 = 49;
    const SHIFT_L: u16 = 56;
    const SHIFT_L_FLAGS: u64 = 0x2 | 0x2_0000;

    struct Keyboard {
        matcher: Matcher,
        machine: Machine,
        t0: Instant,
        fn_down: bool,
        shift: bool,
        /// Every action so far, and whether each event would be swallowed by an active tap.
        actions: Vec<Action>,
        swallowed: Vec<bool>,
    }

    impl Keyboard {
        fn new() -> Self {
            let bindings = FnBindings {
                dictate: Some(FnBinding::Fn),
                ask: Some(FnBinding::FnPlus(FnKey::Space)),
                translate: Some(FnBinding::FnPlus(FnKey::ShiftLeft)),
            };
            Self { matcher: Matcher::new(bindings), machine: Machine::default(), t0: Instant::now(), fn_down: false, shift: false, actions: vec![], swallowed: vec![] }
        }
        fn flags(&self) -> u64 {
            (if self.fn_down { FN_FLAG } else { 0 }) | (if self.shift { SHIFT_L_FLAGS } else { 0 })
        }
        fn send(&mut self, ms: u64, ev: RawEvent) -> Vec<Action> {
            let now = self.t0 + Duration::from_millis(ms);
            let out = self.matcher.feed(ev, self.machine.is_recording());
            self.swallowed.push(out.consume);
            let mut actions = self.machine.tick(now);
            for input in out.inputs {
                actions.extend(self.machine.handle(input, now));
            }
            self.matcher.set_bare_switch(self.machine.bare_switch());
            self.actions.extend(actions.iter().cloned());
            actions
        }
        fn fn_key(&mut self, ms: u64, down: bool) -> Vec<Action> {
            self.fn_down = down;
            let flags = self.flags();
            self.send(ms, RawEvent::FlagsChanged { keycode: FN, flags })
        }
        fn space(&mut self, ms: u64, down: bool) -> Vec<Action> {
            self.send(ms, if down { RawEvent::KeyDown { keycode: SPACE, repeat: false } } else { RawEvent::KeyUp { keycode: SPACE } })
        }
        fn shift(&mut self, ms: u64, down: bool) -> Vec<Action> {
            self.shift = down;
            let flags = self.flags();
            self.send(ms, RawEvent::FlagsChanged { keycode: SHIFT_L, flags })
        }
        fn tap_fn(&mut self, ms: u64) -> Vec<Action> {
            let mut a = self.fn_key(ms, true);
            a.extend(self.fn_key(ms + 60, false));
            a
        }
    }

    #[test]
    fn fn_plus_space_starts_ask_and_fn_alone_finishes_it() {
        let mut k = Keyboard::new();
        assert_eq!(k.fn_key(0, true), [Start(Dictate)]);
        assert_eq!(k.space(50, true), [Switch { mode: Ask, hands_free: false }]);
        k.space(120, false);
        k.fn_key(140, false);
        assert!(k.machine.is_recording());
        assert_eq!(k.tap_fn(4_000), [Stop(Ask)]);
        assert!(k.machine.is_idle());
        assert!(k.swallowed[1] && k.swallowed[2], "the Space of Fn+Space is swallowed, press and release");
    }

    #[test]
    fn the_whole_combo_again_finishes_ask_and_starts_nothing() {
        let mut k = Keyboard::new();
        k.fn_key(0, true);
        k.space(40, true);
        k.space(100, false);
        k.fn_key(120, false);
        assert_eq!(k.fn_key(3_000, true), [Stop(Ask)]);
        assert_eq!(k.space(3_040, true), [Hint(Hint::FinishWithFn)]);
        k.space(3_100, false);
        assert!(k.fn_key(3_120, false).is_empty());
        assert!(k.machine.is_idle());
        assert_eq!(k.actions.iter().filter(|a| matches!(a, Start(_))).count(), 1);
    }

    #[test]
    fn hands_free_then_space_alone_switches_to_ask() {
        let mut k = Keyboard::new();
        k.tap_fn(0);
        assert_eq!(k.fn_key(150, true), [Switch { mode: Dictate, hands_free: true }]);
        k.fn_key(210, false);
        let before = k.swallowed.len();
        assert_eq!(k.space(2_000, true), [Switch { mode: Ask, hands_free: false }]);
        k.space(2_080, false);
        assert!(k.swallowed[before] && k.swallowed[before + 1], "swallowed with an active tap");
        // A later space is typed as usual.
        assert!(k.space(2_500, true).is_empty() && !k.swallowed.last().unwrap());
        k.space(2_560, false);
        assert_eq!(k.tap_fn(6_000), [Stop(Ask)], "Fn finishes; the run is Ask");
    }

    #[test]
    fn hands_free_then_left_shift_alone_switches_to_translate() {
        let mut k = Keyboard::new();
        k.tap_fn(0);
        k.tap_fn(150);
        assert_eq!(k.shift(2_000, true), [Switch { mode: Translate, hands_free: true }]);
        k.shift(2_090, false);
        assert!(k.shift(2_500, true).is_empty(), "only once");
        k.shift(2_560, false);
        assert_eq!(k.tap_fn(5_000), [Stop(Translate)]);
    }

    #[test]
    fn translate_press_to_start_and_fn_alone_to_finish() {
        let mut k = Keyboard::new();
        k.fn_key(0, true);
        assert_eq!(k.shift(30, true), [Switch { mode: Translate, hands_free: false }]);
        assert_eq!(k.shift(120, false), [Switch { mode: Translate, hands_free: true }]);
        k.fn_key(140, false);
        assert!(k.machine.is_recording());
        assert_eq!(k.tap_fn(3_000), [Stop(Translate)]);
        assert!(k.machine.is_idle());
    }

    #[test]
    fn translate_held_finishes_on_release() {
        let mut k = Keyboard::new();
        k.fn_key(0, true);
        k.shift(30, true);
        assert_eq!(k.shift(2_000, false), [Stop(Translate)]);
        assert!(k.fn_key(2_020, false).is_empty());
        assert!(k.machine.is_idle());
    }
}
