//! Comma's voice pipeline, independent of Tauri and the Keychain: the caller passes in keys and
//! settings.
//!
//! - [`stt`]: [`stt::SpeechToText`] and the [`stt::ElevenLabs`] implementation (keyterms, the one
//!   language retry).
//! - [`llm`]: [`llm::ChatModel`] and [`llm::OpenAiCompatible`] (magpie, DeepSeek, any base URL),
//!   streamed with time to first token and reasoning tokens.
//! - [`prompts`]: the dictate, ask and translate prompts with untrusted text in delimited blocks.
//! - [`pipeline`]: [`pipeline::run`] composes the two with stage and delta events.
//! - [`error`]: [`VoiceError`], whose messages never contain a key.
//! - [`wav`]: WAV encoding and a short test clip.
//!
//! ```no_run
//! # async fn demo() -> Result<(), comma_voice::VoiceError> {
//! use comma_voice::{http, llm::{ChatModel, OpenAiCompatible}};
//! let magpie = OpenAiCompatible::magpie(http::client());
//! let models = magpie.list_models().await?;
//! # Ok(()) }
//! ```

pub mod error;
pub mod http;
pub mod llm;
pub mod pipeline;
pub mod prompts;
pub mod stt;
pub mod wav;

pub use error::{VoiceError, VoiceResult};
pub use tokio_util::sync::CancellationToken;
