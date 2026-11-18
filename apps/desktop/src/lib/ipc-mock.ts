// Dev-only stand-in for the Rust commands when the UI runs in a plain browser.
// Never bundled into a release: `ipc.ts` imports it only under `import.meta.env.DEV`.
import {
  DEFAULT_SETTINGS,
  Settings,
  type CommandName,
  type PermissionsStatus,
  type SecretName,
} from "@comma/shared/ipc";

const KEY = "comma-dev-mock";

type MockState = {
  settings: Settings;
  secrets: Record<SecretName, boolean>;
  permissions: PermissionsStatus;
};

function load(): MockState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as MockState;
  } catch {
    // fall through to defaults
  }
  return {
    settings: structuredClone(DEFAULT_SETTINGS),
    secrets: { elevenlabs: false, llm: false },
    permissions: { microphone: "not_determined", accessibility: "denied" },
  };
}

function save(state: MockState) {
  localStorage.setItem(KEY, JSON.stringify(state));
}

export async function mockInvoke(command: CommandName, args: Record<string, unknown>): Promise<unknown> {
  await new Promise((r) => setTimeout(r, 60));
  const state = load();
  switch (command) {
    case "settings_get":
      return state.settings;
    case "settings_set": {
      const patch = args.patch as Partial<Settings>;
      const next = Settings.parse({
        ...state.settings,
        ...patch,
        stt: { ...state.settings.stt, ...patch.stt },
        llm: { ...state.settings.llm, ...patch.llm },
      });
      save({ ...state, settings: next });
      return next;
    }
    case "secret_set": {
      const name = args.name as SecretName;
      const value = String(args.value).trim();
      save({ ...state, secrets: { ...state.secrets, [name]: value.length > 0 } });
      return null;
    }
    case "secret_status":
      return state.secrets;
    case "permissions_status":
      return state.permissions;
    case "open_settings_pane": {
      // Pretend the user granted it in System Settings.
      const kind = args.kind as keyof PermissionsStatus;
      setTimeout(() => save({ ...load(), permissions: { ...load().permissions, [kind]: "granted" } }), 1500);
      return null;
    }
    case "window_show":
    case "window_hide":
      console.info(`[mock] ${command}`, args);
      return null;
  }
}
