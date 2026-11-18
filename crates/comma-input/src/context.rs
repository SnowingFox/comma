//! What a run may read from other apps (spec section 1 and 3.2 `context.rs`): the focused app's
//! name, and for Ask Anything its selected text. Read only when a run starts; nothing else.

/// The frontmost app when a run starts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrontApp {
    pub name: String,
    pub bundle_id: Option<String>,
    pub pid: i32,
}

/// Whether the focused element takes text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Editable {
    Yes,
    /// The app reports no focused element: paste would go nowhere.
    No,
    /// Accessibility could not tell (not allowed, or the app does not answer).
    Unknown,
}

#[cfg(target_os = "macos")]
pub use mac::{accessibility_trusted, activate, focused_editable, frontmost_app, selected_text};

#[cfg(not(target_os = "macos"))]
pub use stub::{accessibility_trusted, activate, focused_editable, frontmost_app, selected_text};

#[cfg(target_os = "macos")]
mod mac {
    use std::ptr::{self, NonNull};

    use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication, NSWorkspace};
    use objc2_core_foundation::{CFBoolean, CFRetained, CFString, CFType};

    use super::{Editable, FrontApp};

    type AXError = i32;
    const AX_SUCCESS: AXError = 0;
    const AX_NO_VALUE: AXError = -25212;
    const AX_ATTRIBUTE_UNSUPPORTED: AXError = -25205;

    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        fn AXIsProcessTrusted() -> u8;
        fn AXUIElementCreateApplication(pid: i32) -> *mut CFType;
        fn AXUIElementCopyAttributeValue(element: *const CFType, attribute: *const CFString, value: *mut *mut CFType) -> AXError;
        fn AXUIElementSetAttributeValue(element: *const CFType, attribute: *const CFString, value: *const CFType) -> AXError;
        fn AXUIElementIsAttributeSettable(element: *const CFType, attribute: *const CFString, settable: *mut u8) -> AXError;
    }

    pub fn accessibility_trusted() -> bool {
        // SAFETY: no arguments, no preconditions; it reads the TCC state.
        unsafe { AXIsProcessTrusted() != 0 }
    }

    pub fn frontmost_app() -> Option<FrontApp> {
        let app = NSWorkspace::sharedWorkspace().frontmostApplication()?;
        let name = app.localizedName().map(|n| n.to_string()).unwrap_or_default();
        Some(FrontApp { name, bundle_id: app.bundleIdentifier().map(|b| b.to_string()), pid: app.processIdentifier() })
    }

    pub fn activate(pid: i32) -> bool {
        NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
            .is_some_and(|app| app.activateWithOptions(NSApplicationActivationOptions::empty()))
    }

    /// The accessibility element of an app.
    fn app_element(pid: i32) -> Option<CFRetained<CFType>> {
        // SAFETY: returns a new (+1) reference or null; any pid is accepted.
        let raw = unsafe { AXUIElementCreateApplication(pid) };
        // SAFETY: create rule, so we own the reference.
        NonNull::new(raw).map(|p| unsafe { CFRetained::from_raw(p) })
    }

    fn copy_attr(element: &CFType, name: &str) -> Result<CFRetained<CFType>, AXError> {
        let attr = CFString::from_str(name);
        let mut value: *mut CFType = ptr::null_mut();
        // SAFETY: `element` is a live AXUIElement, `attr` a live CFString, `value` a valid out
        // pointer; on success it holds a +1 reference (copy rule).
        let err = unsafe { AXUIElementCopyAttributeValue(element, &*attr, &mut value) };
        if err != AX_SUCCESS {
            return Err(err);
        }
        // SAFETY: success with a non-null value means we own one reference.
        NonNull::new(value).map(|p| unsafe { CFRetained::from_raw(p) }).ok_or(AX_NO_VALUE)
    }

    fn settable(element: &CFType, name: &str) -> bool {
        let attr = CFString::from_str(name);
        let mut out: u8 = 0;
        // SAFETY: live element and attribute, valid out pointer.
        let err = unsafe { AXUIElementIsAttributeSettable(element, &*attr, &mut out) };
        err == AX_SUCCESS && out != 0
    }

    /// Chromium and Electron build their accessibility tree only when asked. Best effort.
    fn wake_electron(app: &CFType) {
        let attr = CFString::from_str("AXManualAccessibility");
        let yes: &CFBoolean = CFBoolean::new(true);
        // SAFETY: live element, attribute and value; the call does not retain beyond its duration.
        let _ = unsafe { AXUIElementSetAttributeValue(app, &*attr, (yes as *const CFBoolean).cast::<CFType>()) };
    }

    fn focused(pid: i32) -> Result<CFRetained<CFType>, AXError> {
        let app = app_element(pid).ok_or(AX_NO_VALUE)?;
        wake_electron(&app);
        copy_attr(&app, "AXFocusedUIElement")
    }

    fn string_attr(element: &CFType, name: &str) -> Option<String> {
        let value = copy_attr(element, name).ok()?;
        value.downcast::<CFString>().ok().map(|s| s.to_string())
    }

    pub fn selected_text(pid: i32, max_chars: usize) -> Option<String> {
        let element = focused(pid).ok()?;
        let text = string_attr(&element, "AXSelectedText")?;
        if text.trim().is_empty() {
            return None;
        }
        Some(text.chars().take(max_chars).collect())
    }

    pub fn focused_editable(pid: i32) -> Editable {
        let element = match focused(pid) {
            Ok(e) => e,
            Err(AX_NO_VALUE | AX_ATTRIBUTE_UNSUPPORTED) => return Editable::No,
            Err(_) => return Editable::Unknown,
        };
        let role = string_attr(&element, "AXRole").unwrap_or_default();
        if matches!(role.as_str(), "AXTextField" | "AXTextArea" | "AXComboBox" | "AXSearchField") {
            return Editable::Yes;
        }
        if copy_attr(&element, "AXSelectedTextRange").is_ok() || settable(&element, "AXValue") {
            return Editable::Yes;
        }
        // A focused element that is not text (a list, a button, a web area with nothing editable).
        // Web views report `AXWebArea` for the page itself; it may still hold an editor the tree
        // does not expose, so only clear non-text roles count as No.
        if role.is_empty() || role == "AXWebArea" || role == "AXGroup" { Editable::Unknown } else { Editable::No }
    }
}

#[cfg(not(target_os = "macos"))]
mod stub {
    use super::{Editable, FrontApp};

    pub fn accessibility_trusted() -> bool {
        false
    }
    pub fn frontmost_app() -> Option<FrontApp> {
        None
    }
    pub fn activate(_pid: i32) -> bool {
        false
    }
    pub fn selected_text(_pid: i32, _max_chars: usize) -> Option<String> {
        None
    }
    pub fn focused_editable(_pid: i32) -> Editable {
        Editable::Unknown
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    #[ignore = "reads the frontmost app; run with --ignored"]
    fn real_frontmost_app() {
        let app = frontmost_app().expect("some app is frontmost");
        println!("frontmost: {} {:?} pid {}", app.name, app.bundle_id, app.pid);
        assert!(app.pid > 0);
        println!("accessibility trusted: {}", accessibility_trusted());
        println!("focused editable: {:?}", focused_editable(app.pid));
    }
}
