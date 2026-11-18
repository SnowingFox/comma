//! The shortcut state machine (spec 2.1 to 2.3), independent of where the key events come from.
//!
//! Inputs are whole shortcuts, not keys: `Down(Dictate)` means "the Dictate shortcut is now held".
//! The Fn matcher ([`crate::binding::Matcher`]) and the ordinary global shortcuts both produce them.
//!
//! - Dictate and Translate are held: release ends the recording.
//! - Ask Anything is pressed once to start and once more to stop.
//! - While Dictate is held, the Ask or Translate shortcut switches the running recording to that
//!   mode (Fn, then Space or Left Shift while Fn stays down).
//! - A hold released within `double_press` of its start waits for a second press: pressed again
//!   in time, the recording locks hands-free and the next press ends it; otherwise it was a stray
//!   tap and is cancelled.
//! - Esc cancels in every recording state. A stray key shortly after the start (Fn+Delete,
//!   Fn+arrow) cancels too, since the user meant that key, not dictation.

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Dictate,
    Ask,
    Translate,
}

impl Mode {
    /// Held modes end on release; Ask Anything toggles.
    pub fn is_hold(self) -> bool {
        self != Mode::Ask
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Input {
    /// The mode's whole shortcut became held.
    Down(Mode),
    /// The mode's shortcut is no longer fully held.
    Up(Mode),
    Escape,
    /// Some key that is not part of any shortcut went down while one was held. Which key is never
    /// known here.
    OtherKey,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hint {
    /// Ask Anything was held like Dictate; it only needs a press.
    AskHold,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// Start recording in this mode.
    Start(Mode),
    /// The running recording changed mode, or locked hands-free.
    Switch { mode: Mode, hands_free: bool },
    /// Stop recording and run the pipeline.
    Stop(Mode),
    /// Drop the recording; nothing is run or inserted.
    Cancel(Mode),
    Hint(Hint),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Config {
    /// A release this soon after the start waits this long for a second press (spec: 300 ms).
    pub double_press: Duration,
    /// A stray key within this time of the start cancels the recording.
    pub stray_key_window: Duration,
    /// Ask Anything released after being held at least this long shows [`Hint::AskHold`].
    pub ask_hold_hint: Duration,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            double_press: Duration::from_millis(300),
            stray_key_window: Duration::from_secs(1),
            ask_hold_hint: Duration::from_millis(800),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Idle,
    /// A hold mode, keys down.
    Holding { mode: Mode, started: Instant },
    /// A short hold was released; a second press before `deadline` locks hands-free.
    Pending { mode: Mode, deadline: Instant },
    /// Locked after a double press; the next press of `mode` stops.
    HandsFree { mode: Mode },
    /// Ask Anything. `pressed` is when its shortcut last went down and is still held.
    Toggle { pressed: Option<Instant>, hinted: bool },
}

#[derive(Debug, Clone)]
pub struct Machine {
    cfg: Config,
    state: State,
}

impl Machine {
    pub fn new(cfg: Config) -> Self {
        Self { cfg, state: State::Idle }
    }

    /// Feeds one input at `now`. An expired double-press wait is resolved first.
    pub fn handle(&mut self, input: Input, now: Instant) -> Vec<Action> {
        let mut out = self.tick(now);
        out.extend(self.step(input, now));
        out
    }

    /// Resolves an expired double-press wait. Call it at [`Machine::deadline`].
    pub fn tick(&mut self, now: Instant) -> Vec<Action> {
        match self.state {
            State::Pending { mode, deadline } if now >= deadline => {
                self.state = State::Idle;
                vec![Action::Cancel(mode)]
            }
            _ => Vec::new(),
        }
    }

    /// When [`Machine::tick`] has something to do.
    pub fn deadline(&self) -> Option<Instant> {
        match self.state {
            State::Pending { deadline, .. } => Some(deadline),
            _ => None,
        }
    }

    pub fn is_recording(&self) -> bool {
        self.state != State::Idle
    }

    /// The mode being recorded.
    pub fn mode(&self) -> Option<Mode> {
        match self.state {
            State::Idle => None,
            State::Holding { mode, .. } | State::Pending { mode, .. } | State::HandsFree { mode } => Some(mode),
            State::Toggle { .. } => Some(Mode::Ask),
        }
    }

    /// Back to idle without any action (the run was cancelled elsewhere).
    pub fn reset(&mut self) {
        self.state = State::Idle;
    }

    fn step(&mut self, input: Input, now: Instant) -> Vec<Action> {
        use Input::*;
        let current = self.mode();
        let (next, actions) = match (self.state, input) {
            (State::Idle, Down(Mode::Ask)) => (State::Toggle { pressed: Some(now), hinted: false }, vec![Action::Start(Mode::Ask)]),
            (State::Idle, Down(mode)) => (State::Holding { mode, started: now }, vec![Action::Start(mode)]),
            (State::Idle, _) => (State::Idle, vec![]),

            (_, Escape) => (State::Idle, current.map(Action::Cancel).into_iter().collect()),

            (State::Holding { .. }, Down(Mode::Ask)) => (
                State::Toggle { pressed: Some(now), hinted: false },
                vec![Action::Switch { mode: Mode::Ask, hands_free: false }],
            ),
            (State::Holding { mode: Mode::Dictate, started }, Down(Mode::Translate)) => (
                State::Holding { mode: Mode::Translate, started },
                vec![Action::Switch { mode: Mode::Translate, hands_free: false }],
            ),
            (State::Holding { mode, started }, Up(up)) if up == mode => {
                if now.saturating_duration_since(started) < self.cfg.double_press {
                    (State::Pending { mode, deadline: now + self.cfg.double_press }, vec![])
                } else {
                    (State::Idle, vec![Action::Stop(mode)])
                }
            }
            (State::Holding { mode, started }, OtherKey) if now.saturating_duration_since(started) < self.cfg.stray_key_window => {
                (State::Idle, vec![Action::Cancel(mode)])
            }

            (State::Pending { mode, .. }, Down(down)) if down == mode => {
                (State::HandsFree { mode }, vec![Action::Switch { mode, hands_free: true }])
            }

            (State::HandsFree { mode }, Down(down)) if down == mode => (State::Idle, vec![Action::Stop(mode)]),

            (State::Toggle { .. }, Down(Mode::Ask)) => (State::Idle, vec![Action::Stop(Mode::Ask)]),
            (State::Toggle { pressed: Some(at), hinted }, Up(Mode::Ask)) => {
                let long = now.saturating_duration_since(at) >= self.cfg.ask_hold_hint;
                let hint = long && !hinted;
                (State::Toggle { pressed: None, hinted: hinted || hint }, if hint { vec![Action::Hint(Hint::AskHold)] } else { vec![] })
            }

            (state, _) => (state, vec![]),
        };
        self.state = next;
        actions
    }
}

impl Default for Machine {
    fn default() -> Self {
        Self::new(Config::default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use Action::*;
    use Input::*;
    use Mode::*;

    /// A machine and a clock that only moves when told.
    struct Run {
        m: Machine,
        t0: Instant,
        now: Instant,
    }

    impl Run {
        fn new() -> Self {
            let t0 = Instant::now();
            Self { m: Machine::default(), t0, now: t0 }
        }
        fn at(&mut self, ms: u64) -> &mut Self {
            self.now = self.t0 + Duration::from_millis(ms);
            self
        }
        fn feed(&mut self, ms: u64, input: Input) -> Vec<Action> {
            self.at(ms);
            self.m.handle(input, self.now)
        }
        fn tick(&mut self, ms: u64) -> Vec<Action> {
            self.at(ms);
            self.m.tick(self.now)
        }
    }

    #[test]
    fn hold_and_release() {
        let mut r = Run::new();
        assert_eq!(r.feed(0, Down(Dictate)), [Start(Dictate)]);
        assert!(r.m.is_recording());
        assert_eq!(r.m.mode(), Some(Dictate));
        assert_eq!(r.feed(2_000, Up(Dictate)), [Stop(Dictate)]);
        assert!(!r.m.is_recording());
        assert_eq!(r.m.deadline(), None);
    }

    #[test]
    fn translate_holds_too() {
        let mut r = Run::new();
        assert_eq!(r.feed(0, Down(Translate)), [Start(Translate)]);
        assert_eq!(r.feed(900, Up(Translate)), [Stop(Translate)]);
    }

    #[test]
    fn releases_of_other_modes_are_ignored() {
        let mut r = Run::new();
        r.feed(0, Down(Dictate));
        assert!(r.feed(500, Up(Translate)).is_empty());
        assert!(r.feed(600, Up(Ask)).is_empty());
        assert_eq!(r.feed(700, Up(Dictate)), [Stop(Dictate)]);
    }

    #[test]
    fn double_press_locks_hands_free_and_the_next_press_stops() {
        let mut r = Run::new();
        assert_eq!(r.feed(0, Down(Dictate)), [Start(Dictate)]);
        assert!(r.feed(120, Up(Dictate)).is_empty(), "a short release waits for a second press");
        assert_eq!(r.m.deadline(), Some(r.t0 + Duration::from_millis(420)));
        assert_eq!(r.feed(300, Down(Dictate)), [Switch { mode: Dictate, hands_free: true }]);
        assert_eq!(r.m.deadline(), None);
        assert!(r.feed(380, Up(Dictate)).is_empty(), "release does not stop hands-free");
        assert!(r.feed(5_000, Down(Ask)).is_empty());
        assert_eq!(r.feed(9_000, Down(Dictate)), [Stop(Dictate)]);
        assert!(!r.m.is_recording());
    }

    #[test]
    fn a_short_tap_without_a_second_press_cancels() {
        let mut r = Run::new();
        r.feed(0, Down(Dictate));
        assert!(r.feed(100, Up(Dictate)).is_empty());
        assert!(r.tick(399).is_empty());
        assert_eq!(r.tick(400), [Cancel(Dictate)]);
        assert!(!r.m.is_recording());
    }

    #[test]
    fn a_late_second_press_starts_a_new_recording() {
        let mut r = Run::new();
        r.feed(0, Down(Dictate));
        r.feed(100, Up(Dictate));
        // The wait expired before this press arrived: the tap is cancelled, then a fresh start.
        assert_eq!(r.feed(450, Down(Dictate)), [Cancel(Dictate), Start(Dictate)]);
    }

    #[test]
    fn escape_cancels_in_every_recording_state() {
        let mut r = Run::new();
        r.feed(0, Down(Dictate));
        assert_eq!(r.feed(50, Escape), [Cancel(Dictate)]);

        r.feed(1_000, Down(Dictate));
        r.feed(1_100, Up(Dictate));
        assert_eq!(r.feed(1_200, Escape), [Cancel(Dictate)], "while waiting for the second press");

        r.feed(2_000, Down(Dictate));
        r.feed(2_100, Up(Dictate));
        r.feed(2_200, Down(Dictate));
        assert_eq!(r.feed(4_000, Escape), [Cancel(Dictate)], "hands-free");

        r.feed(5_000, Down(Ask));
        assert_eq!(r.feed(6_000, Escape), [Cancel(Ask)]);

        assert!(r.feed(7_000, Escape).is_empty(), "idle");
    }

    #[test]
    fn ask_toggles() {
        let mut r = Run::new();
        assert_eq!(r.feed(0, Down(Ask)), [Start(Ask)]);
        assert!(r.feed(200, Up(Ask)).is_empty(), "release does not stop Ask");
        assert!(r.feed(3_000, Down(Dictate)).is_empty(), "Fn before Space does not stop Ask");
        assert!(r.feed(3_050, Up(Dictate)).is_empty());
        assert_eq!(r.feed(3_100, Down(Ask)), [Stop(Ask)]);
    }

    #[test]
    fn dictate_switches_to_ask() {
        let mut r = Run::new();
        assert_eq!(r.feed(0, Down(Dictate)), [Start(Dictate)]);
        assert_eq!(r.feed(150, Down(Ask)), [Switch { mode: Ask, hands_free: false }]);
        assert_eq!(r.m.mode(), Some(Ask));
        assert!(r.feed(300, Up(Ask)).is_empty());
        assert!(r.feed(320, Up(Dictate)).is_empty(), "releasing Fn does not stop Ask");
        assert!(r.m.is_recording());
        r.feed(4_000, Down(Dictate));
        assert_eq!(r.feed(4_050, Down(Ask)), [Stop(Ask)]);
    }

    #[test]
    fn dictate_switches_to_translate_and_stops_on_its_release() {
        let mut r = Run::new();
        r.feed(0, Down(Dictate));
        assert_eq!(r.feed(200, Down(Translate)), [Switch { mode: Translate, hands_free: false }]);
        assert!(r.feed(2_000, Up(Dictate)).is_empty(), "Fn's own release is covered by Translate's");
        assert!(r.m.is_recording());
        let mut r = Run::new();
        r.feed(0, Down(Dictate));
        r.feed(200, Down(Translate));
        assert_eq!(r.feed(2_500, Up(Translate)), [Stop(Translate)]);
    }

    #[test]
    fn ask_held_like_dictate_hints_once_and_keeps_recording() {
        let mut r = Run::new();
        r.feed(0, Down(Ask));
        assert_eq!(r.feed(1_200, Up(Ask)), [Hint(super::Hint::AskHold)]);
        assert!(r.m.is_recording());
        assert!(r.feed(1_300, Down(Ask)) == [Stop(Ask)]);

        // Switched from Dictate and held: hint measured from the switch, once per run.
        let mut r = Run::new();
        r.feed(0, Down(Dictate));
        r.feed(100, Down(Ask));
        assert!(r.feed(700, Up(Ask)).is_empty(), "under 800 ms since the switch");
        let mut r = Run::new();
        r.feed(0, Down(Dictate));
        r.feed(100, Down(Ask));
        assert_eq!(r.feed(1_000, Up(Ask)), [Hint(super::Hint::AskHold)]);
        assert!(r.feed(1_000, Up(Ask)).is_empty());
    }

    #[test]
    fn a_stray_key_soon_after_the_start_cancels() {
        let mut r = Run::new();
        r.feed(0, Down(Dictate));
        assert_eq!(r.feed(200, OtherKey), [Cancel(Dictate)]);

        let mut r = Run::new();
        r.feed(0, Down(Dictate));
        assert!(r.feed(1_500, OtherKey).is_empty(), "later keys are ignored");
        assert!(r.m.is_recording());

        let mut r = Run::new();
        r.feed(0, Down(Ask));
        assert!(r.feed(100, OtherKey).is_empty(), "Ask is not held, so typing is fine");
    }

    #[test]
    fn idle_ignores_everything_but_down_and_reset_clears() {
        let mut r = Run::new();
        assert!(r.feed(0, Up(Dictate)).is_empty());
        assert!(r.feed(0, OtherKey).is_empty());
        r.feed(10, Down(Dictate));
        r.m.reset();
        assert!(!r.m.is_recording());
        assert!(r.feed(2_000, Up(Dictate)).is_empty());
    }
}
