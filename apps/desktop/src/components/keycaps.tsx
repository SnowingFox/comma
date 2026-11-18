import { motion } from "motion/react";
import { cn } from "@multica/ui/lib/utils";
import { parseAccelerator } from "../lib/shortcut";

/**
 * The keys of a shortcut as keycaps. A held key presses down: scale 0.96 and the accent fill in
 * 120 ms (spec 2.4 motion). MotionConfig drops the scale under reduced motion; the fill stays.
 */
export function Keycaps({
  accel,
  held,
  size = "md",
  className,
}: {
  accel: string;
  held?: ReadonlySet<string>;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const caps = parseAccelerator(accel);
  return (
    <span className={cn("inline-flex items-center", size === "lg" ? "gap-2.5" : "gap-1", className)} aria-label={caps.map((c) => c.name).join(" ")}>
      {caps.map((cap) => {
        const down = held?.has(cap.id) ?? false;
        return (
          <motion.kbd
            key={cap.id}
            animate={{ scale: down ? 0.96 : 1, y: down ? 1 : 0 }}
            transition={{ duration: 0.12, ease: "easeOut" }}
            title={cap.name}
            className={cn(
              "inline-flex items-center justify-center rounded-md border font-sans font-medium transition-[background-color,border-color,color,box-shadow] duration-[120ms] select-none",
              size === "sm" && "h-6 min-w-6 px-1.5 text-label",
              size === "md" && "h-8 min-w-8 px-2 text-body",
              size === "lg" && "h-16 min-w-16 rounded-xl px-4 text-title-lg",
              cap.modifier && size === "lg" && "text-display-sm",
              down
                ? "border-brand bg-brand text-brand-foreground shadow-none"
                : "border-border bg-surface text-foreground shadow-[0_1px_0_1px_var(--border)]",
            )}
          >
            {cap.label}
          </motion.kbd>
        );
      })}
    </span>
  );
}
