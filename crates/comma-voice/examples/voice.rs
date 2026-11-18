//! Manual check: one transcription and one rewrite, configured from the environment.
//!
//! ```sh
//! ELEVENLABS_API_KEY=... COMMA_WAV=clip.wav cargo run -p comma-voice --example voice
//! COMMA_TEXT="um so we meet tuesday no wednesday" COMMA_MODEL=deepseek-chat cargo run -p comma-voice --example voice
//! ```
//!
//! | Variable | Default |
//! | --- | --- |
//! | `ELEVENLABS_API_KEY` | unset: transcription is skipped |
//! | `COMMA_WAV` | a generated one-second clip |
//! | `COMMA_STT_MODEL` | `scribe_v3` |
//! | `COMMA_LANGUAGES` | empty, comma separated, e.g. `zh,en` |
//! | `COMMA_LLM_BASE_URL` | magpie, `http://127.0.0.1:3425/v1` |
//! | `COMMA_LLM_API_KEY` | none |
//! | `COMMA_MODEL` | the first model the endpoint lists |
//! | `COMMA_MODE` | `dictate` (`ask`, `translate`) |
//! | `COMMA_TARGET` | `en`, for translate |
//! | `COMMA_TEXT` | the transcript, else a sample sentence |
//!
//! Keys are read from the environment and never printed.

use std::env;

use comma_voice::llm::{ChatModel, MAGPIE_BASE_URL, OpenAiCompatible};
use comma_voice::pipeline::{self, RefineContext};
use comma_voice::prompts::Mode;
use comma_voice::stt::{Audio, ElevenLabs, SpeechToText, SttOptions};
use comma_voice::{CancellationToken, http, wav};

fn var(name: &str) -> Option<String> {
    env::var(name).ok().filter(|v| !v.trim().is_empty())
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = http::client();
    let languages: Vec<String> = var("COMMA_LANGUAGES").map(|l| l.split(',').map(|s| s.trim().to_owned()).collect()).unwrap_or_default();

    let mut text = var("COMMA_TEXT");
    if let Some(key) = var("ELEVENLABS_API_KEY") {
        let audio = match var("COMMA_WAV") {
            Some(path) => Audio::wav(std::fs::read(path)?),
            None => Audio::wav(wav::test_clip()),
        };
        let stt = ElevenLabs::new(client.clone(), key, var("COMMA_STT_MODEL").unwrap_or_else(|| "scribe_v3".into()));
        let opts = SttOptions { languages: languages.clone(), auto_detect: true, ..Default::default() };
        let t = stt.transcribe(audio, &opts).await?;
        println!("transcript ({}, p={:?}, {} ms, {} call(s)): {}", t.language, t.language_probability, t.timing.as_millis(), t.attempts.len(), t.text);
        text = text.or(Some(t.text));
    } else {
        println!("ELEVENLABS_API_KEY is not set: skipping transcription");
    }

    let base = var("COMMA_LLM_BASE_URL").unwrap_or_else(|| MAGPIE_BASE_URL.into());
    let llm = OpenAiCompatible::new(client, base, var("COMMA_LLM_API_KEY"));
    let model = match var("COMMA_MODEL") {
        Some(m) => m,
        None => llm.list_models().await?.into_iter().next().ok_or("the endpoint lists no models")?,
    };
    let mode = match var("COMMA_MODE").as_deref() {
        Some("ask") => Mode::Ask,
        Some("translate") => Mode::Translate,
        _ => Mode::Dictate,
    };
    let mut ctx = RefineContext::new(mode, model);
    ctx.languages = languages;
    ctx.target_language = Some(var("COMMA_TARGET").unwrap_or_else(|| "en".into()));
    let text = text.filter(|t| !t.trim().is_empty()).unwrap_or_else(|| "so um we meet on tuesday, no wait, wednesday at three".into());
    println!("{} via {} ({mode:?}):", ctx.model, llm.label());
    let out = pipeline::refine(&llm, &text, &ctx, CancellationToken::new(), |piece| {
        print!("{piece}");
        let _ = std::io::Write::flush(&mut std::io::stdout());
    })
    .await?;
    println!(
        "\n[{} answered, first token {:?} ms, total {} ms, reasoning tokens {:?}]",
        out.model,
        out.ttft.map(|d| d.as_millis()),
        out.total.as_millis(),
        out.usage.reasoning_tokens
    );
    Ok(())
}
