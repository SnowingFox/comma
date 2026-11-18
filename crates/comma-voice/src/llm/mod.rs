//! Chat models: the [`ChatModel`] trait, request and delta types, and [`complete`], which drains a
//! stream into text, usage and time to first token.

mod openai;

use std::future::Future;
use std::time::{Duration, Instant};

use futures_util::{Stream, StreamExt};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::error::VoiceResult;

pub use openai::{MAGPIE_BASE_URL, OpenAiCompatible, SseParser, parse_models};

/// The name magpie gets in messages.
pub const MAGPIE_LABEL: &str = "magpie";

/// Off is sent as `"none"`, Default leaves the field out (spec 3.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningEffort {
    Off,
    Low,
    Medium,
    High,
    #[default]
    Default,
}

impl ReasoningEffort {
    pub fn wire_value(self) -> Option<&'static str> {
        match self {
            ReasoningEffort::Off => Some("none"),
            ReasoningEffort::Low => Some("low"),
            ReasoningEffort::Medium => Some("medium"),
            ReasoningEffort::High => Some("high"),
            ReasoningEffort::Default => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Message {
    pub role: Role,
    pub content: String,
}

impl Message {
    pub fn system(content: impl Into<String>) -> Self {
        Self { role: Role::System, content: content.into() }
    }
    pub fn user(content: impl Into<String>) -> Self {
        Self { role: Role::User, content: content.into() }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<Message>,
    pub reasoning_effort: ReasoningEffort,
    pub max_tokens: Option<u32>,
    pub temperature: Option<f32>,
    /// Total time for the call, body included.
    pub timeout: Duration,
}

impl ChatRequest {
    pub fn new(model: impl Into<String>, messages: Vec<Message>) -> Self {
        Self {
            model: model.into(),
            messages,
            reasoning_effort: ReasoningEffort::Default,
            max_tokens: None,
            temperature: None,
            timeout: Duration::from_secs(60),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Usage {
    pub prompt_tokens: Option<u64>,
    pub completion_tokens: Option<u64>,
    pub reasoning_tokens: Option<u64>,
}

/// One piece of a streamed answer.
#[derive(Debug, Clone, PartialEq)]
pub enum Delta {
    /// Answer text.
    Text(String),
    /// Thinking text from reasoning models (`reasoning_content`), not part of the answer.
    Reasoning(String),
    /// The model that answers, as the endpoint names it.
    Model(String),
    Usage(Usage),
}

/// An OpenAI-compatible chat endpoint, or a fake one in tests.
pub trait ChatModel: Send + Sync {
    /// Starts a streamed completion. The stream ends early with `Cancelled` when `cancel` fires.
    fn stream(
        &self,
        req: ChatRequest,
        cancel: CancellationToken,
    ) -> impl Future<Output = VoiceResult<impl Stream<Item = VoiceResult<Delta>> + Send + 'static>> + Send;

    /// Model ids from `GET {base}/models`, sorted.
    fn list_models(&self) -> impl Future<Output = VoiceResult<Vec<String>>> + Send;

    /// The name used in messages ("magpie", or the host).
    fn label(&self) -> String;
}

/// A drained completion.
#[derive(Debug, Clone, PartialEq)]
pub struct Completion {
    pub text: String,
    /// As reported by the endpoint, else the one requested.
    pub model: String,
    /// Request start to the first answer token; `None` when no answer text arrived.
    pub ttft: Option<Duration>,
    pub total: Duration,
    pub usage: Usage,
}

/// Streams `req` to the end, calling `on_text` for every answer delta.
pub async fn complete<M: ChatModel>(
    model: &M,
    req: ChatRequest,
    cancel: CancellationToken,
    mut on_text: impl FnMut(&str) + Send,
) -> VoiceResult<Completion> {
    let started = Instant::now();
    let mut out = Completion { text: String::new(), model: req.model.clone(), ttft: None, total: Duration::ZERO, usage: Usage::default() };
    let stream = model.stream(req, cancel).await?;
    let mut stream = std::pin::pin!(stream);
    while let Some(delta) = stream.next().await {
        match delta? {
            Delta::Text(piece) if !piece.is_empty() => {
                out.ttft.get_or_insert_with(|| started.elapsed());
                on_text(&piece);
                out.text.push_str(&piece);
            }
            Delta::Model(name) if !name.is_empty() => out.model = name,
            Delta::Usage(usage) => {
                out.usage = Usage {
                    prompt_tokens: usage.prompt_tokens.or(out.usage.prompt_tokens),
                    completion_tokens: usage.completion_tokens.or(out.usage.completion_tokens),
                    reasoning_tokens: usage.reasoning_tokens.or(out.usage.reasoning_tokens),
                }
            }
            _ => {}
        }
    }
    out.text = out.text.trim().to_owned();
    out.total = started.elapsed();
    Ok(out)
}
