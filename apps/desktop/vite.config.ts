import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const host = process.env.TAURI_DEV_HOST;
const root = import.meta.dirname;
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { version: string };

// One HTML entry per Tauri window (spec 3.1).
const windows = ["hub", "onboarding", "bar"] as const;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    dedupe: ["react", "react-dom"],
  },
  build: {
    // WKWebView on macOS 13+.
    target: "safari16",
    // Assets load from disk inside the app, so one larger shared chunk costs nothing.
    chunkSizeWarningLimit: 1024,
    rolldownOptions: {
      input: Object.fromEntries(windows.map((name) => [name, resolve(root, `${name}.html`)])),
    },
  },
  // Tauri: keep Rust errors visible, use a fixed port, and leave src-tauri to cargo.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
