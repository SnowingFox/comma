import { DEFAULT_SHORTCUTS, type ShortcutSettings } from "@comma/shared/ipc";
import { useSettings } from "../lib/queries";
import { Keycaps } from "./keycaps";

const MODES: { mode: keyof ShortcutSettings; name: string; how: string }[] = [
  { mode: "dictate", name: "Dictate", how: "Hold, speak, release" },
  { mode: "ask", name: "Ask Anything", how: "Tap to start, tap to stop" },
  { mode: "translate", name: "Translate", how: "Hold, speak, release" },
];

/** The three configured shortcuts as keycaps. */
export function ShortcutList() {
  const shortcuts = useSettings().data?.shortcuts ?? DEFAULT_SHORTCUTS;
  return (
    <ul className="flex flex-col divide-y divide-border">
      {MODES.map((m) => (
        <li key={m.mode} className="flex items-center justify-between gap-4 py-2.5 first:pt-0 last:pb-0">
          <div className="flex flex-col">
            <span className="text-body font-medium">{m.name}</span>
            <span className="text-caption text-muted-foreground">{m.how}</span>
          </div>
          <Keycaps accel={shortcuts[m.mode]} size="sm" />
        </li>
      ))}
    </ul>
  );
}
