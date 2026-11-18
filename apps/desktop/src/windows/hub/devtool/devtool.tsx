// Developer-only vocabulary, English only.
import { useEffect, useState } from "react";
import { X } from "@multica/ui/icons";
import { startDevtoolRecording } from "../../../lib/devtool-store";
import { useShortcutsStatus } from "../../../lib/shortcut-events";
import { DEVTOOL_STYLE } from "./devtool-style";
import { BarTab, listenerTone, LogTab, OnboardingTab, PermissionsTab, RunsTab, ShortcutsTab } from "./tabs";

export const DEVTOOL_TABS = ["shortcuts", "permissions", "runs", "log", "onboarding", "bar"] as const;
export type DevtoolTab = (typeof DEVTOOL_TABS)[number];

const LABELS: Record<DevtoolTab, string> = {
  shortcuts: "Shortcuts",
  permissions: "Permissions",
  runs: "Runs",
  log: "Log",
  onboarding: "Onboarding",
  bar: "Bar",
};

const PREFS_KEY = "comma-devtool-prefs";

type Prefs = { open: boolean; tab: DevtoolTab };

export function readPrefs(raw: string | null): Prefs {
  try {
    const p = JSON.parse(raw ?? "{}") as Partial<Prefs>;
    return { open: p.open === true, tab: DEVTOOL_TABS.find((t) => t === p.tab) ?? "shortcuts" };
  } catch {
    return { open: false, tab: "shortcuts" };
  }
}

/**
 * The DEV pill on the hub's right edge and its panel (after the Multica devtool). Mounted only
 * while developer tools are on; it records shortcut actions and run events from the moment it
 * mounts, so the lists fill even while the panel is closed.
 */
export function DevTool() {
  const [prefs, setPrefs] = useState<Prefs>(() => readPrefs(localStorage.getItem(PREFS_KEY)));
  const status = useShortcutsStatus().data;
  const tone = listenerTone(status);

  useEffect(() => startDevtoolRecording(), []);
  useEffect(() => localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)), [prefs]);
  useEffect(() => {
    if (!prefs.open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPrefs((p) => ({ ...p, open: false }));
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prefs.open]);

  const Tab = { shortcuts: ShortcutsTab, permissions: PermissionsTab, runs: RunsTab, log: LogTab, onboarding: OnboardingTab, bar: BarTab }[prefs.tab];

  return (
    <div className="cdt" data-testid="devtool">
      <style>{DEVTOOL_STYLE}</style>
      <button
        type="button"
        className="cdt-pill"
        data-warn={tone === "warn" || tone === "bad" || undefined}
        aria-expanded={prefs.open}
        aria-label="Developer tools"
        title={tone === "warn" || tone === "bad" ? "Developer tools: the Fn listener needs attention" : "Developer tools"}
        onClick={() => setPrefs((p) => ({ ...p, open: !p.open }))}
      >
        DEV
      </button>
      {prefs.open ? (
        <div className="cdt-panel" role="dialog" aria-label="Developer tools">
          <div className="cdt-header">
            <span>Comma · Developer tools</span>
            <button type="button" className="cdt-icon-button" aria-label="Close developer tools" onClick={() => setPrefs((p) => ({ ...p, open: false }))}>
              <X aria-hidden="true" width={14} height={14} />
            </button>
          </div>
          <div className="cdt-tabs" role="tablist">
            {DEVTOOL_TABS.map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                className="cdt-tab"
                aria-selected={t === prefs.tab}
                data-warn={(t === "shortcuts" && (tone === "warn" || tone === "bad")) || undefined}
                onClick={() => setPrefs((p) => ({ ...p, tab: t }))}
              >
                {LABELS[t]}
              </button>
            ))}
          </div>
          <div className="cdt-body" role="tabpanel">
            <Tab />
          </div>
        </div>
      ) : null}
    </div>
  );
}
