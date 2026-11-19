import type { HintKind } from "@comma/shared/ipc";
import { acceleratorWords } from "../../lib/shortcut";

/** What each bar hint says (spec 2.3.1, 2.3.2). `dictate` is the Dictate shortcut, which also finishes. */
export function hintText(kind: HintKind, dictate: string, device?: string): string {
  const finish = dictate.startsWith("Fn") ? "Fn" : acceleratorWords(dictate);
  switch (kind) {
    case "ask_hold":
      return `No need to hold. Press ${finish} to finish.`;
    case "finish_with_fn":
      return `Press ${finish} to finish.`;
    case "hands_free":
      return `Press ${finish} twice to keep talking hands-free.`;
    case "copied":
      return "Copied. Paste it with Cmd+V.";
    case "paste_access":
      return "Copied. Allow Accessibility so Comma can paste for you.";
    case "microphone":
      return `Switch to ${device ?? "the other microphone"}?`;
    case "input_monitoring":
      return "Fn+Space and Esc need Input Monitoring.";
    case "relaunch":
      return "Relaunch Comma to finish turning on Input Monitoring.";
    case "accessibility":
      return "Comma needs Accessibility to paste. Until then it copies.";
    case "microphone_denied":
      return "Comma can't use the microphone.";
    case "signed_out":
      return "You're signed out of Comma.";
  }
}
