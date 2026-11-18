# Comma: product and engineering spec (v0.1)

Comma is an open-source voice keyboard for macOS (Apple Silicon). Hold a shortcut, speak, release: clean,
well-punctuated text appears at the cursor. Speech-to-text runs on ElevenLabs and the rewrite on DeepSeek or any
OpenAI-compatible model. Use your own keys locally, or sign in to a Comma account and use its credits; the Comma
server is open source and self-hostable (section 5).

This file is the contract between the parts of the codebase. Change it in the same commit as the code that changes
the behaviour.

## 1. Scope (v0.1)

| Area | In v0.1 | Not in v0.1 |
|---|---|---|
| Modes | Dictate, Ask Anything (instruction on the selected text, or a question), Translate | Auto-learning dictionary |
| Shortcuts | Fn-based defaults (Fn, Fn+Space, Fn+Left Shift), hold-to-talk, double press for hands-free, Esc to cancel, all configurable; ordinary key combinations as the fallback | Per-app shortcuts |
| Output | Paste at the cursor of the focused app (clipboard is restored afterwards); copy-only fallback | Rich text |
| Context | Only on a run the user starts: focused app name, and for Ask Anything the selected text. Off switch in Settings | Reading other text on screen |
| Data | Local history and usage in SQLite, dictionary | Sync, accounts |
| Platform | macOS 13+, arm64 | Intel, Windows, Linux |

Privacy rules: to detect Fn, Comma watches only the state of the modifier keys and the configured trigger keys, with
the macOS Input Monitoring permission that onboarding asks for and explains; no other key is ever recorded, stored or
sent, and without the permission Comma falls back to ordinary registered shortcuts; audio is recorded only between shortcut press and release and is not stored unless "Keep audio" is on; nothing is read from
other apps except what the table above lists, and only during a run; API keys live in the macOS Keychain.

## 2. Interaction design

The bar for feel and polish is the best dictation apps on the market. Comma designs its own visual language, copy,
icons, sounds and animations. **Never copy any asset, text, illustration, video, sound or code from another
product.**

### 2.1 Dictation loop (floating bar)

1. Idle: hidden, or a 6 px dot at the bottom centre when "Show bar when idle" is on.
2. Shortcut down (Dictate, default `Fn` held): a soft synthesised tick, the bar springs from the dot into a
   pill (~220 ms). Recording starts at once.
3. Recording: live waveform from the mic level (10 bars, smoothed), mode icon, timer after 3 s. Release ends it.
   Pressing Fn twice within 300 ms starts hands-free mode (lock icon); the next press ends it. Esc cancels
   (short shake, fade out, nothing inserted).
4. Processing: the waveform folds into a shimmering line; after 2 s a quiet "Still working" label fades in.
5. Done: text is pasted, a check shows for 600 ms, the bar shrinks back. A second, higher tick plays.
6. Error: a compact error card (one line, "Details" opens the run in the hub), hides after 4 s. Silence gives a soft
   "Didn't catch that", not an error.

The bar is a transparent, always-on-top, non-focusable window on the screen that has the mouse.

### 2.2 Ask Anything (default `Fn+Space`, press to start, press to stop)

With selected text, the instruction applies to it and the result replaces the selection. Without a selection the
answer shows in a floating card above the bar (Copy, Insert, Esc closes); it is never auto-inserted.

### 2.3 Translate (default `Fn+Left Shift`, held)

Output in the first of up to 3 target languages from Settings; the bar shows the language code while recording.

### 2.3.1 Bar hints

Short, dismissible hints next to the bar teach the shortcuts while they are used (each shown at most a few times, then
never again; all off with one switch in Settings):

- Ask Anything held like Dictate: "No need to hold. Press once, speak, press again."
- After a few long dictations: "Press Fn twice to keep talking hands-free."
- Speaking into a field Comma cannot paste into: the text is copied, with "Copied. Paste it with Cmd+V."
- A clearly better microphone is connected: "Switch to <device>?" with Switch and Not now.
- Permission lost or signed out: one line with a button that opens the fix.
- Right-click on the bar opens a small menu: copy last result, output language, open Comma.

### 2.4 Onboarding (first launch; can be rerun from Settings)

