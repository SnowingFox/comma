import { useEffect, useRef, useState } from "react";
import { match, P } from "ts-pattern";

/**
 * Shortcuts are stored as `Fn`, `Fn+Space`, `Fn+ShiftLeft` (Comma's Fn listener) or `Alt+Shift+Space` (the
 * global-shortcut plugin's format). Key ids in `Keycap.id` match the names in `shortcut://keys`.
 */

export type Modifier = "Control" | "Alt" | "Shift" | "Super";
const MODIFIER_ORDER: Modifier[] = ["Control", "Alt", "Shift", "Super"];

export type Keycap = { id: string; label: string; name: string; modifier: boolean };

function modifierOf(token: string): Modifier | undefined {
  return match(token.toLowerCase())
    .returnType<Modifier | undefined>()
    .with("control", "ctrl", () => "Control")
    .with("alt", "option", () => "Alt")
    .with("shift", () => "Shift")
    .with("super", "cmd", "command", "meta", "cmdorctrl", () => "Super")
    .otherwise(() => undefined);
}

const MOD_CAPS: Record<Modifier, Omit<Keycap, "id" | "modifier">> = {
  Control: { label: "⌃", name: "Control" },
  Alt: { label: "⌥", name: "Option" },
  Shift: { label: "⇧", name: "Shift" },
  Super: { label: "⌘", name: "Command" },
};

const KEY_LABELS: Record<string, string> = {
  Space: "Space",
  Enter: "↩",
  Tab: "⇥",
  Backspace: "⌫",
  Up: "↑",
  Down: "↓",
  Left: "←",
  Right: "→",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
  Escape: "esc",
};

/** Keys that can follow `Fn+`, as keycaps. Side-specific modifiers say which side. */
const FN_KEY_CAPS: Record<string, Omit<Keycap, "id" | "modifier">> = {
  Space: { label: "Space", name: "Space" },
  ShiftLeft: { label: "⇧ Left", name: "Left Shift" },
  ShiftRight: { label: "⇧ Right", name: "Right Shift" },
  ControlLeft: { label: "⌃ Left", name: "Left Control" },
  ControlRight: { label: "⌃ Right", name: "Right Control" },
  AltLeft: { label: "⌥ Left", name: "Left Option" },
  AltRight: { label: "⌥ Right", name: "Right Option" },
  MetaLeft: { label: "⌘ Left", name: "Left Command" },
  MetaRight: { label: "⌘ Right", name: "Right Command" },
};

/** `Fn+ShiftLeft` -> fn, ⇧ Left. */
function parseFn(accel: string): Keycap[] {
  const caps: Keycap[] = [{ id: "Fn", label: "fn", name: "Fn (Globe)", modifier: true }];
  const key = accel.split("+")[1];
  if (key) caps.push({ id: key, modifier: false, ...(FN_KEY_CAPS[key] ?? { label: key, name: key }) });
  return caps;
}

/** Plain words for a shortcut, for copy: "Fn", "Fn + Space", "Option Space". */
export function acceleratorWords(accel: string): string {
  return parseAccelerator(accel)
    .map((c) => (c.id === "Fn" ? "Fn" : c.name))
    .join(accel.startsWith("Fn") ? " + " : " ");
}

/** `Alt+Shift+Space` -> ⌥ ⇧ Space, modifiers in macOS order. */
export function parseAccelerator(accel: string): Keycap[] {
  if (accel === "Fn" || accel.startsWith("Fn+")) return parseFn(accel);
  const tokens = accel.split("+").filter(Boolean);
  const mods = new Set<Modifier>();
  let key: string | undefined;
  for (const t of tokens) {
    const m = modifierOf(t);
    if (m) mods.add(m);
    else key = t;
  }
  const caps: Keycap[] = MODIFIER_ORDER.filter((m) => mods.has(m)).map((m) => ({ id: m, modifier: true, ...MOD_CAPS[m] }));
  if (key) caps.push({ id: key, modifier: false, label: KEY_LABELS[key] ?? key.toUpperCase(), name: key });
  return caps;
}

/** `KeyboardEvent.code` to the accelerator key name, or undefined for modifiers and unknown keys. */
export function keyFromCode(code: string): string | undefined {
  return match(code)
    .returnType<string | undefined>()
    .with(P.string.regex(/^Key[A-Z]$/), (c) => c.slice(3))
    .with(P.string.regex(/^Digit\d$/), (c) => c.slice(5))
    .with(P.string.regex(/^F\d{1,2}$/), (c) => c)
    .with(P.string.startsWith("Arrow"), (c) => c.slice(5))
    .with(P.when((c) => c in KEY_LABELS), (c) => c)
    .otherwise(() => undefined);
}

function eventModifiers(e: KeyboardEvent): Set<Modifier> {
  const mods = new Set<Modifier>();
  if (e.ctrlKey) mods.add("Control");
  if (e.altKey) mods.add("Alt");
  if (e.shiftKey) mods.add("Shift");
  if (e.metaKey) mods.add("Super");
  return mods;
}

/**
 * The accelerator for a key press in the shortcut recorder: at least one modifier plus one key.
 * `null` while only modifiers are down.
 */
export function acceleratorFromEvent(e: KeyboardEvent): string | null {
  const key = keyFromCode(e.code);
  const mods = eventModifiers(e);
  if (!key || mods.size === 0) return null;
  return [...MODIFIER_ORDER.filter((m) => mods.has(m)), key].join("+");
}

/**
 * Tracks which keycaps of `accel` are held while this window is focused. `onDown` fires when the
 * whole combination is held, `onUp` when any part of it is released. The main key's default action
 * is suppressed so the combination never types into a field.
 */
export function useShortcutHold(
  accel: string,
  { enabled = true, onDown, onUp }: { enabled?: boolean; onDown?: () => void; onUp?: () => void } = {},
) {
  const [held, setHeld] = useState<ReadonlySet<string>>(new Set());
  const active = useRef(false);
  const handlers = useRef({ onDown, onUp });
  handlers.current = { onDown, onUp };

  useEffect(() => {
    if (!enabled) return;
    const caps = parseAccelerator(accel);
    const main = caps.find((c) => !c.modifier)?.id;
    let mainDown = false;

    const update = (e: KeyboardEvent | null) => {
      const mods = e ? eventModifiers(e) : new Set<Modifier>();
      const next = new Set<string>(caps.filter((c) => c.modifier && mods.has(c.id as Modifier)).map((c) => c.id));
      if (mainDown && main) next.add(main);
      setHeld(next);
      // Extra modifiers (Command with Option+Space) do not count as the shortcut.
      const exact = caps.every((c) => next.has(c.id)) && [...mods].every((m) => caps.some((c) => c.id === m));
      if (exact && !active.current) {
        active.current = true;
        handlers.current.onDown?.();
      } else if (!exact && active.current) {
        active.current = false;
        handlers.current.onUp?.();
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (main && keyFromCode(e.code) === main) {
        e.preventDefault();
        if (e.repeat) return;
        mainDown = true;
      }
      update(e);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (main && keyFromCode(e.code) === main) {
        e.preventDefault();
        mainDown = false;
      }
      update(e);
    };
    const reset = () => {
      mainDown = false;
      update(null);
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", reset);
      if (active.current) {
        active.current = false;
        handlers.current.onUp?.();
      }
      setHeld(new Set());
    };
  }, [accel, enabled]);

  return held;
}
