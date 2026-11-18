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
pub use tap::{FnTap, TapError, input_monitoring_granted, request_input_monitoring};
