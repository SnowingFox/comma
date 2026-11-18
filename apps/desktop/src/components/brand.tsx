import type { ComponentProps } from "react";
import { cn } from "@multica/ui/lib/utils";

/** The comma glyph on a 24-unit grid: a round dot with a tapered tail. */
export const COMMA_GLYPH =
  "M12 6.1a3.9 3.9 0 0 1 3.9 3.9c0 4.6-2.5 8-6.3 9.7a.6.6 0 0 1-.6-1c1.7-1.2 2.8-2.7 3.1-4.4A3.9 3.9 0 0 1 12 6.1Z";

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
      <path d={COMMA_GLYPH} transform="translate(0.2 -1.3)" className="fill-background" />
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
