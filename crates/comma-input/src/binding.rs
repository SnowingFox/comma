//! Fn-based shortcuts: parsing (`Fn`, `Fn+Space`, `Fn+ShiftLeft`) and the matcher that turns raw
//! keyboard events into shortcut [`Input`]s.
//!
//! PRIVACY RULE. The matcher sees the keyboard events macOS delivers to a listen-only tap. It
//! looks at the Fn key, the configured trigger keys and Esc, and nothing else:
//!
//! - It never stores, logs, returns or transmits any other key. A key that is not a trigger only
//!   becomes the bare [`Input::OtherKey`] when it goes down while Fn is held (so Fn+Delete or
//!   Fn+arrow cancels a recording), and its keycode is dropped on the spot.
//! - It reads only the keycode, the autorepeat flag and the modifier flags, never characters.
//! - Esc is reported only while the caller asks for it (`listen_escape`, during a recording).
//!
//! Fn itself is recognised only from a flags-changed event for the Fn key (keycode 63) and its
//! flag. Arrow keys, F-keys and others carry the same flag on their own events and must not count.

use crate::machine::{Input, Mode};

/// The Fn key (`kVK_Function`).
const FN_KEYCODE: u16 = 63;
/// `kCGEventFlagMaskSecondaryFn`.
const FN_FLAG: u64 = 0x80_0000;
const SPACE_KEYCODE: u16 = 49;
const ESCAPE_KEYCODE: u16 = 53;

/// Keys that can follow `Fn+`, the `FN_KEYS` of `packages/shared/src/ipc/settings.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FnKey {
    Space,
    ShiftLeft,
    ShiftRight,
    ControlLeft,
    ControlRight,
    AltLeft,
    AltRight,
    MetaLeft,
    MetaRight,
}

impl FnKey {
    pub const ALL: [FnKey; 9] = [
        FnKey::Space,
        FnKey::ShiftLeft,
        FnKey::ShiftRight,
        FnKey::ControlLeft,
        FnKey::ControlRight,
        FnKey::AltLeft,
        FnKey::AltRight,
        FnKey::MetaLeft,
        FnKey::MetaRight,
    ];

    pub fn name(self) -> &'static str {
        match self {
            FnKey::Space => "Space",
            FnKey::ShiftLeft => "ShiftLeft",
            FnKey::ShiftRight => "ShiftRight",
            FnKey::ControlLeft => "ControlLeft",
            FnKey::ControlRight => "ControlRight",
            FnKey::AltLeft => "AltLeft",
            FnKey::AltRight => "AltRight",
            FnKey::MetaLeft => "MetaLeft",
            FnKey::MetaRight => "MetaRight",
        }
    }

    fn keycode(self) -> u16 {
        match self {
            FnKey::Space => SPACE_KEYCODE,
            FnKey::ShiftLeft => 56,
            FnKey::ShiftRight => 60,
            FnKey::ControlLeft => 59,
            FnKey::ControlRight => 62,
            FnKey::AltLeft => 58,
            FnKey::AltRight => 61,
            FnKey::MetaLeft => 55,
            FnKey::MetaRight => 54,
        }
    }

    /// The device-dependent flag bit (`NX_DEVICE*KEYMASK`) of a side-specific modifier; `None` for
    /// Space, which comes as key down and up events.
    fn device_bit(self) -> Option<u64> {
        match self {
            FnKey::Space => None,
            FnKey::ShiftLeft => Some(0x2),
            FnKey::ShiftRight => Some(0x4),
            FnKey::ControlLeft => Some(0x1),
            FnKey::ControlRight => Some(0x2000),
            FnKey::AltLeft => Some(0x20),
            FnKey::AltRight => Some(0x40),
            FnKey::MetaLeft => Some(0x8),
            FnKey::MetaRight => Some(0x10),
        }
    }

    fn from_name(name: &str) -> Option<FnKey> {
        FnKey::ALL.into_iter().find(|k| k.name() == name)
    }

    fn from_keycode(keycode: u16) -> Option<FnKey> {
        FnKey::ALL.into_iter().find(|k| k.keycode() == keycode)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FnBinding {
    /// Fn alone.
    Fn,
    /// Fn plus one trigger key.
    FnPlus(FnKey),
}

impl FnBinding {
    /// The key names for `shortcut://keys`: `["Fn"]` or `["Fn", "Space"]`.
    pub fn key_names(&self) -> Vec<&'static str> {
        match self {
            FnBinding::Fn => vec!["Fn"],
            FnBinding::FnPlus(k) => vec!["Fn", k.name()],
        }
    }

    fn trigger(self) -> Option<FnKey> {
        match self {
            FnBinding::Fn => None,
            FnBinding::FnPlus(k) => Some(k),
        }
    }
}

