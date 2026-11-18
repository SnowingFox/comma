//! API keys in the macOS Keychain. Values go in and never come back out to the frontend.

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult, ErrorCode};

pub const SERVICE: &str = "app.comma.desktop";
const MAX_SECRET_LEN: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SecretName {
    Elevenlabs,
    Llm,
}

impl SecretName {
    pub fn account(self) -> &'static str {
        match self {
            SecretName::Elevenlabs => "elevenlabs",
            SecretName::Llm => "llm",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct SecretStatus {
    pub elevenlabs: bool,
    pub llm: bool,
}

pub trait SecretStore: Send + Sync {
    fn set(&self, name: SecretName, value: &str) -> AppResult<()>;
    fn delete(&self, name: SecretName) -> AppResult<()>;
    fn exists(&self, name: SecretName) -> AppResult<bool>;
}

/// Sets or, for an empty value, deletes a secret. Surrounding whitespace from a paste is trimmed.
pub fn set_secret(store: &dyn SecretStore, name: SecretName, value: &str) -> AppResult<()> {
    let value = value.trim();
    if value.is_empty() {
        return store.delete(name);
    }
    if value.len() > MAX_SECRET_LEN || value.chars().any(char::is_control) {
        return Err(AppError::invalid("the key has an unexpected format"));
    }
    store.set(name, value)
}

pub fn status(store: &dyn SecretStore) -> AppResult<SecretStatus> {
    Ok(SecretStatus {
        elevenlabs: store.exists(SecretName::Elevenlabs)?,
        llm: store.exists(SecretName::Llm)?,
    })
}

/// The login Keychain via the `keyring` crate.
pub struct KeychainStore;

impl KeychainStore {
    fn entry(name: SecretName) -> AppResult<keyring::Entry> {
        keyring::Entry::new(SERVICE, name.account()).map_err(keychain_err)
    }
}

impl SecretStore for KeychainStore {
    fn set(&self, name: SecretName, value: &str) -> AppResult<()> {
        Self::entry(name)?.set_password(value).map_err(keychain_err)
    }

    fn delete(&self, name: SecretName) -> AppResult<()> {
        match Self::entry(name)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(keychain_err(err)),
        }
    }

    fn exists(&self, name: SecretName) -> AppResult<bool> {
        // Reads the item to learn whether it exists; the value is dropped right here.
        match Self::entry(name)?.get_password() {
            Ok(_) => Ok(true),
            Err(keyring::Error::NoEntry) => Ok(false),
            Err(err) => Err(keychain_err(err)),
        }
    }
}

/// keyring errors describe the failure, never the secret, but keep the message generic anyway.
fn keychain_err(err: keyring::Error) -> AppError {
    let kind = match err {
        keyring::Error::NoStorageAccess(_) => "the Keychain is locked or access was denied",
        keyring::Error::PlatformFailure(_) => "the Keychain returned an error",
        keyring::Error::TooLong(..) | keyring::Error::Invalid(..) | keyring::Error::BadEncoding(_) => {
            "the key has an unexpected format"
        }
        _ => "the Keychain request failed",
    };
    AppError::new(ErrorCode::Keychain, kind)
}

#[cfg(test)]
pub mod memory {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    #[derive(Default)]
    pub struct MemoryStore(pub Mutex<HashMap<SecretName, String>>);

    impl SecretStore for MemoryStore {
        fn set(&self, name: SecretName, value: &str) -> AppResult<()> {
            self.0.lock().unwrap().insert(name, value.to_owned());
            Ok(())
        }
        fn delete(&self, name: SecretName) -> AppResult<()> {
            self.0.lock().unwrap().remove(&name);
            Ok(())
        }
        fn exists(&self, name: SecretName) -> AppResult<bool> {
            Ok(self.0.lock().unwrap().contains_key(&name))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::memory::MemoryStore;
    use super::*;

    #[test]
    fn set_reports_status_without_values() {
        let store = MemoryStore::default();
        assert_eq!(status(&store).unwrap(), SecretStatus { elevenlabs: false, llm: false });
        set_secret(&store, SecretName::Elevenlabs, "  sk_test  ").unwrap();
        assert_eq!(status(&store).unwrap(), SecretStatus { elevenlabs: true, llm: false });
        assert_eq!(store.0.lock().unwrap()[&SecretName::Elevenlabs], "sk_test");
        let json = serde_json::to_string(&status(&store).unwrap()).unwrap();
        assert!(!json.contains("sk_test"));
    }

    #[test]
    fn empty_value_deletes() {
        let store = MemoryStore::default();
        set_secret(&store, SecretName::Llm, "key").unwrap();
        set_secret(&store, SecretName::Llm, "").unwrap();
        assert!(!status(&store).unwrap().llm);
    }

    #[test]
    fn rejects_control_characters_and_long_values() {
        let store = MemoryStore::default();
        assert!(set_secret(&store, SecretName::Llm, "a\u{0}b").is_err());
        assert!(set_secret(&store, SecretName::Llm, &"x".repeat(5000)).is_err());
    }

    #[test]
    fn secret_names_match_the_shared_contract() {
        assert_eq!(serde_json::to_string(&SecretName::Elevenlabs).unwrap(), "\"elevenlabs\"");
        assert_eq!(serde_json::from_str::<SecretName>("\"llm\"").unwrap(), SecretName::Llm);
    }
}
