import { DEFAULT_SHORTCUTS, MODE_SHORTCUTS } from "@comma/shared/ipc";
import { useSettings } from "../lib/queries";
import { canSwitchModes, modeHow, triggerWords } from "../lib/shortcut-rules";
import { Keycaps } from "./keycaps";
import { MODE_NAMES } from "./shortcut-recorder";

function Item({ name, how, accel }: { name: string; how: string; accel: string }) {
  return (
    <li className="flex items-center justify-between gap-4 py-2.5 first:pt-0 last:pb-0">
      <div className="flex min-w-0 flex-col">
        <span className="text-body font-medium">{name}</span>
        <span className="text-caption text-muted-foreground">{how}</span>
      </div>
      <Keycaps accel={accel} size="sm" className="shrink-0" />
    </li>
  );
}

/** The configured shortcuts and how each behaves (spec 2.3.2), as keycaps: Home's cheat sheet. */
export function ShortcutList() {
  const shortcuts = useSettings().data?.shortcuts ?? DEFAULT_SHORTCUTS;
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col divide-y divide-border">
        {MODE_SHORTCUTS.map((mode) => (
          <Item key={mode} name={MODE_NAMES[mode]} how={modeHow(mode, shortcuts)} accel={shortcuts[mode]} />
        ))}
        {shortcuts.paste_last ? <Item name={MODE_NAMES.paste_last} how="Pastes your last result again." accel={shortcuts.paste_last} /> : null}
        <Item name="Cancel" how="Stops a recording; nothing is inserted." accel="Escape" />
      </ul>
      {canSwitchModes(shortcuts) ? (
        <p className="rounded-lg bg-muted/60 px-3 py-2 text-caption text-muted-foreground">
          Changed your mind while dictating? Press {triggerWords(shortcuts.ask)} for Ask Anything or{" "}
          {triggerWords(shortcuts.translate)} for Translate, with Fn held or once in hands-free. What you said so far is kept.
        </p>
      ) : null}
    </div>
  );
}
