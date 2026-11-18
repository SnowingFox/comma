import type { ComponentProps } from "react";
import { cn } from "@multica/ui/lib/utils";

/** The comma glyph on a 24-unit grid, the same drawing as the app icon (`src-tauri/icons/source/icon.svg`). */
export const COMMA_GLYPH =
  "M12.12 5.13A4.43 4.43 0 0 1 16.54 9.55C16.54 14.16 14.45 17.65 10.14 19.81C9.55 20.1 8.97 19.57 9.38 19.05C11.13 17.18 12.12 15.61 12.47 13.95A4.43 4.43 0 0 1 7.69 9.55A4.43 4.43 0 0 1 12.12 5.13Z";

/** Comma's mark: the glyph on a rounded tile. Ink tile in light mode, inverted in dark. */
export function CommaMark({ size = 24, className, ...props }: ComponentProps<"svg"> & { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden
      className={cn("shrink-0", className)}
      {...props}
    >
      <rect width="24" height="24" rx="6.5" className="fill-foreground" />
      <path d={COMMA_GLYPH} className="fill-background" />
    </svg>
  );
}

/** Mark plus name, for the sidebar header and About. */
export function CommaWordmark({ className, markSize = 20 }: { className?: string; markSize?: number }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <CommaMark size={markSize} />
      <span className="text-title-sm font-semibold tracking-[-0.02em]">Comma</span>
    </span>
  );
}