/// `Ok(None)` when `accel` is an ordinary accelerator (`Alt+Space`), `Err` for a malformed Fn one.
pub fn parse_fn(accel: &str) -> Result<Option<FnBinding>, String> {
    let accel = accel.trim();
    if accel == "Fn" {
        return Ok(Some(FnBinding::Fn));
    }
    let Some(rest) = accel.strip_prefix("Fn+") else {
        return Ok(None);
    };
    FnKey::from_name(rest).map(|k| Some(FnBinding::FnPlus(k))).ok_or_else(|| {
        let names: Vec<&str> = FnKey::ALL.iter().map(|k| k.name()).collect();
        format!("Fn can only be combined with one of {}", names.join(", "))
    })
}

/// The Fn-based shortcut of each mode; `None` for modes on an ordinary shortcut.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct FnBindings {
    pub dictate: Option<FnBinding>,
    pub ask: Option<FnBinding>,
    pub translate: Option<FnBinding>,
}

impl FnBindings {
    fn iter(&self) -> impl Iterator<Item = (Mode, FnBinding)> {
        [(Mode::Dictate, self.dictate), (Mode::Ask, self.ask), (Mode::Translate, self.translate)]
            .into_iter()
            .filter_map(|(m, b)| b.map(|b| (m, b)))
    }

    pub fn is_empty(&self) -> bool {
        self.iter().next().is_none()
    }

    fn is_trigger(&self, key: FnKey) -> bool {
        self.iter().any(|(_, b)| b.trigger() == Some(key))
    }
}

/// One event from the tap, reduced to what the matcher may read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RawEvent {
    FlagsChanged { keycode: u16, flags: u64 },
    KeyDown { keycode: u16, repeat: bool },
    KeyUp { keycode: u16 },
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MatcherOutput {
    pub inputs: Vec<Input>,
    /// The configured keys held now, set only when that changed. Lists only `Fn` and trigger keys,
    /// and only while Fn is down.
    pub held: Option<Vec<&'static str>>,
}

impl MatcherOutput {
    pub fn is_empty(&self) -> bool {
        self.inputs.is_empty() && self.held.is_none()
    }
}

/// Raw events to shortcut inputs. State is limited to "Fn is down", which trigger keys are down,
/// and which modes' combinations are currently held.
#[derive(Debug, Clone, Default)]
pub struct Matcher {
    bindings: FnBindings,
    fn_down: bool,
    /// Trigger keys held, only for configured triggers.
    triggers: Vec<FnKey>,
    /// Modes whose combination went down and has not come up.
    active: Vec<Mode>,
    last_held: Vec<&'static str>,
}

impl Matcher {
    pub fn new(bindings: FnBindings) -> Self {
        Self { bindings, ..Self::default() }
    }

    /// New bindings. Held state is dropped so nothing stays half pressed.
    pub fn set_bindings(&mut self, bindings: FnBindings) {
        *self = Self::new(bindings);
    }

