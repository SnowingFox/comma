//! Microphone and Accessibility status, and the System Settings panes that grant them.

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult, ErrorCode};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionState {
    Granted,
    Denied,
    Restricted,
    NotDetermined,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct PermissionsStatus {
    pub microphone: PermissionState,
    pub accessibility: PermissionState,
    /// For the Fn shortcuts.
    pub input_monitoring: PermissionState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SettingsPaneKind {
    Microphone,
    Accessibility,
    InputMonitoring,
    /// Keyboard settings, for "Press Globe key to".
    Keyboard,
}

impl SettingsPaneKind {
    /// Deep link into System Settings > Privacy & Security.
    pub fn url(self) -> &'static str {
        match self {
            SettingsPaneKind::Microphone => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
            }
            SettingsPaneKind::Accessibility => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
            }
            SettingsPaneKind::InputMonitoring => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"
            }
            SettingsPaneKind::Keyboard => "x-apple.systempreferences:com.apple.Keyboard-Settings.extension",
        }
    }
}

pub fn status() -> PermissionsStatus {
    let input_monitoring =
        if comma_input::input_monitoring_granted() { PermissionState::Granted } else { PermissionState::Denied };
    PermissionsStatus { microphone: platform::microphone(), accessibility: platform::accessibility(), input_monitoring }
}

pub fn open_pane(kind: SettingsPaneKind) -> AppResult<()> {
    platform::open_url(kind.url())
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};

    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        fn AXIsProcessTrusted() -> bool;
    }

    pub fn microphone() -> PermissionState {
        // SAFETY: AVMediaTypeAudio is an immutable framework constant, and the class method
        // only reads the TCC database.
        let status = unsafe {
            let Some(media) = AVMediaTypeAudio else { return PermissionState::NotDetermined };
            AVCaptureDevice::authorizationStatusForMediaType(media)
        };
        match status {
            AVAuthorizationStatus::Authorized => PermissionState::Granted,
            AVAuthorizationStatus::Denied => PermissionState::Denied,
            AVAuthorizationStatus::Restricted => PermissionState::Restricted,
            _ => PermissionState::NotDetermined,
        }
    }

    pub fn accessibility() -> PermissionState {
        // SAFETY: AXIsProcessTrusted takes no arguments and has no preconditions.
        if unsafe { AXIsProcessTrusted() } { PermissionState::Granted } else { PermissionState::Denied }
    }

    pub fn open_url(url: &str) -> AppResult<()> {
        // `url` is one of the constants above, never user input.
        let status = std::process::Command::new("/usr/bin/open").arg(url).status()?;
        if status.success() {
            Ok(())
        } else {
            Err(AppError::new(ErrorCode::Io, "could not open System Settings"))
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::*;

    pub fn microphone() -> PermissionState {
        PermissionState::Granted
    }

    pub fn accessibility() -> PermissionState {
        PermissionState::Granted
    }

    pub fn open_url(_url: &str) -> AppResult<()> {
        Err(AppError::new(ErrorCode::Unsupported, "only available on macOS"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_serializes_like_the_shared_contract() {
        let json = serde_json::to_value(PermissionsStatus {
            microphone: PermissionState::NotDetermined,
            accessibility: PermissionState::Granted,
            input_monitoring: PermissionState::Denied,
        })
        .unwrap();
        assert_eq!(json, serde_json::json!({ "microphone": "not_determined", "accessibility": "granted", "input_monitoring": "denied" }));
    }

    #[test]
    fn pane_kinds_parse_and_link_to_privacy() {
        let kind: SettingsPaneKind = serde_json::from_str("\"accessibility\"").unwrap();
        assert!(kind.url().ends_with("Privacy_Accessibility"));
        let kind: SettingsPaneKind = serde_json::from_str("\"input_monitoring\"").unwrap();
        assert!(kind.url().ends_with("Privacy_ListenEvent"));
        assert!(serde_json::from_str::<SettingsPaneKind>("\"camera\"").is_err());
    }

    #[test]
    fn status_query_does_not_panic() {
        let _ = status();
    }
}