Its own 960 x 640 window, step indicator (`Set up > Try it > Done`), one task per step, an illustration made of our
own SVG with motion, primary action bottom right, Back bottom left, step transitions slide 24 px and fade (200 ms).

The indicator has three phases (`Set up > Try it > Done`) with a thin progress bar under it that animates its width
as steps advance. Each phase holds several steps. Every step in Try it has Skip; the whole flow can be rerun from
Settings and resumes at the last unfinished step if the window is closed.

Set up:

1. Welcome: one-line promise, Get started.
2. How Comma runs: choose Local (your own keys) or Comma account (sign in or create an account). Local leads to 3,
   account leads to sign-in and skips 3.
3. Keys: ElevenLabs key (needs the Speech to Text permission; link to where to create one) and LLM endpoint. magpie
   is detected automatically at `http://127.0.0.1:3425/v1` (live status dot, model count, pick a model from its list);
   otherwise custom base URL, key and model. Each provider has Test with inline latency and a precise error.
4. Permissions: Microphone and Accessibility rows with what each is for, live status (polled every second), and a
   button that opens the right System Settings pane; rows turn green as they are granted. A short "Where your data
   goes" panel next to them, with two tabs (Local, Comma account) in plain words.
5. Languages: chips for the languages you speak (auto-detect on by default); the first one is the fallback when
   detection is unsure.
6. Microphone test: level meter, device picker, "Say a sentence"; the raw transcript appears under the meter.
7. Shortcut test (Dictate): a keyboard illustration lights the configured keys while held ("Do the keys light up?");
   Yes enables after one press; No opens the shortcut recorder.

Try it (each mode: shortcut test, a one-line intro, a sample to try):

8. Dictate: a sample chat with an empty message box; hold the shortcut, speak, release; the refined text lands in the
   box with a highlight sweep, with a toggle to compare it with the raw transcript.
9. Ask Anything: a sample paragraph; select it and ask for a change ("make it shorter"), the result replaces it; then
   ask a question with nothing selected and see the answer card.
10. Translate: pick up to three target languages, then dictate into a sample box and see the translation.

Done:

11. The three shortcuts as keycaps, one closing line, Open Comma.

Motion: step content slides 24 px and fades (200 ms ease-out); keycaps press down (scale 0.96, accent fill, 120 ms);
status rows tick from amber to green with a short spring; inserted text gets a left-to-right highlight sweep (600 ms);
everything honours reduced motion. Illustrations, copy and sounds are Comma's own.

### 2.5 Hub window

App shell ported from Multica UI: collapsible left sidebar (logo, nav, footer), content with a page header.

- Home: today and this week (words, runs, time saved assuming 40 wpm typing), shortcut cheat sheet, recent runs.
- History: search, grouped by day; detail drawer with raw and refined text, timing waterfall (STT, LLM first token,
  rest), tokens, cost; copy, rerun the rewrite, delete.
- Dictionary: terms with add, edit, delete, CSV import. Sent to ElevenLabs as keyterms (+20% STT price; each term at
  most 50 characters and 5 words) and to the LLM prompt.
- Usage: runs, audio minutes, STT cost, tokens per day (chart), breakdown by mode, model and app, p50/p95 per stage,
  CSV export.
- Settings: Speech to text, LLM (provider, model picker from `/models`, reasoning effort Off/Low/Medium/High/Default,
  temperature, max tokens, extra body JSON), Context, Shortcuts, Sounds and bar, Privacy (history retention, keep
  audio), Permissions, About (version, licenses, and the Multica attribution required by the Multica License: the
  Multica logo, name and copyright, "UI built with Multica UI").

Copy: short, plain, second person, no exclamation marks.

## 3. Architecture

```
comma/
  packages/multica-ui/     vendored Multica UI (Multica License, see its LICENSE and NOTICE), pinned in UPSTREAM_COMMIT
  src/                     React + Vite + Tailwind v4 frontend, three windows: hub, onboarding, bar
  src-tauri/               Rust: shortcuts, windows, pipeline, storage, paste
```

### 3.1 Frontend (React, Vite, Tailwind v4, Multica UI / shadcn base-nova)