    pub fn feed(&mut self, ev: RawEvent, listen_escape: bool) -> MatcherOutput {
        let mut inputs = Vec::new();
        match ev {
            RawEvent::FlagsChanged { keycode: FN_KEYCODE, flags } => {
                let down = flags & FN_FLAG != 0;
                if down && !self.fn_down {
                    self.fn_down = true;
                    self.on_fn_down(&mut inputs);
                } else if !down && self.fn_down {
                    self.fn_down = false;
                    for mode in std::mem::take(&mut self.active) {
                        inputs.push(Input::Up(mode));
                    }
                }
            }
            RawEvent::FlagsChanged { keycode, flags } => {
                if let Some(key) = FnKey::from_keycode(keycode).filter(|k| self.bindings.is_trigger(*k))
                    && let Some(bit) = key.device_bit()
                {
                    self.on_trigger(key, flags & bit != 0, &mut inputs);
                }
            }
            RawEvent::KeyDown { keycode: SPACE_KEYCODE, repeat } if self.bindings.is_trigger(FnKey::Space) => {
                if !repeat {
                    self.on_trigger(FnKey::Space, true, &mut inputs);
                }
            }
            RawEvent::KeyUp { keycode: SPACE_KEYCODE } if self.bindings.is_trigger(FnKey::Space) => {
                self.on_trigger(FnKey::Space, false, &mut inputs);
            }
            RawEvent::KeyDown { keycode: ESCAPE_KEYCODE, .. } if listen_escape => inputs.push(Input::Escape),
            RawEvent::KeyDown { repeat, .. } => {
                // Not a trigger: only "some key" while Fn is held, the keycode is not kept.
                if self.fn_down && !repeat {
                    inputs.push(Input::OtherKey);
                }
            }
            RawEvent::KeyUp { .. } => {}
        }
        let held = self.held_keys();
        let held = (held != self.last_held).then(|| {
            self.last_held = held.clone();
            held
        });
        MatcherOutput { inputs, held }
    }

    fn on_fn_down(&mut self, inputs: &mut Vec<Input>) {
        // A trigger already held (Left Shift, then Fn) selects its mode instead of Fn alone.
        let with_trigger = self
            .bindings
            .iter()
            .find(|(_, b)| b.trigger().is_some_and(|k| self.triggers.contains(&k)));
        let chosen = with_trigger.or_else(|| self.bindings.iter().find(|(_, b)| *b == FnBinding::Fn));
        if let Some((mode, _)) = chosen {
            self.active.push(mode);
            inputs.push(Input::Down(mode));
        }
    }

    fn on_trigger(&mut self, key: FnKey, down: bool, inputs: &mut Vec<Input>) {
        let was = self.triggers.contains(&key);
        if down == was {
            return;
        }
        if down {
            self.triggers.push(key);
        } else {
            self.triggers.retain(|k| *k != key);
        }
        let modes: Vec<Mode> = self.bindings.iter().filter(|(_, b)| b.trigger() == Some(key)).map(|(m, _)| m).collect();
        for mode in modes {
            let active = self.active.contains(&mode);
            if down && self.fn_down && !active {
                self.active.push(mode);
                inputs.push(Input::Down(mode));
            } else if !down && active {
                self.active.retain(|m| *m != mode);
                inputs.push(Input::Up(mode));
            }
        }
    }

    fn held_keys(&self) -> Vec<&'static str> {
        if !self.fn_down || self.bindings.is_empty() {
            return Vec::new();
        }
        let mut held = vec!["Fn"];
        held.extend(FnKey::ALL.iter().filter(|k| self.triggers.contains(k)).map(|k| k.name()));
        held
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use Input::*;
    use Mode::*;

    const SHIFT_L: u16 = 56;
    /// Device bit plus the generic Shift flag, as macOS sends it.
    const SHIFT_L_FLAGS: u64 = 0x2 | 0x2_0000;
    const LEFT_ARROW: u16 = 123;
    const DELETE_FORWARD: u16 = 117;

    fn defaults() -> Matcher {
        Matcher::new(FnBindings {
            dictate: Some(FnBinding::Fn),
            ask: Some(FnBinding::FnPlus(FnKey::Space)),
            translate: Some(FnBinding::FnPlus(FnKey::ShiftLeft)),
        })
    }

