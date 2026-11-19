//! Non-secret settings, persisted as JSON in the app config dir.
//! Mirrors `Settings` / `SettingsPatch` in `packages/shared/src/ipc/settings.ts`.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::{AppError, AppResult};

pub const FILE_NAME: &str = "settings.json";
pub use comma_voice::llm::MAGPIE_BASE_URL;
pub const DEFAULT_SERVER_URL: &str = "http://127.0.0.1:8787";

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

/// Off maps to `"none"` on the wire, Default omits the field (spec 3.2).
pub use comma_voice::llm::ReasoningEffort;

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
pub struct LanguageSettings {
    /// Languages the user speaks, most preferred first. The first is the fallback.
    pub spoken: Vec<String>,
    pub auto_detect: bool,
    /// Translate targets; the first one is used. At most three.
    pub translate_targets: Vec<String>,
}

impl Default for LanguageSettings {
    fn default() -> Self {
        Self { spoken: Vec::new(), auto_detect: true, translate_targets: Vec::new() }
    }
}

/// `Fn`, `Fn+Space`, `Fn+ShiftLeft` (the modifier listener), or an accelerator in the
/// `Alt+Shift+Space` form used by the global-shortcut plugin.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ShortcutSettings {
    pub dictate: String,
    pub ask: String,
    pub translate: String,
    /// Pastes the most recent result again (spec 2.3.2). An ordinary accelerator; empty turns it off.
    pub paste_last: String,
}

/// Spec 2.3.2: Ctrl+Cmd+V.
pub const DEFAULT_PASTE_LAST: &str = "Control+Super+V";

impl Default for ShortcutSettings {
    fn default() -> Self {
        Self { dictate: "Fn".into(), ask: "Fn+Space".into(), translate: "Fn+ShiftLeft".into(), paste_last: DEFAULT_PASTE_LAST.into() }
    }
}

impl ShortcutSettings {
    /// Used for an Fn-based shortcut while Input Monitoring is not allowed (and the phase 1 defaults).
    pub fn fallback() -> Self {
        Self {
            dictate: "Alt+Space".into(),
            ask: "Alt+Shift+Space".into(),
            translate: "Alt+Control+Space".into(),
            paste_last: DEFAULT_PASTE_LAST.into(),
        }
    }

    /// The paste-last shortcut, unless it is turned off.
    pub fn paste_last(&self) -> Option<&str> {
        Some(self.paste_last.as_str()).filter(|s| !s.is_empty())
    }

    pub fn get(&self, mode: comma_voice::prompts::Mode) -> &str {
        use comma_voice::prompts::Mode;
        match mode {
            Mode::Dictate => &self.dictate,
            Mode::Ask => &self.ask,
            Mode::Translate => &self.translate,
        }
    }
}

/// What a run may read from other apps (spec section 1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ContextLevel {
    Off,
    App,
    #[default]
    AppAndSelection,
}

impl ContextLevel {
    pub fn app(self) -> bool {
        self != ContextLevel::Off
    }

