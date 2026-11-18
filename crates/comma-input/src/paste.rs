//! Output at the cursor: put the text on the clipboard, send Cmd+V, then put back what the user had
//! there (spec 3.2 `paste.rs`). The restore is skipped when the clipboard changed again in the
//! meantime, so a copy the user (or the app) made is never overwritten.

use std::time::Duration;

/// The clipboard, abstracted so the save and restore rule is testable.
pub trait Pasteboard {
    /// Everything on the clipboard, enough to put it back.
    type Snapshot;

    /// Increases on every write (`NSPasteboard.changeCount`).
    fn change_count(&self) -> i64;
    fn snapshot(&self) -> Self::Snapshot;
    /// Replaces the contents with plain text and returns the new change count. `transient` marks it
    /// (`org.nspasteboard.TransientType`, `ConcealedType`) so clipboard managers skip it.
    fn write_text(&self, text: &str, transient: bool) -> i64;
    fn restore(&self, snapshot: Self::Snapshot);
}

/// Sends Cmd+V to the focused app.
pub trait KeySender {
    fn send_paste(&self) -> Result<(), String>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasteOutcome {
    /// `restored` is false when the clipboard changed after our write and was left alone.
    Pasted { restored: bool },
}

/// Snapshot, write `text`, Cmd+V, wait `restore_after` (spec: 400 ms, time for the app to read
/// it), then restore the snapshot if the clipboard still holds our text. A failed Cmd+V restores
/// at once and returns the error.
pub fn paste_and_restore<P: Pasteboard, K: KeySender>(
    pb: &P,
    keys: &K,
    text: &str,
    restore_after: Duration,
    sleep: impl Fn(Duration),
) -> Result<PasteOutcome, String> {
    let saved = pb.snapshot();
    let ours = pb.write_text(text, true);
    if let Err(err) = keys.send_paste() {
        if pb.change_count() == ours {
            pb.restore(saved);
        }
        return Err(err);
    }
    sleep(restore_after);
    if pb.change_count() == ours {
        pb.restore(saved);
        Ok(PasteOutcome::Pasted { restored: true })
    } else {
        Ok(PasteOutcome::Pasted { restored: false })
    }
}

/// Copy only (no Accessibility, or no text field): the text stays on the clipboard as a normal
/// copy, visible to clipboard managers.
pub fn copy_text<P: Pasteboard>(pb: &P, text: &str) {
    pb.write_text(text, false);
}

#[cfg(target_os = "macos")]
pub use mac::{MacKeys, MacPasteboard, PasteboardSnapshot};

#[cfg(target_os = "macos")]
mod mac {
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2_app_kit::{NSPasteboard, NSPasteboardItem, NSPasteboardTypeString, NSPasteboardWriting};
    use objc2_core_graphics::{CGEvent, CGEventFlags, CGEventSource, CGEventSourceStateID, CGEventTapLocation};
    use objc2_foundation::{NSArray, NSData, NSString};

    use super::{KeySender, Pasteboard};

    /// `kVK_ANSI_V`.
    const V_KEYCODE: u16 = 9;

    /// Every item on the clipboard with the data of each of its types.
    #[derive(Default)]
    pub struct PasteboardSnapshot {
        items: Vec<Vec<(Retained<NSString>, Retained<NSData>)>>,
    }

    impl PasteboardSnapshot {
        pub fn is_empty(&self) -> bool {
            self.items.is_empty()
        }
    }

    impl std::fmt::Debug for PasteboardSnapshot {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            // Never the contents.
            f.debug_struct("PasteboardSnapshot").field("items", &self.items.len()).finish()
        }
    }

    /// The general pasteboard. NSPasteboard is safe to use from any thread.
    #[derive(Debug, Default, Clone, Copy)]
    pub struct MacPasteboard;

    impl MacPasteboard {
        fn board() -> Retained<NSPasteboard> {
            NSPasteboard::generalPasteboard()
        }

        /// The plain text on the clipboard, for tests and diagnostics.
        pub fn text(&self) -> Option<String> {
            // SAFETY: NSPasteboardTypeString is an immutable framework constant.
            let ty = unsafe { NSPasteboardTypeString };
            Self::board().stringForType(ty).map(|s| s.to_string())
        }
    }

    impl Pasteboard for MacPasteboard {
        type Snapshot = PasteboardSnapshot;

        fn change_count(&self) -> i64 {
            Self::board().changeCount() as i64
        }

        fn snapshot(&self) -> PasteboardSnapshot {
            let Some(items) = Self::board().pasteboardItems() else { return PasteboardSnapshot::default() };
            let items = items
                .iter()
                .map(|item| {
                    item.types()
                        .iter()
                        .filter_map(|ty| {
                            let data = item.dataForType(&ty)?;
                            Some((ty, data))
                        })
                        .collect::<Vec<_>>()
                })
                .filter(|types| !types.is_empty())
                .collect();
            PasteboardSnapshot { items }
        }

        fn write_text(&self, text: &str, transient: bool) -> i64 {
            let board = Self::board();
            board.clearContents();
            // SAFETY: NSPasteboardTypeString is an immutable framework constant.
            let ty = unsafe { NSPasteboardTypeString };
            board.setString_forType(&NSString::from_str(text), ty);
            if transient {
                // nspasteboard.org markers: clipboard managers skip these.
                let empty = NSData::new();
                for marker in ["org.nspasteboard.TransientType", "org.nspasteboard.ConcealedType", "org.nspasteboard.AutoGeneratedType"] {
                    board.setData_forType(Some(&empty), &NSString::from_str(marker));
                }
            }
            board.changeCount() as i64
        }

