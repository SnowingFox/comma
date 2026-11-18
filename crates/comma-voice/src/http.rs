//! Shared HTTP client and the helpers that turn transport failures into precise, key-free errors.

use std::future::Future;
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use crate::error::{VoiceError, VoiceResult};

/// A client suitable for every provider: rustls, no system proxy (local endpoints must not be
/// proxied), a short connect timeout. Each request sets its own total timeout.
pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(concat!("Comma/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(4))
        .no_proxy()
        .build()
        .expect("the HTTP client configuration is static")
}

/// `127.0.0.1:3425` from `http://127.0.0.1:3425/v1`, without any `user:pass@`.
pub fn host_of(url: &str) -> &str {
    let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
    let host = rest.split(['/', '?', '#']).next().unwrap_or_default();
    host.rsplit_once('@').map_or(host, |(_, h)| h)
}

pub fn is_loopback(url: &str) -> bool {
    let host = host_of(url);
    let name = host.rsplit_once(':').map_or(host, |(h, _)| h);
    matches!(name, "127.0.0.1" | "localhost" | "[::1]")
}

/// A request that never got an HTTP answer: refused, unresolvable, TLS failure or timed out.
pub fn send_error(err: &reqwest::Error, service: &str, timeout: Duration) -> VoiceError {
    if err.is_timeout() {
        VoiceError::Timeout { service: service.into(), after: timeout }
    } else {
        VoiceError::Unreachable { service: service.into() }
    }
}

/// Runs `fut` unless `cancel` fires first.
pub async fn cancellable<T>(cancel: Option<&CancellationToken>, fut: impl Future<Output = T>) -> VoiceResult<T> {
    match cancel {
        Some(token) => tokio::select! {
            biased;
            () = token.cancelled() => Err(VoiceError::Cancelled),
            value = fut => Ok(value),
        },
        None => Ok(fut.await),
    }
}

/// Replaces every occurrence of each secret with `[redacted]`. Applied to anything upstream sends
/// back before it can reach a message.
pub fn redact(text: &str, secrets: &[&str]) -> String {
    let mut out = text.to_owned();
    for secret in secrets.iter().filter(|s| s.len() >= 4) {
        out = out.replace(secret, "[redacted]");
    }
    out
}

/// Upstream error text made safe to show: one line, redacted, at most `max` characters.
pub fn clip_detail(text: &str, secrets: &[&str], max: usize) -> String {
    let one_line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let redacted = redact(&one_line, secrets);
    if redacted.chars().count() <= max {
        return redacted;
    }
    let cut: String = redacted.chars().take(max).collect();
    format!("{}…", cut.trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts_and_loopback() {
        assert_eq!(host_of("http://127.0.0.1:3425/v1"), "127.0.0.1:3425");
        assert_eq!(host_of("https://user:pw@api.example.com/v1?x"), "api.example.com");
        assert!(is_loopback("http://localhost:8787"));
        assert!(is_loopback("http://127.0.0.1:3425/v1"));
        assert!(!is_loopback("https://api.deepseek.com/v1"));
    }

    #[test]
    fn redacts_and_clips() {
        assert_eq!(redact("bad key sk_live_1234 here", &["sk_live_1234"]), "bad key [redacted] here");
        assert_eq!(clip_detail("a\n  b   c", &[], 10), "a b c");
        assert_eq!(clip_detail("abcdefghijkl", &[], 5), "abcde…");
        // Short strings are not treated as secrets, so they cannot blank out ordinary words.
        assert_eq!(redact("a b", &["a"]), "a b");
    }

    #[tokio::test]
    async fn cancellation_wins() {
        let token = CancellationToken::new();
        token.cancel();
        let out = cancellable(Some(&token), std::future::pending::<()>()).await;
        assert_eq!(out, Err(VoiceError::Cancelled));
        assert_eq!(cancellable(None, async { 3 }).await, Ok(3));
    }
}
