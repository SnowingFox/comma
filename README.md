# Comma

An open-source voice keyboard for macOS. Hold a shortcut, speak, release: clean, well-punctuated text appears at
your cursor.

- Speech to text with ElevenLabs Scribe, rewrite with DeepSeek or any OpenAI-compatible model.
- Use your own API keys locally, or sign in to a Comma server (self-hostable, in `apps/server`).
- Modes: Dictate, Ask Anything (rewrite the selected text or ask a question), Translate.

Status: early development. Design and contracts are in [`docs/spec.md`](docs/spec.md).

## Repository

| Path | What |
| --- | --- |
| `apps/desktop` | Tauri 2 + React + Vite desktop app (macOS, Apple Silicon) |
| `apps/server` | NestJS on Bun, Postgres via Drizzle, Docker |
| `packages/shared` | Types and zod schemas shared by the app and the server |
| `packages/multica-ui` | Multica UI, vendored (see Licensing) |

## Development

Requires Bun 1.4+, Rust (stable, `aarch64-apple-darwin`), Xcode command line tools, and Docker for the server.

```sh
bun install
bun run dev:desktop     # desktop app
bun run dev:server      # server (needs Postgres, see apps/server/README.md)
```

## Licensing

Comma's own code is MIT licensed, see [`LICENSE`](LICENSE).

The user interface is built on [Multica UI](https://github.com/multica-ai/multica) (`packages/multica-ui`), which is
under the Multica License (Apache 2.0 with additional conditions), included unmodified in
[`packages/multica-ui/LICENSE`](packages/multica-ui/LICENSE) and [`NOTICE`](packages/multica-ui/NOTICE). The Multica
logo, name and copyright are shown in the app's About screen as that license requires. Using this interface to
provide a hosted service to third parties, or inside a commercially distributed product, requires a commercial
license from Index Labs.