    pub fn selection(self) -> bool {
        self == ContextLevel::AppAndSelection
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct FeedbackSettings {
    pub sounds: bool,
    pub show_idle_bar: bool,
    pub hints: bool,
    /// Lower the Mac's output volume while recording.
    pub duck_audio: bool,
}

impl Default for FeedbackSettings {
    fn default() -> Self {
        Self { sounds: true, show_idle_bar: false, hints: true, duck_audio: true }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
pub struct PrivacySettings {
    pub keep_audio: bool,
    /// Runs older than this many days are deleted; 0 keeps them.
    pub history_days: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
pub struct AudioSettings {
    /// `MediaDeviceInfo.deviceId`; empty for the system default.
    pub microphone_id: String,
}

/// The Comma server and who is signed in. Tokens live in the Keychain, not here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct AccountSettings {
    pub server_url: String,
    pub email: String,
    pub name: String,
    /// Unix seconds when the stored access token expires; 0 when signed out.
    pub access_expires_at: u64,
}

impl Default for AccountSettings {
    fn default() -> Self {
        Self { server_url: DEFAULT_SERVER_URL.into(), email: String::new(), name: String::new(), access_expires_at: 0 }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Settings {
    pub version: u32,
    pub mode: AppMode,
    pub theme: ThemePreference,
    pub onboarding_completed: bool,
    /// Id of the onboarding step to resume at; empty for the first one.
    pub onboarding_step: String,
    pub stt: SttSettings,
    pub llm: LlmSettings,
    pub languages: LanguageSettings,
    pub shortcuts: ShortcutSettings,
    pub account: AccountSettings,
    pub context_level: ContextLevel,
    pub feedback: FeedbackSettings,
    pub privacy: PrivacySettings,
    pub audio: AudioSettings,
    /// How often each bar hint has been shown. Written by Rust only.
    pub hint_counts: BTreeMap<String, u32>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: 1,
            mode: AppMode::default(),
            theme: ThemePreference::default(),
            onboarding_completed: false,
            onboarding_step: String::new(),
            stt: SttSettings::default(),
            llm: LlmSettings::default(),
            languages: LanguageSettings::default(),
            shortcuts: ShortcutSettings::default(),
            account: AccountSettings::default(),
            context_level: ContextLevel::default(),
            feedback: FeedbackSettings::default(),
            privacy: PrivacySettings::default(),
            audio: AudioSettings::default(),
            hint_counts: BTreeMap::new(),
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
        if self.onboarding_step.len() > 32 {
            return Err(AppError::invalid("onboarding_step is too long"));
        }
        let langs = &self.languages;
        if langs.spoken.len() > 10 || langs.translate_targets.len() > 3 {
            return Err(AppError::invalid("pick at most 10 spoken and 3 target languages"));
        }
        if !langs.spoken.iter().chain(&langs.translate_targets).all(|tag| is_language_tag(tag)) {
            return Err(AppError::invalid("languages must be tags such as en or pt-BR"));
        }
        let sc = &self.shortcuts;
        for accel in [&sc.dictate, &sc.ask, &sc.translate] {
            if accel.is_empty() || accel.len() > 64 || accel.chars().any(char::is_whitespace) {
                return Err(AppError::invalid("shortcuts must look like Fn+Space or Alt+Space"));
            }
            crate::shortcuts::validate(accel)?;
        }
        if sc.dictate == sc.ask || sc.dictate == sc.translate || sc.ask == sc.translate {
            return Err(AppError::invalid("each mode needs its own shortcut"));
        }
        if let Some(paste) = sc.paste_last() {
            if paste.len() > 64 || paste.chars().any(char::is_whitespace) || crate::shortcuts::is_fn(paste) {
                return Err(AppError::invalid("Paste last result needs an ordinary shortcut such as Control+Command+V"));
            }
            crate::shortcuts::validate(paste)?;
            let fallback = ShortcutSettings::fallback();
            if [&sc.dictate, &sc.ask, &sc.translate, &fallback.dictate, &fallback.ask, &fallback.translate].contains(&&sc.paste_last) {
                return Err(AppError::invalid("Paste last result needs its own shortcut"));
            }
        }
        if self.privacy.history_days > 3650 || self.audio.microphone_id.len() > 256 {
            return Err(AppError::invalid("privacy.history_days or audio.microphone_id is out of range"));
        }
        if self.account.email.len() > 320 || self.account.name.len() > 200 {
            return Err(AppError::invalid("account details are too long"));
        }
        validate_url(&self.account.server_url, "account.server_url")?;
        validate_url(&self.llm.base_url, "llm.base_url")
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

pub fn validate_url(url: &str, field: &str) -> AppResult<()> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .ok_or_else(|| AppError::invalid(format!("{field} must start with http:// or https://")))?;
    let host = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if host.is_empty() || url.len() > 2048 || url.chars().any(char::is_whitespace) {
        return Err(AppError::invalid(format!("{field} is not a valid URL")));
    }
    Ok(())
}

/// `en`, `zh-Hans`, `pt-BR`: the same shape as `LanguageTag` in the shared API schemas.
fn is_language_tag(tag: &str) -> bool {
    let mut parts = tag.split('-');
    let primary = parts.next().unwrap_or_default();
    let subtags: Vec<&str> = parts.collect();
    (2..=3).contains(&primary.len())
        && primary.chars().all(|c| c.is_ascii_alphabetic())
        && subtags.len() <= 3
        && subtags.iter().all(|s| (2..=8).contains(&s.len()) && s.chars().all(|c| c.is_ascii_alphanumeric()))
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
            log::warn!("cannot read settings: {err}");
            return Settings::default();
        }
    };
    match serde_json::from_str::<Settings>(&raw).map_err(json_err).and_then(|s| s.validate().map(|_| s)) {
        Ok(mut settings) => {
            // Phase 1 saved its defaults explicitly; untouched ones move to the Fn defaults.
            if settings.shortcuts == ShortcutSettings::fallback() {
                settings.shortcuts = ShortcutSettings::default();
            }
            settings
        }
        Err(err) => {
            log::warn!("settings file is invalid ({err}); starting from defaults");
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
                "onboarding_step": "",
                "stt": { "model_id": "scribe_v3" },
                "llm": { "base_url": MAGPIE_BASE_URL, "model": "", "reasoning_effort": "default" },
                "languages": { "spoken": [], "auto_detect": true, "translate_targets": [] },
                "shortcuts": { "dictate": "Fn", "ask": "Fn+Space", "translate": "Fn+ShiftLeft", "paste_last": "Control+Super+V" },
                "account": { "server_url": DEFAULT_SERVER_URL, "email": "", "name": "", "access_expires_at": 0 },
                "context_level": "app_and_selection",
                "feedback": { "sounds": true, "show_idle_bar": false, "hints": true, "duck_audio": true },
                "privacy": { "keep_audio": false, "history_days": 0 },
                "audio": { "microphone_id": "" },
                "hint_counts": {}
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
        assert!(s.apply_patch(&json!({ "languages": { "translate_targets": ["en", "fr", "de", "ja"] } })).is_err());
        assert!(s.apply_patch(&json!({ "languages": { "spoken": ["english"] } })).is_err());
        assert!(s.apply_patch(&json!({ "shortcuts": { "dictate": "" } })).is_err());
        assert!(s.apply_patch(&json!({ "shortcuts": { "dictate": "Fn+Q" } })).is_err());
        assert!(s.apply_patch(&json!({ "shortcuts": { "ask": "Fn" } })).is_err(), "two modes on one shortcut");
        assert!(s.apply_patch(&json!({ "shortcuts": { "ask": "Alt+Nope" } })).is_err());
        // Paste last result: an ordinary shortcut of its own, or off.
        assert_eq!(s.apply_patch(&json!({ "shortcuts": { "paste_last": "" } })).unwrap().shortcuts.paste_last(), None);
        assert!(s.apply_patch(&json!({ "shortcuts": { "paste_last": "Control+Alt+V" } })).is_ok());
        assert!(s.apply_patch(&json!({ "shortcuts": { "paste_last": "Fn+MetaLeft" } })).is_err(), "Fn is for the modes");
        assert!(s.apply_patch(&json!({ "shortcuts": { "paste_last": "V" } })).is_err());
        assert!(s.apply_patch(&json!({ "shortcuts": { "paste_last": "Alt+Space" } })).is_err(), "the Dictate fallback");
        assert!(s.apply_patch(&json!({ "shortcuts": { "dictate": "Control+Shift+D", "paste_last": "Control+Shift+D" } })).is_err());
        assert!(s.apply_patch(&json!({ "context_level": "everything" })).is_err());
        assert!(s.apply_patch(&json!({ "account": { "server_url": "localhost:8787" } })).is_err());
    }

    #[test]
    fn languages_and_shortcuts_patch() {
        let next = Settings::default()
            .apply_patch(&json!({
                "languages": { "spoken": ["zh-Hans", "en"], "translate_targets": ["pt-BR"] },
                "shortcuts": { "dictate": "Control+Shift+D" }
            }))
            .unwrap();
        assert_eq!(next.languages.spoken, ["zh-Hans", "en"]);
        assert!(next.languages.auto_detect);
        assert_eq!(next.shortcuts.dictate, "Control+Shift+D");
        assert_eq!(next.shortcuts.ask, "Fn+Space");
        // Settings saved before Paste last result existed get it on.
        let old: ShortcutSettings = serde_json::from_value(json!({ "dictate": "Fn", "ask": "Fn+Space", "translate": "Fn+ShiftLeft" })).unwrap();
        assert_eq!(old.paste_last(), Some(DEFAULT_PASTE_LAST));
    }

    #[test]
    fn phase_one_default_shortcuts_move_to_fn() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let old = Settings { shortcuts: ShortcutSettings::fallback(), ..Settings::default() };
        save(&path, &old).unwrap();
        assert_eq!(load(&path).shortcuts, ShortcutSettings::default());
        let custom = Settings { shortcuts: ShortcutSettings { dictate: "Control+Shift+D".into(), ..ShortcutSettings::fallback() }, ..Settings::default() };
        save(&path, &custom).unwrap();
        assert_eq!(load(&path).shortcuts.dictate, "Control+Shift+D");
    }

    #[test]
    fn phase_one_files_still_load() {
        let old = json!({
            "version": 1, "mode": "local", "theme": "dark", "onboarding_completed": true,
            "stt": { "model_id": "scribe_v3" },
            "llm": { "base_url": MAGPIE_BASE_URL, "model": "m", "reasoning_effort": "off" }
        });
        let s: Settings = serde_json::from_value(old).unwrap();
        assert_eq!(s.shortcuts, ShortcutSettings::default());
        assert_eq!(s.account.server_url, DEFAULT_SERVER_URL);
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