        fn restore(&self, snapshot: PasteboardSnapshot) {
            let board = Self::board();
            board.clearContents();
            if snapshot.items.is_empty() {
                return;
            }
            let items: Vec<Retained<ProtocolObject<dyn NSPasteboardWriting>>> = snapshot
                .items
                .iter()
                .map(|types| {
                    let item = NSPasteboardItem::new();
                    for (ty, data) in types {
                        item.setData_forType(data, ty);
                    }
                    ProtocolObject::from_retained(item)
                })
                .collect();
            board.writeObjects(&NSArray::from_retained_slice(&items));
        }
    }

    /// Cmd+V through the HID event tap. Needs Accessibility.
    #[derive(Debug, Default, Clone, Copy)]
    pub struct MacKeys;

    impl KeySender for MacKeys {
        fn send_paste(&self) -> Result<(), String> {
            let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState);
            for down in [true, false] {
                let event = CGEvent::new_keyboard_event(source.as_deref(), V_KEYCODE, down)
                    .ok_or_else(|| "macOS refused to create the paste key event".to_owned())?;
                // Only Command, whatever the user is still holding.
                CGEvent::set_flags(Some(&event), CGEventFlags::MaskCommand);
                CGEvent::post(CGEventTapLocation::HIDEventTap, Some(&event));
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    /// A clipboard holding one string; `meddle` simulates another copy during the wait.
    #[derive(Default)]
    struct FakeBoard {
        text: RefCell<String>,
        count: Cell<i64>,
        transient: Cell<bool>,
    }

    impl FakeBoard {
        fn with(text: &str) -> Self {
            let b = FakeBoard::default();
            *b.text.borrow_mut() = text.into();
            b
        }
        fn meddle(&self, text: &str) {
            *self.text.borrow_mut() = text.into();
            self.count.set(self.count.get() + 1);
        }
    }

    impl Pasteboard for FakeBoard {
        type Snapshot = String;
        fn change_count(&self) -> i64 {
            self.count.get()
        }
        fn snapshot(&self) -> String {
            self.text.borrow().clone()
        }
        fn write_text(&self, text: &str, transient: bool) -> i64 {
            self.meddle(text);
            self.transient.set(transient);
            self.count.get()
        }
        fn restore(&self, snap: String) {
            self.meddle(&snap);
        }
    }

    struct Keys {
        ok: bool,
        sent: Cell<u32>,
    }

    impl KeySender for Keys {
        fn send_paste(&self) -> Result<(), String> {
            self.sent.set(self.sent.get() + 1);
            if self.ok { Ok(()) } else { Err("no".into()) }
        }
    }

    fn keys(ok: bool) -> Keys {
        Keys { ok, sent: Cell::new(0) }
    }

    #[test]
    fn pastes_then_restores_the_previous_clipboard() {
        let board = FakeBoard::with("what the user copied");
        let k = keys(true);
        let waited = Cell::new(Duration::ZERO);
        let out = paste_and_restore(&board, &k, "Hello.", Duration::from_millis(400), |d| {
            // During the wait the app reads our text.
            assert_eq!(*board.text.borrow(), "Hello.");
            waited.set(d);
        });
        assert_eq!(out, Ok(PasteOutcome::Pasted { restored: true }));
        assert_eq!(k.sent.get(), 1);
        assert_eq!(waited.get(), Duration::from_millis(400));
        assert!(board.transient.get(), "the pasted text is marked transient");
        assert_eq!(*board.text.borrow(), "what the user copied");
    }

    #[test]
    fn leaves_a_newer_copy_alone() {
        let board = FakeBoard::with("old");
        let out = paste_and_restore(&board, &keys(true), "Hello.", Duration::from_millis(400), |_| board.meddle("copied meanwhile"));
        assert_eq!(out, Ok(PasteOutcome::Pasted { restored: false }));
        assert_eq!(*board.text.borrow(), "copied meanwhile");
    }

    #[test]
    fn a_failed_paste_restores_at_once() {
        let board = FakeBoard::with("old");
        let slept = Cell::new(false);
        let out = paste_and_restore(&board, &keys(false), "Hello.", Duration::from_millis(400), |_| slept.set(true));
        assert_eq!(out, Err("no".into()));
        assert!(!slept.get());
        assert_eq!(*board.text.borrow(), "old");
    }

    #[test]
    fn copy_is_a_normal_copy() {
        let board = FakeBoard::with("old");
        copy_text(&board, "Hello.");
        assert_eq!(*board.text.borrow(), "Hello.");
        assert!(!board.transient.get());
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "touches the real clipboard; run with --ignored"]
    fn real_pasteboard_round_trip() {
        let pb = MacPasteboard;
        let before = pb.snapshot();
        let marker = "comma-input test marker 7f3a";
        pb.write_text(marker, false);
        assert_eq!(pb.text().as_deref(), Some(marker));
        let saved = pb.snapshot();
        pb.write_text("something else", true);
        pb.restore(saved);
        assert_eq!(pb.text().as_deref(), Some(marker));
        pb.restore(before);
    }
}
