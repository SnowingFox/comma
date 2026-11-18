import { useSyncExternalStore } from "react";

export const PAGES = ["home", "history", "dictionary", "usage", "settings"] as const;
export type Page = (typeof PAGES)[number];

export type Route = { page: Page; section?: string };

/** `#/settings/llm` -> { page: "settings", section: "llm" }. Unknown pages fall back to Home. */
export function parseHash(hash: string): Route {
  const [page, section] = hash.replace(/^#\/?/, "").split("/");
  const known = PAGES.find((p) => p === page);
  return known ? { page: known, section: section || undefined } : { page: "home" };
}

function subscribe(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  return parseHash(hash);
}

export function navigate(page: Page, section?: string) {
  window.location.hash = section ? `/${page}/${section}` : `/${page}`;
}