    fn fn_down() -> RawEvent {
        RawEvent::FlagsChanged { keycode: FN_KEYCODE, flags: FN_FLAG | 0x100 }
    }

    fn fn_up() -> RawEvent {
        RawEvent::FlagsChanged { keycode: FN_KEYCODE, flags: 0x100 }
    }

    fn inputs(m: &mut Matcher, ev: RawEvent) -> Vec<Input> {
        m.feed(ev, false).inputs
    }

    #[test]
    fn parses_fn_bindings() {
        assert_eq!(parse_fn("Fn"), Ok(Some(FnBinding::Fn)));
        assert_eq!(parse_fn("Fn+Space"), Ok(Some(FnBinding::FnPlus(FnKey::Space))));
        assert_eq!(parse_fn("Fn+ShiftLeft"), Ok(Some(FnBinding::FnPlus(FnKey::ShiftLeft))));
        assert_eq!(parse_fn("Alt+Space"), Ok(None));
        assert_eq!(parse_fn("Function"), Ok(None));
        assert!(parse_fn("Fn+Q").unwrap_err().contains("ShiftLeft"));
        assert!(parse_fn("Fn+Space+ShiftLeft").is_err());
        assert_eq!(FnBinding::FnPlus(FnKey::Space).key_names(), ["Fn", "Space"]);
        assert_eq!(FnBinding::Fn.key_names(), ["Fn"]);
    }

    #[test]
    fn fn_alone() {
        let mut m = defaults();
        let out = m.feed(fn_down(), false);
        assert_eq!(out.inputs, [Down(Dictate)]);
        assert_eq!(out.held.as_deref(), Some(&["Fn"][..]));
        let out = m.feed(fn_up(), false);
        assert_eq!(out.inputs, [Up(Dictate)]);
        assert_eq!(out.held.as_deref(), Some(&[][..]));
    }

    #[test]
    fn fn_then_space() {
        let mut m = defaults();
        assert_eq!(inputs(&mut m, fn_down()), [Down(Dictate)]);
        let out = m.feed(RawEvent::KeyDown { keycode: SPACE_KEYCODE, repeat: false }, false);
        assert_eq!(out.inputs, [Down(Ask)]);
        assert_eq!(out.held.as_deref(), Some(&["Fn", "Space"][..]));
        assert!(inputs(&mut m, RawEvent::KeyDown { keycode: SPACE_KEYCODE, repeat: true }).is_empty(), "repeats are ignored");
        assert_eq!(inputs(&mut m, RawEvent::KeyUp { keycode: SPACE_KEYCODE }), [Up(Ask)]);
        assert_eq!(inputs(&mut m, fn_up()), [Up(Dictate)]);
    }

    #[test]
    fn space_without_fn_is_not_a_shortcut() {
        let mut m = defaults();
        let out = m.feed(RawEvent::KeyDown { keycode: SPACE_KEYCODE, repeat: false }, false);
        assert!(out.is_empty(), "typing a space reports nothing");
        assert!(m.feed(RawEvent::KeyUp { keycode: SPACE_KEYCODE }, false).is_empty());
    }

    #[test]
    fn fn_then_left_shift() {
        let mut m = defaults();
        assert_eq!(inputs(&mut m, fn_down()), [Down(Dictate)]);
        let shift_down = RawEvent::FlagsChanged { keycode: SHIFT_L, flags: FN_FLAG | SHIFT_L_FLAGS };
        assert_eq!(inputs(&mut m, shift_down), [Down(Translate)]);
        let shift_up = RawEvent::FlagsChanged { keycode: SHIFT_L, flags: FN_FLAG };
        assert_eq!(inputs(&mut m, shift_up), [Up(Translate)]);
        assert_eq!(inputs(&mut m, fn_up()), [Up(Dictate)]);
    }

