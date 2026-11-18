import { openUrl } from "@tauri-apps/plugin-opener";
import { inTauri } from "./ipc";

export const ELEVENLABS_KEYS_URL = "https://elevenlabs.io/app/settings/api-keys";

export function openExternal(url: string) {
  if (inTauri) void openUrl(url);
  else window.open(url, "_blank", "noopener");
}
