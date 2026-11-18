import { AnimatePresence, motion } from "motion/react";
import { Check } from "@multica/ui/icons";
import { cn } from "@multica/ui/lib/utils";
import { LANGUAGES } from "../lib/languages";

/**
 * Toggle chips in pick order. The order matters: the first spoken language is the fallback, the
 * first translate target is the one used, so selected chips show their position.
 */
export function LanguageChips({
  value,
  onChange,
  max,
  label,
}: {
  value: readonly string[];
  onChange: (next: string[]) => void;
  max: number;
  label: string;
}) {
  const full = value.length >= max;
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      {LANGUAGES.map((lang) => {
        const index = value.indexOf(lang.tag);
        const on = index >= 0;
        return (
          <button
            key={lang.tag}
            type="button"
            aria-pressed={on}
            disabled={!on && full}
            onClick={() => onChange(on ? value.filter((t) => t !== lang.tag) : [...value, lang.tag])}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-label transition-[background-color,border-color,color,opacity] outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              on
                ? "border-foreground/25 bg-surface-selected font-medium text-foreground"
                : "border-border bg-surface text-muted-foreground hover:bg-surface-hover hover:text-foreground",
              !on && full && "opacity-40",
            )}
          >
            <AnimatePresence initial={false}>
              {on ? (
                <motion.span
                  initial={{ width: 0, opacity: 0 }}
                  animate={{ width: "auto", opacity: 1 }}
                  exit={{ width: 0, opacity: 0 }}
                  transition={{ duration: 0.15 }}
                  className="flex items-center overflow-hidden"
                >
                  {index === 0 ? (
                    <Check className="size-3.5" />
                  ) : (
                    <span className="flex size-4 items-center justify-center rounded-full bg-foreground/10 text-micro">{index + 1}</span>
                  )}
                </motion.span>
              ) : null}
            </AnimatePresence>
            <span>{lang.native}</span>
            {lang.native !== lang.name ? <span className="text-caption text-muted-foreground">{lang.name}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
