import { useEffect } from "react";
import { useTheme } from "next-themes";
import { useSettings } from "./queries";

/** next-themes' localStorage key. Shared by every window of the app (same origin). */
export const THEME_STORAGE_KEY = "comma-theme";

/**
 * Sets the `dark` class before React renders, so a window never flashes the wrong
 * theme. next-themes takes over once mounted.
 */
export function applyInitialTheme() {
  let pref: string | null = null;
  try {
    pref = localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    // storage unavailable: follow the system
  }
  const dark =
    pref === "dark" || (pref !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

/**
 * Applies the persisted `theme` setting whenever it changes. Other windows pick the
 * change up through next-themes' storage event, so this reacts to the setting only,
 * never to the current theme (that would undo a change made in another window).
 */
export function useThemeSync() {
  const wanted = useSettings().data?.theme;
  const { setTheme } = useTheme();
  useEffect(() => {
    if (wanted) setTheme(wanted);
  }, [wanted, setTheme]);
}
