import { isFnAccelerator, type ModeShortcut, type ShortcutSettings } from "@comma/shared/ipc";
import { acceleratorWords } from "./shortcut";

/**
 * How each shortcut behaves (spec 2.3.2), in the words Home, Settings > Shortcuts and onboarding
 * use. `finish` is what ends a session that runs on its own: the Dictate shortcut (Fn by default).
 */
export function finishWords(shortcuts: Pick<ShortcutSettings, "dictate">): string {
  return acceleratorWords(shortcuts.dictate);
}

export function modeHow(mode: ModeShortcut, shortcuts: Pick<ShortcutSettings, "dictate">): string {
  const finish = finishWords(shortcuts);
  switch (mode) {
    case "dictate":
      return "Hold to talk, let go to finish. Press twice for hands-free.";
    case "ask":
      return `Press to start, press again or press ${finish} to finish.`;
    case "translate":
      return `Press to start, press again or press ${finish} to finish. Or hold and let go.`;
  }
}

/** Whether the mode switch keys apply: all three modes on Fn. */
export function canSwitchModes(shortcuts: ShortcutSettings): boolean {
  return isFnAccelerator(shortcuts.dictate) && shortcuts.ask.startsWith("Fn+") && shortcuts.translate.startsWith("Fn+");
}

/** The key added to Fn for a mode (`Space`, `Left Shift`), for the switch line. */
export function triggerWords(accel: string): string {
  return acceleratorWords(accel).replace(/^Fn \+ /, "");
}