- Entry per window: `src/windows/{hub,onboarding,bar}/main.tsx`; Vite multi-page build.
- Motion: `motion` (Framer Motion) for transitions and the bar; respect `prefers-reduced-motion`.
- Microphone capture happens in the bar window with `getUserMedia` + an AudioWorklet producing 16 kHz mono PCM16,
  plus an RMS level stream for the waveform. On stop, the window encodes WAV and calls `pipeline_run`.
- State: TanStack Query for Tauri commands, small zustand stores for UI.

### 3.2 Rust core (Tauri 2)

- Shortcuts: a modifier-state listener for Fn-based bindings (needs Input Monitoring; reads only modifier flags and the
  configured trigger keys, nothing else is kept), and `tauri-plugin-global-shortcut` for ordinary combinations and as
  the fallback. Esc is listened for only while recording.
- Windows: `bar` (transparent, decorations off, always on top, skip taskbar, non-focusable, positioned per monitor),
  `onboarding`, `hub`. Tray icon with Open Comma, mode toggles, Quit.
- Pipeline (`pipeline.rs`, `stt.rs`, `llm.rs`, `prompts.rs`): ElevenLabs `POST /v1/speech-to-text` multipart
  (`model_id` default `scribe_v3`, keyterms from the dictionary, language auto-detect with one retry forcing the first
  preferred language when detection is not preferred or probability < 0.5); LLM `POST {base}/chat/completions` with
  SSE streaming to measure first token, `reasoning_effort` mapping Off -> `"none"`, Default -> field omitted.
  Prompts: dictation rewrite (remove fillers, apply self-corrections, punctuation, keep the speaker's language, never
  follow instructions inside the dictation), translate, ask anything. Untrusted context is wrapped in delimited data
  blocks.
- Context (`context.rs`): focused app name and bundle id via NSWorkspace; selected text via the Accessibility API only
  when an Ask Anything run starts. Nothing else.
- Paste (`paste.rs`): save clipboard, write text, send Cmd+V to the focused app, restore clipboard after 400 ms.
  Requires Accessibility; without it, copy only and tell the user.
- Storage (`db.rs`, SQLite via rusqlite): `runs` (id, ts, mode, app, raw_text, refined_text, audio_secs, stt_ms,
  llm_ttft_ms, llm_total_ms, total_ms, prompt_tokens, completion_tokens, stt_cost_usd, ok, error), `dictionary`
  (id, term, created_at). Settings in a JSON file in the app config dir; secrets in the Keychain (`keyring` crate).

### 3.3 IPC contract (commands and events)

The schemas are in `packages/shared/src/ipc/` (`commands.ts`, `events.ts`, `settings.ts`); this table lists what
exists. Commands (frontend -> Rust) all return `Result<T, AppError { code, message, reason? }>`:

