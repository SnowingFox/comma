//! One error type for every provider call. Messages are written for the person using Comma and
//! never contain a key: upstream text is redacted and clipped before it is stored here.

use std::time::Duration;

/// What went wrong, precisely enough for the UI to say what to do next.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum VoiceError {
    /// The provider rejected the key. `sent` is false when no key was sent at all.
    #[error("{}", invalid_key_message(service, *sent))]
    InvalidKey { service: String, sent: bool },

    /// The key works but lacks a permission (ElevenLabs: Speech to Text).
    #[error("This {service} key lacks the {permission} permission. Turn it on for the key, or create a new key with it")]
    MissingPermission { service: String, permission: String },

    /// Connection refused, DNS or TLS failure.
    #[error("{}", unreachable_message(service))]
    Unreachable { service: String },

    #[error("{service} did not answer within {} s", after.as_secs_f32().round())]
    Timeout { service: String, after: Duration },

    #[error("{service} has no model named \"{model}\"")]
    UnknownModel { service: String, model: String },

    /// Rate limited or out of quota (HTTP 429, or a quota status).
    #[error("{service} is rate limiting requests or the quota is used up")]
    Quota { service: String },

    /// The audio held no speech, or the transcript was empty.
    #[error("Didn't catch that")]
    NoSpeech,

    /// Any other error answer. `message` is redacted and at most 160 characters.
    #[error("{service} returned HTTP {status}{}", if message.is_empty() { String::new() } else { format!(": {message}") })]
    Provider { service: String, status: u16, request_id: Option<String>, message: String },

    /// An error event in the middle of a streamed answer.
    #[error("{service} stopped with an error: {message}")]
    Stream { service: String, message: String },

    /// A 2xx answer that is not what the API documents.
    #[error("{service} sent an answer Comma can't read{}", if detail.is_empty() { String::new() } else { format!(". {detail}") })]
    InvalidResponse { service: String, detail: String },

    /// The audio or request was rejected before it was sent.
    #[error("{0}")]
    InvalidInput(String),

    #[error("Cancelled")]
    Cancelled,
}

fn invalid_key_message(service: &str, sent: bool) -> String {
    if sent {
        format!("{service} rejected the API key. Check that you pasted all of it")
    } else {
        format!("{service} needs an API key. Add one and test again")
    }
}

fn unreachable_message(service: &str) -> String {
    if service == crate::llm::MAGPIE_LABEL {
        "magpie is not running on this Mac (nothing answers at 127.0.0.1:3425)".into()
    } else {
        format!("Can't reach {service}. Check the URL and your connection")
    }
}

impl VoiceError {
    /// A stable snake_case name for the kind, for IPC error codes and logs.
    pub fn kind(&self) -> &'static str {
        match self {
            VoiceError::InvalidKey { .. } => "invalid_key",
            VoiceError::MissingPermission { .. } => "missing_permission",
            VoiceError::Unreachable { .. } => "unreachable",
            VoiceError::Timeout { .. } => "timeout",
            VoiceError::UnknownModel { .. } => "unknown_model",
            VoiceError::Quota { .. } => "quota",
            VoiceError::NoSpeech => "no_speech",
            VoiceError::Provider { .. } => "provider",
            VoiceError::Stream { .. } => "stream",
            VoiceError::InvalidResponse { .. } => "invalid_response",
            VoiceError::InvalidInput(_) => "invalid_input",
            VoiceError::Cancelled => "cancelled",
        }
    }
}

pub type VoiceResult<T> = Result<T, VoiceError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages() {
        let e = VoiceError::Provider { service: "x.com".into(), status: 500, request_id: None, message: String::new() };
        assert_eq!(e.to_string(), "x.com returned HTTP 500");
        let e = VoiceError::Timeout { service: "ElevenLabs".into(), after: Duration::from_millis(2500) };
        assert_eq!(e.to_string(), "ElevenLabs did not answer within 3 s");
        assert!(VoiceError::Unreachable { service: "magpie".into() }.to_string().contains("not running"));
        assert_eq!(VoiceError::InvalidKey { service: "a.io".into(), sent: false }.to_string(), "a.io needs an API key. Add one and test again");
    }
}