    #[test]
    fn left_shift_then_fn_selects_translate() {
        let mut m = defaults();
        let shift_down = RawEvent::FlagsChanged { keycode: SHIFT_L, flags: SHIFT_L_FLAGS };
        assert!(m.feed(shift_down, false).is_empty(), "Shift alone reports nothing");
        let out = m.feed(RawEvent::FlagsChanged { keycode: FN_KEYCODE, flags: FN_FLAG | SHIFT_L_FLAGS }, false);
        assert_eq!(out.inputs, [Down(Translate)]);
        assert_eq!(out.held.as_deref(), Some(&["Fn", "ShiftLeft"][..]));
        assert_eq!(inputs(&mut m, RawEvent::FlagsChanged { keycode: FN_KEYCODE, flags: SHIFT_L_FLAGS }), [Up(Translate)]);
    }

    #[test]
    fn right_shift_is_not_left_shift() {
        let mut m = defaults();
        m.feed(fn_down(), false);
        // Right Shift: keycode 60, device bit 0x4.
        assert_eq!(inputs(&mut m, RawEvent::FlagsChanged { keycode: 60, flags: FN_FLAG | 0x4 | 0x2_0000 }), [] as [Input; 0]);
    }

    #[test]
    fn arrow_keys_with_the_fn_flag_are_not_fn() {
        let mut m = defaults();
        // Arrow and F keys carry the SecondaryFn flag on their own events.
        assert!(m.feed(RawEvent::FlagsChanged { keycode: LEFT_ARROW, flags: FN_FLAG }, false).is_empty());
        assert!(m.feed(RawEvent::KeyDown { keycode: LEFT_ARROW, repeat: false }, false).is_empty());
        assert!(m.feed(RawEvent::KeyUp { keycode: LEFT_ARROW }, false).is_empty());
    }

    #[test]
    fn other_keys_while_fn_is_held_are_anonymous() {
        let mut m = defaults();
        m.feed(fn_down(), false);
        let out = m.feed(RawEvent::KeyDown { keycode: DELETE_FORWARD, repeat: false }, false);
        assert_eq!(out.inputs, [OtherKey]);
        assert_eq!(out.held, None);
        assert!(m.feed(RawEvent::KeyUp { keycode: DELETE_FORWARD }, false).is_empty());
        // Nothing about that key is kept.
        assert!(!format!("{m:?}").contains(&DELETE_FORWARD.to_string()));
        m.feed(fn_up(), false);
        assert!(m.feed(RawEvent::KeyDown { keycode: 0, repeat: false }, false).is_empty(), "without Fn, typing reports nothing");
    }

    #[test]
    fn escape_only_when_asked() {
        let mut m = defaults();
        assert!(m.feed(RawEvent::KeyDown { keycode: ESCAPE_KEYCODE, repeat: false }, false).is_empty());
        assert_eq!(m.feed(RawEvent::KeyDown { keycode: ESCAPE_KEYCODE, repeat: false }, true).inputs, [Escape]);
    }

    #[test]
    fn only_configured_modes_fire() {
        // Dictate on Fn, the other modes on ordinary shortcuts.
        let mut m = Matcher::new(FnBindings { dictate: Some(FnBinding::Fn), ..Default::default() });
        assert_eq!(inputs(&mut m, fn_down()), [Down(Dictate)]);
        let out = m.feed(RawEvent::KeyDown { keycode: SPACE_KEYCODE, repeat: false }, false);
        assert_eq!(out.inputs, [OtherKey], "Space is not a trigger here");
        assert_eq!(out.held, None);

        let mut m = Matcher::new(FnBindings::default());
        let out = m.feed(fn_down(), false);
        assert!(out.is_empty(), "no Fn bindings, nothing reported");
    }

    #[test]
    fn set_bindings_drops_held_state() {
        let mut m = defaults();
        m.feed(fn_down(), false);
        m.set_bindings(FnBindings { dictate: Some(FnBinding::FnPlus(FnKey::AltRight)), ..Default::default() });
        assert!(inputs(&mut m, fn_up()).is_empty());
        m.feed(fn_down(), false);
        assert_eq!(inputs(&mut m, RawEvent::FlagsChanged { keycode: 61, flags: FN_FLAG | 0x40 | 0x8_0000 }), [Down(Dictate)]);
    }
}