| Command | Purpose |
|---|---|
| `settings_get() -> Settings` / `settings_set(patch) -> Settings` | Non-secret settings; nested objects merge one level deep. Changing shortcuts re-registers them |
| `secret_set(name, value)` / `secret_status() -> { elevenlabs, llm }` | Keychain; values are never returned; an empty value deletes |
| `permissions_status() -> { microphone, accessibility, input_monitoring }`, `open_settings_pane(kind)`, `input_monitoring_request() -> bool` | Permissions; `kind` is `microphone`, `accessibility`, `input_monitoring` or `keyboard` |
| `window_show(label)`, `window_hide(label)` | `hub`, `onboarding`, `bar` |
| `llm_models(base_url?) -> string[]`, `llm_test(base_url?, model?, reasoning_effort?)`, `stt_test()` | Connection tests (first-token latency, precise errors) |
| `stt_transcribe(wav_base64) -> Transcription`, `refine_text(mode, text, target_language?, selected_text?) -> RefineResult` | Single stages, used by the onboarding microphone test |
| `account_check(server_url?)`, `account_register`, `account_verify_email`, `account_resend_code`, `account_sign_in -> AccountStatus`, `account_status`, `account_sign_out`, `account_credits -> Credits` | Comma account; tokens stay in the Keychain, refreshed on 401 |
| `shortcuts_status() -> ShortcutsStatus` | `listener` (`fn` or `fallback`), the shortcut each mode answers to now, registration errors, the Globe key setting |
| `shortcuts_capture(owner)` | While the onboarding window is focused, shortcut events go to it instead of the bar |
| `shortcuts_suspend(suspended)` | Shortcut recorder open: nothing is registered or matched, so its keys reach the window |
| `pipeline_run({ mode, audio_base64, audio_secs?, source, target_language?, selected_text?, record_ms? }) -> RunResult` | Full run (Local or Comma account), WAV or Ogg/Opus; output (paste, copy, answer), history, hints; emits progress events |
| `pipeline_cancel()` | Stops the run in flight |
| `output_insert(text) -> RunOutput`, `clipboard_copy(text)` | Answer card Insert and Copy |
| `bar_layout(layout, interactive, escape?)`, `bar_menu()` | Bar window size and position (`hidden`, `dot`, `full`) on the screen with the mouse; the right-click menu |
| `hint_take(kind) -> bool`, `hints_reset()` | Bar hints: may it show now (counted), and start the counts over |
| `runs_list({ search?, before?, limit? })`, `run_get(id)`, `run_delete(id)`, `runs_clear()`, `run_rerun(id)`, `run_audio(id)` | History |
| `usage_summary(range)`, `usage_daily(range)`, `usage_export_csv(range) -> { path }` | Usage; `range` is `today`, `7d`, `30d`, `90d` |
| `dictionary_list`, `dictionary_add(term)`, `dictionary_update(id, term)`, `dictionary_delete(id)`, `dictionary_import_csv(csv)` | Dictionary: local terms in Local mode, the server's in account mode |

Events (Rust -> frontend, and window to window):

| Event | Payload | Notes |
|---|---|---|
| `shortcut://down`, `shortcut://up`, `shortcut://cancel` | `{ mode }` | To the bar, or to onboarding while it captures |
| `shortcut://switch` | `{ mode, hands_free }` | Mode changed mid-recording (Fn, then Space), or hands-free locked |
| `shortcut://keys` | `{ held }` | Only configured keys, for the keyboard test |
| `run://stage` | `{ id, stage: stt\|llm\|paste, ms }` | |
| `run://delta` | `{ id, text }` | Streamed rewrite (Local mode) |
| `run://done` | `{ id, result }` | |
| `run://error` | `{ id, code, message, reason? }` | `reason` such as `quota_exceeded`, `signed_out` |
| `bar://hint` | `{ kind }` | Hint to show (already counted) |
| `bar://preview` | `{ state, mode?, message? }` | Dev only |
| `history://changed` | `{ id? }` | The hub refetches |
| `hub://open` | `{ page, section? }` | Bar -> hub: Details, Sign in |
| `settings://changed` | `{}` | Another window or Rust changed settings |
| `onboarding://restart` | `{ step? }` | Hub -> onboarding |

## 4. Quality bar

- `pnpm typecheck`, `pnpm test` (Vitest for the frontend), `cargo test` and `cargo clippy -- -D warnings` pass.
- No secrets in logs, errors or the frontend. Keys are write-only from the UI.
- Release build: `pnpm tauri build --target aarch64-apple-darwin`, ad-hoc signed, `.dmg` output.

## 5. Server (`apps/server`)

The desktop app works in one of two modes, chosen in onboarding and switchable in Settings:

- **Local**: the app calls ElevenLabs and the LLM directly with the user's own keys (Keychain).
- **Comma account**: the app signs in to a Comma server, which holds the provider keys, runs the pipeline and meters
  usage. The server is open source and self-hostable with Docker.

### 5.1 Stack (aligned with the NestJS service in our reference repo)

NestJS 12 on Bun (no build step, `bun src/main.ts`), Drizzle ORM + Postgres via `@nestjs/drizzle`, zod validation on
every input, typed config with `nest-typed-config` validated by zod, global auth guard with `@Public()` for
pre-session routes, property injection, Nest `Logger`, `@nestjs/throttler`, `@nestjs/terminus` health. Layout:
`src/{main.ts,app.module.ts,app.config.ts,migrate.ts}`, `src/entity/<domain>/*.entity.ts`,
`src/modules/<feature>/{*.module,*.controller,*.service}.ts` with `dto/` and `guards/`, `src/utils/`,
`drizzle/` migrations, `test/` with `bun test` against a real Postgres. `Dockerfile` (oven/bun alpine) and a
`docker-compose.yml` with Postgres for local and self-hosted runs. Never log tokens, codes or keys.

