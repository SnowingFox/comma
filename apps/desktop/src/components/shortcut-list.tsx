import { Kbd, KbdGroup } from "@multica/ui/components/ui/kbd";

export const DEFAULT_SHORTCUTS = [
  { mode: "Dictate", keys: ["⌥", "Space"], how: "Hold, speak, release" },
  { mode: "Ask Anything", keys: ["⌥", "⇧", "Space"], how: "Tap to start, tap to stop" },
  { mode: "Translate", keys: ["⌃", "⌥", "Space"], how: "Hold, speak, release" },
];

export function ShortcutList() {
  return (
    <ul className="flex flex-col divide-y divide-border">
      {DEFAULT_SHORTCUTS.map((s) => (
        <li key={s.mode} className="flex items-center justify-between gap-4 py-2.5 first:pt-0 last:pb-0">
          <div className="flex flex-col">
            <span className="text-body font-medium">{s.mode}</span>
            <span className="text-caption text-muted-foreground">{s.how}</span>
          </div>
          <KbdGroup>
            {s.keys.map((k) => (
              <Kbd key={k} className="h-6 min-w-6 px-1.5 text-label">
                {k}
              </Kbd>
            ))}
          </KbdGroup>
        </li>
      ))}
    </ul>
  );
}
