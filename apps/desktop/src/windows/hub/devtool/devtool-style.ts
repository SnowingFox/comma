// The DEV pill and panel (after the Multica devtool), dark in every theme. Scoped to .cdt so none
// of it leaks into the hub. Sits above dialogs, below toasts.
export const DEVTOOL_STYLE = `
.cdt {
  display: contents;
  --cdt-bg: rgb(28 29 34 / 0.98);
  --cdt-bg-2: rgb(255 255 255 / 0.06);
  --cdt-bg-3: rgb(255 255 255 / 0.11);
  --cdt-fg: rgb(240 241 245);
  --cdt-fg-2: rgb(240 241 245 / 0.6);
  --cdt-line: rgb(255 255 255 / 0.08);
  --cdt-accent: rgb(120 190 255);
  --cdt-bad: rgb(255 140 140);
  --cdt-ok: rgb(80 210 130);
  --cdt-warn: rgb(246 180 29);
  --cdt-mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-family: var(--font-sans, system-ui), sans-serif;
  font-size: 11px;
  line-height: 1.4;
  color: var(--cdt-fg);
  color-scheme: dark;
}
.cdt *, .cdt *::before, .cdt *::after { box-sizing: border-box; }
.cdt-pill {
  position: fixed;
  right: 0;
  top: 62%;
  z-index: 90;
  padding: 7px 5px 7px 7px;
  border: 1px solid var(--cdt-line);
  border-right: none;
  border-radius: 8px 0 0 8px;
  background: var(--cdt-bg);
  color: var(--cdt-fg-2);
  font: 600 10px / 1 var(--cdt-mono);
  letter-spacing: 0.06em;
  writing-mode: vertical-rl;
  cursor: pointer;
  opacity: 0.6;
  box-shadow: 0 2px 10px rgb(0 0 0 / 0.25);
  transform: translateY(-50%);
  transition: opacity 120ms, color 120ms;
  user-select: none;
}
.cdt-pill:hover, .cdt-pill[aria-expanded="true"], .cdt-pill:focus-visible { opacity: 1; color: var(--cdt-accent); outline: none; }
.cdt-pill[data-warn] { color: var(--cdt-warn); opacity: 0.95; }
.cdt-panel {
  position: fixed;
  top: 44px;
  right: 34px;
  z-index: 90;
  display: flex;
  flex-direction: column;
  width: min(440px, calc(100vw - 48px));
  height: min(620px, calc(100vh - 88px));
  border: 1px solid var(--cdt-line);
  border-radius: 10px;
  background: var(--cdt-bg);
  box-shadow: 0 12px 40px rgb(0 0 0 / 0.45);
}
.cdt-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 6px 0 10px;
  color: var(--cdt-fg-2);
  font-weight: 600;
}
.cdt-header > span { flex: 1; }
.cdt-tabs { display: flex; gap: 2px; padding: 6px 6px 0; border-bottom: 1px solid var(--cdt-line); overflow-x: auto; }
.cdt-tab {
  padding: 5px 8px 6px;
  border: none;
  border-bottom: 2px solid transparent;
  background: none;
  color: var(--cdt-fg-2);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}
.cdt-tab:hover { color: var(--cdt-fg); }
.cdt-tab[aria-selected="true"] { color: var(--cdt-fg); border-bottom-color: var(--cdt-accent); }
.cdt-tab[data-warn]::after { content: ""; display: inline-block; width: 5px; height: 5px; margin-left: 4px; border-radius: 50%; background: var(--cdt-warn); vertical-align: middle; }
.cdt-body { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 8px 10px 10px; display: flex; flex-direction: column; gap: 10px; }
.cdt-icon-button {
  display: grid; place-items: center; width: 22px; height: 22px; padding: 0;
  border: none; border-radius: 4px; background: none; color: var(--cdt-fg-2); cursor: pointer;
}
.cdt-icon-button:hover { background: var(--cdt-bg-3); color: var(--cdt-fg); }
.cdt-section { display: flex; flex-direction: column; gap: 3px; }
.cdt-section-title { color: var(--cdt-fg-2); font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; font-size: 10px; margin-bottom: 2px; }
.cdt-row { display: grid; grid-template-columns: 112px minmax(0, 1fr); align-items: center; gap: 8px; min-height: 20px; }
.cdt-label { color: var(--cdt-fg-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cdt-value { min-width: 0; font-family: var(--cdt-mono); overflow-wrap: anywhere; }
.cdt-muted { color: var(--cdt-fg-2); }
.cdt-buttons { display: flex; flex-wrap: wrap; gap: 4px; }
.cdt-button {
  padding: 5px 8px; border: none; border-radius: 4px; background: var(--cdt-bg-3); color: var(--cdt-fg);
  font: inherit; cursor: pointer;
}
.cdt-button:hover:not(:disabled) { background: rgb(255 255 255 / 0.17); }
.cdt-button:disabled { opacity: 0.45; cursor: default; }
.cdt-button[data-active] { background: var(--cdt-accent); color: rgb(10 20 30); }
.cdt-button[data-danger] { color: var(--cdt-bad); }
.cdt-status { display: inline-flex; align-items: center; gap: 5px; }
.cdt-status::before { content: ""; flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--cdt-fg-2); }
.cdt-status[data-tone="on"]::before { background: var(--cdt-ok); }
.cdt-status[data-tone="warn"]::before { background: var(--cdt-warn); }
.cdt-status[data-tone="bad"]::before { background: var(--cdt-bad); }
.cdt-note { margin: 0; color: var(--cdt-fg-2); }
.cdt-note[data-tone="warn"] { color: var(--cdt-warn); }
.cdt-note[data-tone="bad"] { color: var(--cdt-bad); }
.cdt-lights { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 4px; }
.cdt-light {
  display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 6px 4px;
  border: 1px solid var(--cdt-line); border-radius: 6px; background: var(--cdt-bg-2); font-family: var(--cdt-mono);
  transition: background 120ms, border-color 120ms;
}
.cdt-light > i { width: 10px; height: 10px; border-radius: 50%; background: rgb(255 255 255 / 0.14); transition: background 120ms, box-shadow 120ms; }
.cdt-light[data-on] { border-color: rgb(80 210 130 / 0.5); background: rgb(80 210 130 / 0.1); }
.cdt-light[data-on] > i { background: var(--cdt-ok); box-shadow: 0 0 10px var(--cdt-ok); }
.cdt-light[data-flash] > i { animation: cdt-flash 700ms ease-out; }
@keyframes cdt-flash { 0% { background: var(--cdt-accent); box-shadow: 0 0 12px var(--cdt-accent); } 100% { background: rgb(255 255 255 / 0.14); box-shadow: none; } }
.cdt-list { margin: 0; padding: 0; list-style: none; font-family: var(--cdt-mono); }
.cdt-list li { display: grid; grid-template-columns: 82px 56px minmax(0, 1fr); column-gap: 8px; padding: 2px 0; border-bottom: 1px solid var(--cdt-line); }
.cdt-list li[data-wide] { grid-template-columns: 64px minmax(0, 1fr); }
.cdt-table { width: 100%; border-collapse: collapse; font-family: var(--cdt-mono); }
.cdt-table th { color: var(--cdt-fg-2); font-weight: 500; text-align: right; padding: 2px 4px; }
.cdt-table th:first-child, .cdt-table td:first-child { text-align: left; }
.cdt-table td { text-align: right; padding: 2px 4px; border-top: 1px solid var(--cdt-line); white-space: nowrap; }
.cdt-table td[data-bad] { color: var(--cdt-bad); }
.cdt-error { grid-column: 1 / -1; color: var(--cdt-bad); white-space: normal; text-align: left !important; }
.cdt-log {
  flex: 1; min-height: 0; margin: 0; padding: 6px; overflow: auto; border-radius: 6px; background: rgb(0 0 0 / 0.35);
  font: 10px / 1.45 var(--cdt-mono); white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; -webkit-user-select: text;
}
.cdt-log [data-level="WARN"] { color: var(--cdt-warn); }
.cdt-log [data-level="ERROR"] { color: var(--cdt-bad); }
.cdt-select, .cdt-input {
  height: 24px; padding: 0 6px; border: 1px solid var(--cdt-line); border-radius: 4px; background: var(--cdt-bg-2);
  color: var(--cdt-fg); font: inherit; outline: none;
}
.cdt-input { width: 100%; font-family: var(--cdt-mono); }
.cdt-select:focus, .cdt-input:focus { border-color: var(--cdt-accent); }
.cdt-check { display: inline-flex; align-items: center; gap: 5px; color: var(--cdt-fg-2); cursor: pointer; }
`;
