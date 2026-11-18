use serde::Serialize;

/// The error every command rejects with (spec 3.3). `message` must never contain a secret.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AppError {
    pub code: ErrorCode,
    pub message: String,
    /// Machine-readable upstream reason, e.g. the Comma server's error code. Never a secret.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    InvalidInput,
    Io,
    Keychain,
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    Unsupported,
    Internal,
    /// A key or setting the call needs is missing.
    NotConfigured,
    /// The provider rejected the key.
    InvalidKey,
    /// The key is valid but lacks a permission (ElevenLabs Speech to Text).
    MissingPermission,
    UnknownModel,
    /// Connection refused, DNS failure, TLS failure.
    Unreachable,
    Timeout,
    RateLimited,
    /// Any other non-2xx or malformed answer from a provider.
    Upstream,
    /// The Comma server answered with an error; `reason` carries its code.
    Server,
}

impl AppError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), reason: None }
    }

    pub fn with_reason(mut self, reason: impl Into<String>) -> Self {
        self.reason = Some(reason.into());
        self
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidInput, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, message)
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message)
    }
}

impl std::error::Error for AppError {}

impl From<std::io::Error> for AppError {
    fn from(err: std::io::Error) -> Self {
        Self::new(ErrorCode::Io, err.to_string())
    }
}

impl From<tauri::Error> for AppError {
    fn from(err: tauri::Error) -> Self {
        Self::internal(err.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
