//! One run: speech to text, then the mode's rewrite, with per-stage timings and events for the UI.

use std::time::{Duration, Instant};

use tokio_util::sync::CancellationToken;

use crate::error::{VoiceError, VoiceResult};
use crate::llm::{self, ChatModel, ChatRequest, Message, ReasoningEffort, Usage};
use crate::prompts::{self, AskHeaderStripper, Delivery, Mode, PromptInput};
use crate::stt::{Audio, SpeechToText, SttOptions, Transcript};

/// Everything the rewrite needs besides the text.
#[derive(Debug, Clone)]
pub struct RefineContext {
    pub mode: Mode,
    pub model: String,
    pub reasoning_effort: ReasoningEffort,
    /// Languages the speaker uses, for the prompt.
    pub languages: Vec<String>,
    /// Translate: a tag such as `ja` or a language name.
    pub target_language: Option<String>,
    pub dictionary: Vec<String>,
    /// The focused app's name.
    pub app: Option<String>,
    /// Ask Anything: the text the instruction applies to.
    pub selected_text: Option<String>,
    pub timeout: Duration,
}

impl RefineContext {
    pub fn new(mode: Mode, model: impl Into<String>) -> Self {
        Self {
            mode,
            model: model.into(),
            reasoning_effort: ReasoningEffort::Default,
            languages: Vec::new(),
            target_language: None,
            dictionary: Vec::new(),
            app: None,
            selected_text: None,
            timeout: Duration::from_secs(60),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Refined {
    pub text: String,
    /// Ask Anything only: whether the answer replaces the selection or is shown in a card.
    pub delivery: Option<Delivery>,
    pub model: String,
    pub ttft: Option<Duration>,
    pub total: Duration,
    pub usage: Usage,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    Stt,
    Llm,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    /// A stage finished after `elapsed`.
    Stage { stage: Stage, elapsed: Duration },
    /// Rewritten text as it streams (the Ask Anything header already removed).
    Delta(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct RunResult {
    pub transcript: Transcript,
    pub refined: Refined,
    pub total: Duration,
}

/// Rewrites `text` with the mode's prompt, streaming deltas to `on_delta`.
pub async fn refine<M: ChatModel>(
    llm: &M,
    text: &str,
    ctx: &RefineContext,
    cancel: CancellationToken,
    mut on_delta: impl FnMut(&str) + Send,
) -> VoiceResult<Refined> {
    if text.trim().is_empty() {
        return Err(VoiceError::NoSpeech);
    }
    if ctx.model.trim().is_empty() {
        return Err(VoiceError::InvalidInput("Pick an LLM model first".into()));
    }
    let target = ctx.target_language.as_deref().map(prompts::language_name);
    let prompt = prompts::build(&PromptInput {
        mode: ctx.mode,
        transcript: text,
        languages: &ctx.languages,
        target_language: target.as_deref(),
        dictionary: &ctx.dictionary,
        app: ctx.app.as_deref(),
        selected_text: ctx.selected_text.as_deref(),
        marker: None,
    });
    let mut req = ChatRequest::new(ctx.model.clone(), vec![Message::system(prompt.system), Message::user(prompt.user)]);
    req.reasoning_effort = ctx.reasoning_effort;
    req.timeout = ctx.timeout;

    let ask = ctx.mode == Mode::Ask;
    let mut stripper = AskHeaderStripper::default();
    let done = llm::complete(llm, req, cancel, |piece| {
        let visible = if ask { stripper.push(piece) } else { piece.to_owned() };
        if !visible.is_empty() {
            on_delta(&visible);
        }
    })
    .await?;
    let (delivery, text) = if ask {
        let (delivery, body) = prompts::parse_ask_output(&done.text);
        (Some(delivery), body)
    } else {
        (None, done.text)
    };
    Ok(Refined { text, delivery, model: done.model, ttft: done.ttft, total: done.total, usage: done.usage })
}

/// Transcribes `audio`, then rewrites it. Silence ends the run with [`VoiceError::NoSpeech`].
pub async fn run<S: SpeechToText, M: ChatModel>(
    stt: &S,
    llm: &M,
    audio: Audio,
    stt_opts: &SttOptions,
    ctx: &RefineContext,
    cancel: CancellationToken,
    mut on_event: impl FnMut(Event) + Send,
) -> VoiceResult<RunResult> {
    let started = Instant::now();
    let opts = SttOptions { cancel: Some(cancel.clone()), ..stt_opts.clone() };
    let transcript = stt.transcribe(audio, &opts).await?;
    on_event(Event::Stage { stage: Stage::Stt, elapsed: transcript.timing });
    if transcript.text.trim().is_empty() {
        return Err(VoiceError::NoSpeech);
    }
    let refined = refine(llm, &transcript.text, ctx, cancel, |piece| on_event(Event::Delta(piece.to_owned()))).await?;
    on_event(Event::Stage { stage: Stage::Llm, elapsed: refined.total });
    Ok(RunResult { transcript, refined, total: started.elapsed() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::Delta;
    use futures_util::Stream;
    use std::sync::Mutex;

    /// A model that answers with fixed deltas and records the request.
    struct Fake {
        deltas: Vec<&'static str>,
        seen: Mutex<Option<ChatRequest>>,
    }

    impl ChatModel for Fake {
        async fn stream(&self, req: ChatRequest, _cancel: CancellationToken) -> VoiceResult<impl Stream<Item = VoiceResult<Delta>> + Send + 'static> {
            *self.seen.lock().unwrap() = Some(req);
            let items: Vec<VoiceResult<Delta>> = self.deltas.iter().map(|d| Ok(Delta::Text((*d).to_owned()))).collect();
            Ok(futures_util::stream::iter(items))
        }
        async fn list_models(&self) -> VoiceResult<Vec<String>> {
            Ok(vec![])
        }
        fn label(&self) -> String {
            "fake".into()
        }
    }

    struct FakeStt(&'static str);

    impl SpeechToText for FakeStt {
        async fn transcribe(&self, _audio: Audio, opts: &SttOptions) -> VoiceResult<Transcript> {
            assert!(opts.cancel.is_some(), "the run passes its token down");
            Ok(Transcript { text: self.0.into(), language: "eng".into(), language_probability: Some(1.0), duration: None, attempts: vec![], timing: Duration::from_millis(5) })
        }
    }

    fn fake(deltas: Vec<&'static str>) -> Fake {
        Fake { deltas, seen: Mutex::new(None) }
    }

    #[tokio::test]
    async fn run_emits_stages_and_strips_the_ask_header() {
        let llm = fake(vec!["DELIVERY: inline\n", "Short", "er."]);
        let mut ctx = RefineContext::new(Mode::Ask, "m");
        ctx.selected_text = Some("A long sentence.".into());
        let mut events = Vec::new();
        let out = run(&FakeStt("make it shorter"), &llm, Audio::wav(vec![1]), &SttOptions::default(), &ctx, CancellationToken::new(), |e| events.push(e))
            .await
            .unwrap();
        assert_eq!((out.refined.text.as_str(), out.refined.delivery), ("Shorter.", Some(Delivery::Inline)));
        let deltas: String = events.iter().filter_map(|e| if let Event::Delta(d) = e { Some(d.as_str()) } else { None }).collect();
        assert_eq!(deltas, "Shorter.");
        assert!(matches!(events.first(), Some(Event::Stage { stage: Stage::Stt, .. })));
        assert!(matches!(events.last(), Some(Event::Stage { stage: Stage::Llm, .. })));
        let req = llm.seen.lock().unwrap().clone().unwrap();
        assert!(req.messages[1].content.contains("<<<BEGIN selected_text"));
    }

    #[tokio::test]
    async fn translate_names_the_target_and_silence_is_no_speech() {
        let llm = fake(vec!["Bonjour."]);
        let mut ctx = RefineContext::new(Mode::Translate, "m");
        ctx.target_language = Some("fr".into());
        let out = refine(&llm, "hello", &ctx, CancellationToken::new(), |_| {}).await.unwrap();
        assert_eq!((out.text.as_str(), out.delivery), ("Bonjour.", None));
        assert!(llm.seen.lock().unwrap().as_ref().unwrap().messages[0].content.contains("written in French"));

        let err = run(&FakeStt("  "), &llm, Audio::wav(vec![1]), &SttOptions::default(), &ctx, CancellationToken::new(), |_| {}).await.unwrap_err();
        assert_eq!(err, VoiceError::NoSpeech);
        assert!(matches!(refine(&llm, "x", &RefineContext::new(Mode::Dictate, ""), CancellationToken::new(), |_| {}).await, Err(VoiceError::InvalidInput(_))));
    }
}
