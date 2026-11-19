//! The shortcut state machine (spec 2.1 to 2.3.2), independent of where the key events come from.
//!
//! Inputs are whole shortcuts, not keys: `Down(Dictate)` means "the Dictate shortcut is now held".
//! The Fn matcher ([`crate::binding::Matcher`]) and the ordinary global shortcuts both produce them.
//!
//! - Dictate is held: release ends the recording. A hold released within `double_press` of its
//!   start waits for a second press: pressed again in time, the recording locks hands-free and the
//!   next press ends it; otherwise it was a stray tap and is dismissed quietly.
//! - Translate is pressed to start and pressed again to finish; holding it works too (a release
//!   after `double_press` finishes). A second press within `double_press` of the start is a double
//!   tap with nothing said and is dismissed quietly.
//! - Ask Anything is pressed once to start and once more to finish.
//! - Pressing the Dictate shortcut (Fn alone by default) finishes any session that is hands-free,
//!   Ask Anything or Translate, and starts nothing: the rest of that press is ignored until its
//!   release (so Fn, then Space, finishing Ask does not start a new Ask).
//! - Mode switch: while Dictate is held, the Ask or Translate shortcut (Fn, then Space or Left
//!   Shift) turns the running recording into that mode. While Dictate is hands-free, the Ask or
//!   Translate shortcut does the same; the Fn matcher reports a bare Space or Left Shift as that
//!   shortcut then (see [`Machine::bare_switch`]).
//! - Esc cancels in every recording state. A stray key shortly after the start of a hold
//!   (Fn+Delete, Fn+arrow) cancels too, since the user meant that key, not dictation.

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
    /// Modes that can be held to talk (Translate also toggles).
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
    /// Ask Anything was held like Dictate; it only needs a press, and Fn finishes it.
    AskHold,
    /// A session was finished with its whole shortcut (Fn+Space again); Fn alone is enough.
    FinishWithFn,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// Start recording in this mode.
    Start(Mode),
    /// The running recording changed mode, or locked hands-free.
    Switch { mode: Mode, hands_free: bool },
    /// Stop recording and run the pipeline.
    Stop(Mode),
    /// Drop the recording on purpose (Esc, a stray key): nothing is run or inserted.
    Cancel(Mode),
    /// Drop the recording quietly: a tap too short to hold speech, not a deliberate cancel.
    Dismiss(Mode),
    Hint(Hint),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Config {
    /// The tap threshold (spec: 300 ms): a Dictate release this soon waits this long for a second
    /// press; a Translate release this soon keeps recording until the next press.
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
    /// Dictate or Translate, keys down.
    Holding { mode: Mode, started: Instant },
    /// A short Dictate hold was released; a second press before `deadline` locks hands-free.
    Pending { deadline: Instant },
    /// Recording without keys held: Dictate after a double press, Translate after a tap (or a
    /// switch from hands-free Dictate). The next press finishes.
    HandsFree { mode: Mode, started: Instant },
    /// Ask Anything. `pressed` is when its shortcut last went down and is still held.
    Toggle { pressed: Option<Instant>, hinted: bool },
    /// A press finished the session; the rest of it (until `key` comes up) starts nothing. A
    /// `combo` shortcut going down meanwhile means the user pressed the whole combination.
    Draining { key: Mode, combo: Option<Mode> },
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
            State::Pending { deadline } if now >= deadline => {
                self.state = State::Idle;
                vec![Action::Dismiss(Mode::Dictate)]
            }
            _ => Vec::new(),
        }
    }

    /// When [`Machine::tick`] has something to do.
    pub fn deadline(&self) -> Option<Instant> {
        match self.state {
            State::Pending { deadline } => Some(deadline),
            _ => None,
        }
    }

    pub fn is_recording(&self) -> bool {
        self.mode().is_some()
    }

    /// Nothing is recording and no press is being finished.
    pub fn is_idle(&self) -> bool {
        self.state == State::Idle
    }

    /// The mode being recorded.
    pub fn mode(&self) -> Option<Mode> {
        match self.state {
            State::Idle | State::Draining { .. } => None,
            State::Pending { .. } => Some(Mode::Dictate),
            State::Holding { mode, .. } | State::HandsFree { mode, .. } => Some(mode),
            State::Toggle { .. } => Some(Mode::Ask),
        }
    }

    /// Hands-free Dictate: the Ask and Translate trigger keys alone (Space, Left Shift) switch the
    /// mode now, without Fn. The Fn matcher is told so it reports them as those shortcuts.
    pub fn bare_switch(&self) -> bool {
        matches!(self.state, State::HandsFree { mode: Mode::Dictate, .. })
    }

    /// Whether `input` would start a new recording (the dispatcher holds those back while a run is
    /// in flight, but still lets a finishing press drain).
    pub fn would_start(&self, input: Input) -> bool {
        match (self.state, input) {
            (State::Idle, Input::Down(_)) => true,
            (State::Draining { key, .. }, Input::Down(down)) => down == key,
            _ => false,
        }
    }

    /// Back to idle without any action (the run was cancelled elsewhere).
    pub fn reset(&mut self) {
        self.state = State::Idle;
    }

    fn short(&self, since: Instant, now: Instant) -> bool {
        now.saturating_duration_since(since) < self.cfg.double_press
    }

    /// Finishes the session on a press of `key`; the rest of that press is drained.
    fn finish(&mut self, mode: Mode, key: Mode, combo: Option<Mode>) -> (State, Vec<Action>) {
        let mut actions = vec![Action::Stop(mode)];
        if key != Mode::Dictate {
            // The whole combination again: Fn alone would have done.
            actions.push(Action::Hint(Hint::FinishWithFn));
        }
        (State::Draining { key, combo }, actions)
    }

    fn step(&mut self, input: Input, now: Instant) -> Vec<Action> {
        use Input::*;
        let current = self.mode();
        let (next, actions) = match (self.state, input) {
            (State::Idle, Down(Mode::Ask)) => (State::Toggle { pressed: Some(now), hinted: false }, vec![Action::Start(Mode::Ask)]),
            (State::Idle, Down(mode)) => (State::Holding { mode, started: now }, vec![Action::Start(mode)]),
            (State::Idle, _) => (State::Idle, vec![]),

            (State::Draining { key, .. }, Up(up)) if up == key => (State::Idle, vec![]),
            (State::Draining { key, .. }, Down(down)) if down == key => {
                // Its release never arrived: this is a fresh press.
                self.state = State::Idle;
                return self.step(input, now);
            }
            (State::Draining { key, combo: Some(c) }, Down(down)) if down == c => {
                (State::Draining { key, combo: None }, vec![Action::Hint(Hint::FinishWithFn)])
            }
            (State::Draining { .. }, Escape) => (State::Idle, vec![]),
            (state @ State::Draining { .. }, _) => (state, vec![]),

            (_, Escape) => (State::Idle, current.map(Action::Cancel).into_iter().collect()),

            // Held Dictate or Translate.
            (State::Holding { .. }, Down(Mode::Ask)) => (
                State::Toggle { pressed: Some(now), hinted: false },
                vec![Action::Switch { mode: Mode::Ask, hands_free: false }],
            ),
            (State::Holding { mode: Mode::Dictate, started }, Down(Mode::Translate)) => (
                State::Holding { mode: Mode::Translate, started },
                vec![Action::Switch { mode: Mode::Translate, hands_free: false }],
            ),
            (State::Holding { mode, started }, Up(up)) if up == mode => match mode {
                _ if !self.short(started, now) => (State::Idle, vec![Action::Stop(mode)]),
                Mode::Translate => (
                    State::HandsFree { mode, started },
                    vec![Action::Switch { mode, hands_free: true }],
                ),
                _ => (State::Pending { deadline: now + self.cfg.double_press }, vec![]),
            },
            (State::Holding { mode, started }, OtherKey) if now.saturating_duration_since(started) < self.cfg.stray_key_window => {
                (State::Idle, vec![Action::Cancel(mode)])
            }

            (State::Pending { .. }, Down(Mode::Dictate)) => (
                State::HandsFree { mode: Mode::Dictate, started: now },
                vec![Action::Switch { mode: Mode::Dictate, hands_free: true }],
            ),

            // Hands-free Dictate: the next press finishes, Space or Left Shift switches.
            (State::HandsFree { mode: Mode::Dictate, .. }, Down(Mode::Dictate)) => self.finish(Mode::Dictate, Mode::Dictate, None),
            (State::HandsFree { mode: Mode::Dictate, .. }, Down(Mode::Ask)) => (
                State::Toggle { pressed: None, hinted: false },
                vec![Action::Switch { mode: Mode::Ask, hands_free: false }],
            ),
            (State::HandsFree { mode: Mode::Dictate, .. }, Down(Mode::Translate)) => (
                State::HandsFree { mode: Mode::Translate, started: now },
                vec![Action::Switch { mode: Mode::Translate, hands_free: true }],
            ),

            // Translate without keys held: Fn alone or the Translate shortcut finishes.
            (State::HandsFree { mode: Mode::Translate, .. }, Down(Mode::Dictate)) => {
                self.finish(Mode::Translate, Mode::Dictate, Some(Mode::Translate))
            }
            (State::HandsFree { mode: Mode::Translate, started }, Down(Mode::Translate)) => {
                if self.short(started, now) {
                    (State::Draining { key: Mode::Translate, combo: None }, vec![Action::Dismiss(Mode::Translate)])
                } else {
                    self.finish(Mode::Translate, Mode::Translate, None)
                }
            }

            // Ask Anything: Fn alone or the Ask shortcut finishes.
            (State::Toggle { .. }, Down(Mode::Dictate)) => self.finish(Mode::Ask, Mode::Dictate, Some(Mode::Ask)),
            (State::Toggle { .. }, Down(Mode::Ask)) => self.finish(Mode::Ask, Mode::Ask, None),
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

    const FINISH_HINT: Action = Action::Hint(super::Hint::FinishWithFn);

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
        /// Fn pressed twice quickly: hands-free Dictate.
        fn hands_free(&mut self, at: u64) {
            assert_eq!(self.feed(at, Down(Dictate)), [Start(Dictate)]);
            assert!(self.feed(at + 80, Up(Dictate)).is_empty());
            assert_eq!(self.feed(at + 160, Down(Dictate)), [Switch { mode: Dictate, hands_free: true }]);
            assert!(self.feed(at + 240, Up(Dictate)).is_empty());
            assert!(self.m.bare_switch());
        }
    }

    // ---- Dictate (spec 2.3.2 row 1) ----------------------------------------------------------------

    #[test]
    fn hold_and_release() {
        let mut r = Run::new();
        assert_eq!(r.feed(0, Down(Dictate)), [Start(Dictate)]);
        assert!(r.m.is_recording());
        assert_eq!(r.m.mode(), Some(Dictate));
        assert_eq!(r.feed(2_000, Up(Dictate)), [Stop(Dictate)]);
        assert!(!r.m.is_recording() && r.m.is_idle());
        assert_eq!(r.m.deadline(), None);
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
        assert_eq!(r.feed(9_000, Down(Dictate)), [Stop(Dictate)]);
        assert!(!r.m.is_recording() && !r.m.bare_switch());
        assert!(r.feed(9_100, Up(Dictate)).is_empty(), "the finishing press ends quietly");
        assert!(r.m.is_idle());
    }

    /// The 300 ms tap threshold, on both sides.
    #[test]
    fn the_tap_threshold_is_300_ms() {
        let mut r = Run::new();
        r.feed(0, Down(Dictate));
        assert!(r.feed(299, Up(Dictate)).is_empty(), "299 ms is a tap");
        assert_eq!(r.tick(599), [Dismiss(Dictate)], "no second press: dropped quietly, never run");

        let mut r = Run::new();
        r.feed(0, Down(Dictate));
        assert_eq!(r.feed(300, Up(Dictate)), [Stop(Dictate)], "300 ms is a hold");

        let mut r = Run::new();
        r.feed(0, Down(Dictate));
        r.feed(100, Up(Dictate));
        assert!(r.tick(399).is_empty(), "still waiting at 299 ms after the release");
        assert_eq!(r.tick(400), [Dismiss(Dictate)]);
        assert!(r.m.is_idle());
    }

    #[test]
    fn a_late_second_press_starts_a_new_recording() {
        let mut r = Run::new();
        r.feed(0, Down(Dictate));
        r.feed(100, Up(Dictate));
        // The wait expired before this press arrived: the tap is dropped, then a fresh start.
        assert_eq!(r.feed(450, Down(Dictate)), [Dismiss(Dictate), Start(Dictate)]);
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

        let mut r = Run::new();
        r.hands_free(0);
        assert!(r.feed(500, OtherKey).is_empty(), "hands-free is not held either");
    }

    // ---- Ask Anything (row 2) ------------------------------------------------------------------

    #[test]
    fn ask_presses_to_start_and_again_to_finish() {
        let mut r = Run::new();
        assert_eq!(r.feed(0, Down(Ask)), [Start(Ask)]);
        assert!(r.feed(80, Up(Ask)).is_empty(), "release does not stop Ask");
        assert!(r.tick(2_000).is_empty());
        assert_eq!(r.feed(3_000, Down(Ask)), [Stop(Ask), FINISH_HINT], "the whole shortcut again: Fn alone would do");
        assert!(r.feed(3_100, Up(Ask)).is_empty());
        assert!(r.m.is_idle());
    }

    /// Rule 1: Fn alone finishes Ask, and the Space that may follow in the same press starts nothing.
    #[test]
    fn fn_alone_finishes_ask_without_starting_another() {
        let mut r = Run::new();
        r.feed(0, Down(Ask));
        r.feed(100, Up(Ask));
        assert_eq!(r.feed(3_000, Down(Dictate)), [Stop(Ask)]);
        assert!(!r.m.is_recording());
        assert!(r.feed(3_100, Up(Dictate)).is_empty());
        assert!(r.m.is_idle());

        // Fn, then Space (the whole combination): finished on Fn, Space only teaches.
        let mut r = Run::new();
        r.feed(0, Down(Ask));
        r.feed(100, Up(Ask));
        assert_eq!(r.feed(3_000, Down(Dictate)), [Stop(Ask)]);
        assert_eq!(r.feed(3_040, Down(Ask)), [FINISH_HINT], "no new Ask");
        assert!(r.feed(3_100, Up(Ask)).is_empty());
        assert!(r.feed(3_120, Up(Dictate)).is_empty());
        assert!(r.m.is_idle());
        assert_eq!(r.feed(5_000, Down(Dictate)), [Start(Dictate)], "the next press starts again");
    }

    #[test]
    fn ask_held_like_dictate_hints_once_and_keeps_recording() {
        let mut r = Run::new();
        r.feed(0, Down(Ask));
        assert_eq!(r.feed(1_200, Up(Ask)), [Hint(super::Hint::AskHold)]);
        assert!(r.m.is_recording());
        assert_eq!(r.feed(1_300, Down(Dictate)), [Stop(Ask)]);

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
    fn ask_double_press_starts_then_finishes() {
        // Unchanged from before 2.3.2: a second press finishes, however soon.
        let mut r = Run::new();
        r.feed(0, Down(Ask));
        r.feed(60, Up(Ask));
        assert_eq!(r.feed(150, Down(Ask)), [Stop(Ask), FINISH_HINT]);
    }

    // ---- Translate (row 3) ---------------------------------------------------------------------

    #[test]
    fn translate_held_finishes_on_release() {
        let mut r = Run::new();
        assert_eq!(r.feed(0, Down(Translate)), [Start(Translate)]);
        assert_eq!(r.feed(900, Up(Translate)), [Stop(Translate)]);
        assert!(r.m.is_idle());
    }

    #[test]
    fn translate_pressed_keeps_recording_until_the_next_press() {
        let mut r = Run::new();
        assert_eq!(r.feed(0, Down(Translate)), [Start(Translate)]);
        assert_eq!(r.feed(150, Up(Translate)), [Switch { mode: Translate, hands_free: true }], "a press, not a hold");
        assert!(r.tick(5_000).is_empty(), "no deadline: it keeps recording");
        assert_eq!(r.m.mode(), Some(Translate));
        assert!(!r.m.bare_switch(), "only hands-free Dictate switches on bare keys");
        assert_eq!(r.feed(6_000, Down(Translate)), [Stop(Translate), FINISH_HINT]);
        assert!(r.feed(6_100, Up(Translate)).is_empty());
        assert!(r.m.is_idle());
    }

    #[test]
    fn fn_alone_finishes_translate() {
        let mut r = Run::new();
        r.feed(0, Down(Translate));
        r.feed(150, Up(Translate));
        assert_eq!(r.feed(4_000, Down(Dictate)), [Stop(Translate)]);
        assert!(r.feed(4_080, Up(Dictate)).is_empty());
        assert!(r.m.is_idle());

        // Fn, then Left Shift: finished on Fn, no new Translate.
        let mut r = Run::new();
        r.feed(0, Down(Translate));
        r.feed(150, Up(Translate));
        assert_eq!(r.feed(4_000, Down(Dictate)), [Stop(Translate)]);
        assert_eq!(r.feed(4_030, Down(Translate)), [FINISH_HINT]);
        assert!(r.feed(4_050, Down(Translate)).is_empty(), "taught once per press");
        assert!(r.feed(4_100, Up(Translate)).is_empty());
        assert!(r.feed(4_120, Up(Dictate)).is_empty());
        assert!(r.m.is_idle());
    }

    #[test]
    fn translate_double_press_is_dismissed() {
        let mut r = Run::new();
        r.feed(0, Down(Translate));
        r.feed(80, Up(Translate));
        assert_eq!(r.feed(200, Down(Translate)), [Dismiss(Translate)], "nothing was said");
        assert!(r.feed(260, Up(Translate)).is_empty());
        assert!(r.m.is_idle());
        assert_eq!(r.feed(1_000, Down(Translate)), [Start(Translate)]);
    }

    // ---- Esc (row 5) ---------------------------------------------------------------------------

    #[test]
    fn escape_cancels_in_every_recording_state() {
        let mut r = Run::new();
        r.feed(0, Down(Dictate));
        assert_eq!(r.feed(50, Escape), [Cancel(Dictate)], "held");

        r.feed(1_000, Down(Dictate));
        r.feed(1_100, Up(Dictate));
        assert_eq!(r.feed(1_200, Escape), [Cancel(Dictate)], "while waiting for the second press");
        assert_eq!(r.m.deadline(), None);

        r.hands_free(2_000);
        assert_eq!(r.feed(4_000, Escape), [Cancel(Dictate)], "hands-free");

        r.feed(5_000, Down(Ask));
        assert_eq!(r.feed(6_000, Escape), [Cancel(Ask)], "Ask");

        r.feed(7_000, Down(Translate));
        assert_eq!(r.feed(7_500, Escape), [Cancel(Translate)], "Translate held");
        r.feed(8_000, Down(Translate));
        r.feed(8_100, Up(Translate));
        assert_eq!(r.feed(9_000, Escape), [Cancel(Translate)], "Translate pressed");

        r.feed(10_000, Down(Dictate));
        r.feed(10_100, Down(Ask));
        assert_eq!(r.feed(10_200, Escape), [Cancel(Ask)], "after a switch, the current mode");

        assert!(r.feed(11_000, Escape).is_empty(), "idle");
        assert!(r.m.is_idle());
    }

    #[test]
    fn escape_while_finishing_a_press_does_nothing() {
        let mut r = Run::new();
        r.feed(0, Down(Ask));
        r.feed(2_000, Down(Dictate));
        assert!(r.feed(2_050, Escape).is_empty(), "the run is already going; Esc for it is the dispatcher's");
        assert!(r.m.is_idle());
    }

    // ---- Mode switch while recording (2.3.2) ---------------------------------------------------

    #[test]
    fn held_dictate_switches_to_ask() {
        let mut r = Run::new();
        assert_eq!(r.feed(0, Down(Dictate)), [Start(Dictate)]);
        assert_eq!(r.feed(150, Down(Ask)), [Switch { mode: Ask, hands_free: false }]);
        assert_eq!(r.m.mode(), Some(Ask));
        assert!(r.feed(300, Up(Ask)).is_empty());
        assert!(r.feed(320, Up(Dictate)).is_empty(), "releasing Fn does not stop Ask");
        assert!(r.m.is_recording());
        assert_eq!(r.feed(4_000, Down(Dictate)), [Stop(Ask)], "Fn alone finishes, as the run's final mode");
    }

    #[test]
    fn held_dictate_switches_to_translate_and_stops_on_its_release() {
        let mut r = Run::new();
        r.feed(0, Down(Dictate));
        assert_eq!(r.feed(200, Down(Translate)), [Switch { mode: Translate, hands_free: false }]);
        assert!(r.feed(2_000, Up(Dictate)).is_empty(), "Fn's own release is covered by Translate's");
        assert!(r.m.is_recording());
        assert_eq!(r.feed(2_010, Up(Translate)), [Stop(Translate)]);

        let mut r = Run::new();
        r.feed(0, Down(Dictate));
        r.feed(200, Down(Translate));
        assert_eq!(r.feed(2_500, Up(Translate)), [Stop(Translate)]);

        // Fn and Left Shift tapped together: Translate keeps recording until the next press.
        let mut r = Run::new();
        r.feed(0, Down(Dictate));
        r.feed(60, Down(Translate));
        assert_eq!(r.feed(200, Up(Translate)), [Switch { mode: Translate, hands_free: true }]);
        assert!(r.feed(210, Up(Dictate)).is_empty());
        assert_eq!(r.feed(3_000, Down(Dictate)), [Stop(Translate)]);
    }

    #[test]
    fn hands_free_dictate_switches_on_space_or_left_shift() {
        let mut r = Run::new();
        r.hands_free(0);
        assert_eq!(r.feed(2_000, Down(Ask)), [Switch { mode: Ask, hands_free: false }], "Space alone");
        assert!(!r.m.bare_switch(), "only once");
        assert!(r.feed(3_500, Up(Ask)).is_empty(), "no hold hint for a bare Space");
        assert!(r.m.is_recording());
        assert_eq!(r.feed(5_000, Down(Dictate)), [Stop(Ask)]);

        let mut r = Run::new();
        r.hands_free(0);
        assert_eq!(r.feed(2_000, Down(Translate)), [Switch { mode: Translate, hands_free: true }], "Left Shift alone");
        assert!(r.feed(2_100, Up(Translate)).is_empty());
        assert_eq!(r.m.mode(), Some(Translate));
        assert!(!r.m.bare_switch());
        assert_eq!(r.feed(6_000, Down(Dictate)), [Stop(Translate)], "Fn finishes as Translate");
    }

    #[test]
    fn a_switch_does_not_apply_outside_dictate() {
        let mut r = Run::new();
        r.feed(0, Down(Ask));
        assert!(r.feed(500, Down(Translate)).is_empty(), "Ask stays Ask");
        assert_eq!(r.m.mode(), Some(Ask));

        let mut r = Run::new();
        r.feed(0, Down(Dictate));
        r.feed(100, Up(Dictate));
        assert!(r.feed(200, Down(Ask)).is_empty(), "waiting for a second Fn press: not a switch");
        assert_eq!(r.tick(400), [Dismiss(Dictate)]);
    }

    // ---- Robustness ----------------------------------------------------------------------------

    #[test]
    fn a_lost_release_after_finishing_does_not_block_the_next_press() {
        let mut r = Run::new();
        r.feed(0, Down(Ask));
        assert_eq!(r.feed(2_000, Down(Dictate)), [Stop(Ask)]);
        // Fn's release never arrived; the next Fn press is a fresh one.
        assert_eq!(r.feed(9_000, Down(Dictate)), [Start(Dictate)]);
    }

    #[test]
    fn would_start_names_only_new_presses() {
        let mut r = Run::new();
        assert!(r.m.would_start(Down(Dictate)) && !r.m.would_start(Up(Dictate)));
        r.feed(0, Down(Ask));
        assert!(!r.m.would_start(Down(Dictate)), "it finishes");
        r.feed(2_000, Down(Dictate));
        assert!(!r.m.would_start(Down(Ask)), "the rest of the finishing press");
        assert!(r.m.would_start(Down(Dictate)), "a press whose release was lost");
        r.feed(2_100, Up(Dictate));
        assert!(r.m.would_start(Down(Translate)));
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
