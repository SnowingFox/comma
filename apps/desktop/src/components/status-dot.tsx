import { motion, useReducedMotion } from "motion/react";
import { match } from "ts-pattern";
import { cn } from "@multica/ui/lib/utils";

export type DotTone = "pending" | "ok" | "warn" | "off";

const COLORS: Record<DotTone, string> = {
  pending: "var(--warning)",
  ok: "var(--success)",
  warn: "var(--warning)",
  off: "var(--muted-foreground)",
};

/**
 * A live status dot. Pending breathes; turning ok ticks with a short spring (spec 2.4 motion).
 * Keyed on the tone so each change replays the tick.
 */
export function StatusDot({ tone, className }: { tone: DotTone; className?: string }) {
  const reduced = useReducedMotion();
  return (
    <span className={cn("relative inline-flex size-2.5 shrink-0 items-center justify-center", className)} aria-hidden>
      {tone === "pending" && !reduced ? (
        <motion.span
          className="absolute inset-0 rounded-full"
          style={{ backgroundColor: COLORS.pending }}
          animate={{ scale: [1, 2.2], opacity: [0.45, 0] }}
          transition={{ duration: 1.3, repeat: Infinity, ease: "easeOut" }}
        />
      ) : null}
      <motion.span
        key={tone}
        className="relative size-2 rounded-full"
        initial={match(tone)
          .with("ok", () => ({ scale: 0.4, backgroundColor: COLORS.warn }))
          .otherwise(() => ({ scale: 1, backgroundColor: COLORS[tone] }))}
        animate={{ scale: 1, backgroundColor: COLORS[tone] }}
        transition={{ type: "spring", stiffness: 520, damping: 18 }}
      />
    </span>
  );
}
