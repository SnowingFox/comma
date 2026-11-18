# Comma desktop

Tauri 2 + React 19 + Vite 8 + Tailwind v4, UI from `@multica/ui` (`packages/multica-ui`).

```sh
bun install                    # at the repo root
bun run tauri dev              # the app, with hot reload
bun run dev                    # the UI alone in a browser at http://localhost:1420 (in-memory backend)
bun run typecheck && bun run build
cd src-tauri && cargo clippy --all-targets -- -D warnings && cargo test
bun run tauri build --debug --bundles app
```

Windows, one Vite entry each: `hub.html` (main window), `onboarding.html` (first run), `bar.html` (floating bar).
In the browser, `hub.html#/settings/developer` previews the bar states and `bar.html?state=recording` opens the bar
in one state.

| Path | What |
| --- | --- |
| `src/windows/{hub,onboarding,bar}` | One folder per window, `main.tsx` is the entry |
| `src/components` | Pieces shared by windows (key fields, permission rows, brand) |
| `src/lib/ipc.ts` | Typed `invoke`/`listen` validated against `@comma/shared/ipc` |
| `src-tauri/src` | Commands, settings file, Keychain, permissions, windows, tray |