### 5.2 Modules and API (all under `/v1`, JSON, errors `{ code, message }`)

| Module | Routes | Notes |
| --- | --- | --- |
| health | `GET /v1/health` | public |
| auth | `POST /v1/auth/register` (email, password, name), `POST /v1/auth/verify-email` (email, code), `POST /v1/auth/login`, `POST /v1/auth/refresh`, `POST /v1/auth/logout`, `POST /v1/auth/password/forgot`, `POST /v1/auth/password/reset` | argon2id via `Bun.password`; 6-digit email codes (hashed, 10 min, 5 attempts); access JWT 15 min (jose, HS256 from config) + rotating refresh token stored hashed, bound to a device; mailer is an interface with SMTP and a dev console implementation |
| user | `GET /v1/me`, `PATCH /v1/me`, `DELETE /v1/me` | profile, plan, settings that sync (languages, translate targets, context level) |
| device | `GET /v1/devices`, `DELETE /v1/devices/:id` | one row per signed-in app install |
| voice | `POST /v1/voice/runs` (multipart: `audio` WAV/Ogg, `meta` JSON: mode, target_language, app name, selected_text, client timings) -> `{ id, raw_text, refined_text, detected_language, timings, usage }`; `GET /v1/voice/runs/:id/stream` SSE variant for streamed refined text | server-side ElevenLabs + LLM with the same pipeline and prompts as local mode (ported from our prototype); size limit 25 MB, 10 min audio |
| dictionary | `GET/POST /v1/dictionary`, `PATCH/DELETE /v1/dictionary/:id`, `POST /v1/dictionary/import` | used as STT keyterms and in the LLM prompt |
| history | `GET /v1/history`, `DELETE /v1/history/:id`, `DELETE /v1/history` | stored only when the user enables "Sync history"; otherwise the server keeps metrics without text |
| usage | `GET /v1/usage/summary?range=`, `GET /v1/usage/daily?range=` | audio seconds, tokens, cost estimate |
| quota | enforced in voice | per-plan weekly audio minutes (`free` default from config); 402 with `{ code: "quota_exceeded" }` |

Entities: `users`, `email_codes`, `refresh_tokens`, `devices`, `dictionary_terms`, `voice_runs` (metrics; text
columns nullable and filled only with sync on), `plans`.

### 5.3 Shared contract

`packages/shared` exports zod schemas and TypeScript types for every request and response above and for the desktop
IPC payloads in section 3.3, so the app and the server can never drift. Both sides import it; no hand-written copies.

## 6. Delivery plan

| Phase | Desktop | Server |
| --- | --- | --- |
| 1 Foundations | Multica UI wired in (Tailwind v4, tokens, theme), hub shell with sidebar and empty pages, onboarding window shell, floating bar window, settings store, Keychain, permission status | NestJS skeleton, config, Drizzle + migrations, health, Docker compose, auth (register, verify, login, refresh, logout), user, device |
| 2 Dictation | shortcuts, mic capture, local pipeline (STT + LLM, language retry, keyterms), paste, bar animations and states, history and usage in SQLite | voice runs, dictionary, usage, quota |
| 3 Modes and polish | Ask Anything and Translate, onboarding steps with tests, sounds, error states, release build (dmg, arm64) | history sync, password reset, rate limits |
| Later | typing mode (inline completion, switch between speak and type) | team plans |

## 7. Licensing

Comma's own code is MIT (root `LICENSE`). `packages/multica-ui/` is Multica UI under the Multica License (its own
`LICENSE` and `NOTICE`, unmodified). Because Comma's interface is derived from Multica UI, the app is a "Multica user
interface" under that license: keep the Multica logo, name and copyright visible in About, ship the complete Multica
License file with every distribution, and do not offer Comma as a hosted service or embed it in a commercial product
without a commercial license from Index Labs.
