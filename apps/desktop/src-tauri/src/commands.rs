//! Tauri commands (spec 3.3). Contract: `packages/shared/src/ipc/commands.ts`.

use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::Value;
use tauri::{AppHandle, State};

use crate::error::{AppError, AppResult};
use crate::permissions::{self, PermissionsStatus, SettingsPaneKind};
use crate::secrets::{self, SecretName, SecretStatus, SecretStore};
use crate::settings::{self, Settings};
use crate::windows::{self, WindowLabel};

pub struct AppState {
    pub settings: Mutex<Settings>,
    pub settings_path: PathBuf,
    pub secrets: Box<dyn SecretStore>,
}

impl AppState {
    fn settings(&self) -> AppResult<std::sync::MutexGuard<'_, Settings>> {
        self.settings.lock().map_err(|_| AppError::internal("settings lock poisoned"))
    }

    pub fn update_settings(&self, patch: &Value) -> AppResult<Settings> {
        let mut current = self.settings()?;
        let next = current.apply_patch(patch)?;
        settings::save(&self.settings_path, &next)?;
        *current = next.clone();
        Ok(next)
    }
}

#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> AppResult<Settings> {
    Ok(state.settings()?.clone())
}

#[tauri::command]
pub fn settings_set(state: State<'_, AppState>, patch: Value) -> AppResult<Settings> {
    state.update_settings(&patch)
}

// Keychain calls can block on a system prompt, so they run off the main thread.
#[tauri::command]
pub async fn secret_set(state: State<'_, AppState>, name: SecretName, value: String) -> AppResult<()> {
    secrets::set_secret(state.secrets.as_ref(), name, &value)
}

#[tauri::command]
pub async fn secret_status(state: State<'_, AppState>) -> AppResult<SecretStatus> {
    secrets::status(state.secrets.as_ref())
}

#[tauri::command]
pub fn permissions_status() -> PermissionsStatus {
    permissions::status()
}

#[tauri::command]
pub fn open_settings_pane(kind: SettingsPaneKind) -> AppResult<()> {
    permissions::open_pane(kind)
}

#[tauri::command]
pub fn window_show(app: AppHandle, label: WindowLabel) -> AppResult<()> {
    windows::show(&app, label)
}

#[tauri::command]
pub fn window_hide(app: AppHandle, label: WindowLabel) -> AppResult<()> {
    windows::hide(&app, label)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::memory::MemoryStore;
    use serde_json::json;

    #[test]
    fn update_settings_persists_and_keeps_state_on_error() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState {
            settings: Mutex::new(Settings::default()),
            settings_path: dir.path().join(settings::FILE_NAME),
            secrets: Box::new(MemoryStore::default()),
        };
        let next = state.update_settings(&json!({ "onboarding_completed": true })).unwrap();
        assert!(next.onboarding_completed);
        assert_eq!(settings::load(&state.settings_path), next);

        assert!(state.update_settings(&json!({ "theme": 3 })).is_err());
        assert_eq!(*state.settings.lock().unwrap(), next);
    }

    #[test]
    fn app_error_serializes_as_code_and_message() {
        let json = serde_json::to_value(AppError::invalid("bad")).unwrap();
        assert_eq!(json, json!({ "code": "invalid_input", "message": "bad" }));
    }
}
