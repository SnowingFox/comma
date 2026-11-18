import "@fontsource-variable/inter";
import "../styles/app.css";
import "../lib/i18n";

import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "motion/react";
import { ThemeProvider } from "@multica/ui/components/common/theme-provider";
import { Toaster } from "@multica/ui/components/ui/sonner";
import { queryClient } from "../lib/queries";
import { applyInitialTheme, THEME_STORAGE_KEY, useThemeSync } from "../lib/theme";

function ThemeSync() {
  useThemeSync();
  return null;
}

/** Mounts a window: styles, theme, query client and motion defaults. */
export function mountWindow(app: ReactNode, { toaster = true }: { toaster?: boolean } = {}) {
  applyInitialTheme();
  const root = document.getElementById("root");
  if (!root) throw new Error("#root is missing");
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider storageKey={THEME_STORAGE_KEY}>
          {/* "user": follow prefers-reduced-motion everywhere motion is used. */}
          <MotionConfig reducedMotion="user">
            <ThemeSync />
            {app}
            {toaster ? <Toaster position="bottom-right" /> : null}
          </MotionConfig>
        </ThemeProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}
