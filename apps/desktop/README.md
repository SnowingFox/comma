# Comma desktop

Tauri 2 + React 19 + Vite 8 + Tailwind v4, UI from `@multica/ui` (`packages/multica-ui`).

```sh
bun install                    # at the repo root
bun run tauri dev              # the app, with hot reload
bun run dev                    # the UI alone in a browser at http://localhost:1420 (in-memory backend)
bun run typecheck && bun run build
cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace   # at the repo root
cargo test -p comma -- --ignored real_magpie --nocapture                         # real calls to a local magpie
bun run tauri build --debug --bundles app
```

Windows, one Vite entry each: `hub.html` (main window), `onboarding.html` (first run), `bar.html` (floating bar).
In the browser, `hub.html#/settings/developer` previews the bar states and `bar.html?state=recording` opens the bar
in one state. The in-memory backend takes URL knobs, remembered in localStorage: `?magpie=up|down|slow`,
`?server=up|down`, `?stt=ok|missing_permission|invalid_key`, `?keys=1|0`, `?mode=local|account`, `?step=<id>` and
`?reset`, e.g. `onboarding.html?reset&keys=1&step=try_dictate`.

| Path | What |
| --- | --- |
| `src/windows/{hub,onboarding,bar}` | One folder per window, `main.tsx` is the entry |
| `src/components` | Pieces shared by windows (key fields, permission rows, brand) |
| `src/lib/ipc.ts` | Typed `invoke`/`listen` validated against `@comma/shared/ipc` |
| `src/windows/onboarding/steps` | The eleven onboarding steps (spec 2.4); `flow.tsx` holds the order and footer controls |
| `src/lib/audio` | Microphone capture (AudioWorklet), 16 kHz WAV encoding |
| `src-tauri/src` | Commands, settings file, Keychain, permissions, windows, tray, Comma server client |
| `../../crates/comma-voice` | Speech to text, LLM, prompts and pipeline, without Tauri |
| `src-tauri/icons/source` | Icon and menu bar icon SVG sources; regenerate with `bun tauri icon src-tauri/icons/source/icon-1024.png` |
