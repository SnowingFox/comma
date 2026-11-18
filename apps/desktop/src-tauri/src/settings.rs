//! Non-secret settings, persisted as JSON in the app config dir.
//! Mirrors `Settings` / `SettingsPatch` in `packages/shared/src/ipc/settings.ts`.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::{AppError, AppResult};

pub const FILE_NAME: &str = "settings.json";
pub const MAGPIE_BASE_URL: &str = "http://127.0.0.1:3425/v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum AppMode {
    #[default]
    Local,
    Account,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ThemePreference {
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningEffort {
    Off,
    Low,
    Medium,
    High,
    #[default]
    Default,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct SttSettings {
    pub model_id: String,
}

impl Default for SttSettings {
    fn default() -> Self {
        Self { model_id: "scribe_v3".into() }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct LlmSettings {
    pub base_url: String,
    pub model: String,
    pub reasoning_effort: ReasoningEffort,
}

impl Default for LlmSettings {
    fn default() -> Self {
        Self {
            base_url: MAGPIE_BASE_URL.into(),
            model: String::new(),
            reasoning_effort: ReasoningEffort::Default,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Settings {
    pub version: u32,
    pub mode: AppMode,
    pub theme: ThemePreference,
    pub onboarding_completed: bool,
    pub stt: SttSettings,
    pub llm: LlmSettings,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: 1,
            mode: AppMode::default(),
            theme: ThemePreference::default(),
            onboarding_completed: false,
            stt: SttSettings::default(),
            llm: LlmSettings::default(),
        }
    }
}

impl Settings {
    pub fn validate(&self) -> AppResult<()> {
        if self.version != 1 {
            return Err(AppError::invalid("unsupported settings version"));
        }
        let id_len = self.stt.model_id.chars().count();
        if id_len == 0 || id_len > 100 {
            return Err(AppError::invalid("stt.model_id must be 1 to 100 characters"));
        }
        if self.llm.model.chars().count() > 200 {
            return Err(AppError::invalid("llm.model must be at most 200 characters"));
        }
        validate_base_url(&self.llm.base_url)
    }

    /// Applies a partial update. Nested objects (`stt`, `llm`) merge one level deep;
    /// unknown keys are rejected so a typo cannot silently do nothing.
    pub fn apply_patch(&self, patch: &Value) -> AppResult<Settings> {
        let Value::Object(patch) = patch else {
            return Err(AppError::invalid("patch must be an object"));
        };
        let Value::Object(mut current) = serde_json::to_value(self).map_err(json_err)? else {
            return Err(AppError::internal("settings did not serialize to an object"));
        };
        merge(&mut current, patch, "")?;
        let next: Settings = serde_json::from_value(Value::Object(current))
            .map_err(|e| AppError::invalid(format!("invalid settings: {e}")))?;
        next.validate()?;
        Ok(next)
    }
}

fn merge(target: &mut Map<String, Value>, patch: &Map<String, Value>, prefix: &str) -> AppResult<()> {
    for (key, value) in patch {
        let Some(slot) = target.get_mut(key) else {
            return Err(AppError::invalid(format!("unknown setting: {prefix}{key}")));
        };
        match (slot, value) {
            (Value::Object(inner), Value::Object(inner_patch)) if prefix.is_empty() => {
                merge(inner, inner_patch, &format!("{key}."))?;
            }
            (slot, value) => *slot = value.clone(),
        }
    }
    Ok(())
}

fn validate_base_url(url: &str) -> AppResult<()> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .ok_or_else(|| AppError::invalid("llm.base_url must start with http:// or https://"))?;
    let host = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if host.is_empty() || url.len() > 2048 || url.chars().any(char::is_whitespace) {
        return Err(AppError::invalid("llm.base_url is not a valid URL"));
    }
    Ok(())
}

fn json_err(err: serde_json::Error) -> AppError {
    AppError::internal(err.to_string())
}

/// Reads settings from `path`. A missing file gives the defaults; an unreadable one is
/// moved aside to `settings.json.bak` so the app still starts.
pub fn load(path: &Path) -> Settings {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Settings::default(),
        Err(err) => {
            eprintln!("comma: cannot read settings: {err}");
            return Settings::default();
        }
    };
    match serde_json::from_str::<Settings>(&raw).map_err(json_err).and_then(|s| s.validate().map(|_| s)) {
        Ok(settings) => settings,
        Err(err) => {
            eprintln!("comma: settings file is invalid ({err}); starting from defaults");
            let _ = fs::rename(path, path.with_extension("json.bak"));
            Settings::default()
        }
    }
}

/// Writes atomically: a temp file in the same directory, then rename.
pub fn save(path: &Path, settings: &Settings) -> AppResult<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp: PathBuf = path.with_extension("json.tmp");
    let body = serde_json::to_vec_pretty(settings).map_err(json_err)?;
    fs::write(&tmp, body)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn defaults_serialize_like_the_shared_contract() {
        let value = serde_json::to_value(Settings::default()).unwrap();
        assert_eq!(
            value,
            json!({
                "version": 1,
                "mode": "local",
                "theme": "system",
                "onboarding_completed": false,
                "stt": { "model_id": "scribe_v3" },
                "llm": { "base_url": MAGPIE_BASE_URL, "model": "", "reasoning_effort": "default" }
            })
        );
    }

    #[test]
    fn patch_merges_nested_objects() {
        let next = Settings::default()
            .apply_patch(&json!({ "theme": "dark", "llm": { "model": "deepseek-chat" } }))
            .unwrap();
        assert_eq!(next.theme, ThemePreference::Dark);
        assert_eq!(next.llm.model, "deepseek-chat");
        assert_eq!(next.llm.base_url, MAGPIE_BASE_URL);
    }

    #[test]
    fn patch_rejects_unknown_keys_and_bad_values() {
        let s = Settings::default();
        assert!(s.apply_patch(&json!({ "nope": 1 })).is_err());
        assert!(s.apply_patch(&json!({ "llm": { "nope": 1 } })).is_err());
        assert!(s.apply_patch(&json!({ "theme": "blue" })).is_err());
        assert!(s.apply_patch(&json!({ "llm": { "base_url": "ftp://x" } })).is_err());
        assert!(s.apply_patch(&json!({ "llm": { "base_url": "https://" } })).is_err());
        assert!(s.apply_patch(&json!({ "stt": { "model_id": "" } })).is_err());
        assert!(s.apply_patch(&json!([])).is_err());
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join(FILE_NAME);
        assert_eq!(load(&path), Settings::default());
        let s = Settings::default().apply_patch(&json!({ "mode": "account" })).unwrap();
        save(&path, &s).unwrap();
        assert_eq!(load(&path), s);
    }

    #[test]
    fn invalid_file_is_moved_aside() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        fs::write(&path, "{ not json").unwrap();
        assert_eq!(load(&path), Settings::default());
        assert!(path.with_extension("json.bak").exists());
    }
}
