import type { ComponentType, ReactNode, SVGProps } from "react";
import type { RunMode, RunRecord } from "@comma/shared/ipc";
import { Card } from "@multica/ui/components/ui/card";
import { Globe, MessageCircleQuestion, Mic } from "@multica/ui/icons";
import { cn } from "@multica/ui/lib/utils";

export const MODE_LABELS: Record<RunMode, string> = { dictate: "Dictate", ask: "Ask Anything", translate: "Translate" };

export const MODE_ICONS: Record<RunMode, ComponentType<SVGProps<SVGSVGElement>>> = {
  dictate: Mic,
  ask: MessageCircleQuestion,
  translate: Globe,
};

/** Typing speed the time saved is measured against (spec 2.5). */
export const TYPING_WPM = 40;

export function minutesSaved(words: number): number {
  return words / TYPING_WPM;
}

export function formatMinutes(min: number): string {
  if (min < 1) return min === 0 ? "0 min" : "<1 min";
  if (min < 60) return `${Math.round(min)} min`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}

export const formatInt = (n: number) => n.toLocaleString("en-US");

export function formatUsd(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/** "Today", "Yesterday", "Monday, 10 November". */
export function dayLabel(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const start = (t: number) => {
    const x = new Date(t);
    return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  };
  const diff = Math.round((start(now) - start(ts)) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    ...(d.getFullYear() !== new Date(now).getFullYear() ? { year: "numeric" } : {}),
  });
}

export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** What a run row shows: the refined text, else the error, else the raw transcript. */
export function runText(run: RunRecord): string {
  if (!run.ok) return run.error ?? "Failed";
  return run.refined_text || run.raw_text || "No speech";
}

export function ModeIcon({ mode, className }: { mode: RunMode; className?: string }) {
  const Icon = MODE_ICONS[mode];
  return (
    <span
      title={MODE_LABELS[mode]}
      className={cn("flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground", className)}
    >
      <Icon className="size-3.5" />
    </span>
  );
}

/** A number with its label and a quiet hint under it. */
export function StatTile({ label, value, hint, className }: { label: string; value: ReactNode; hint?: ReactNode; className?: string }) {
  return (
    <Card size="sm" className={cn("gap-1 px-4 py-3.5", className)}>
      <span className="text-label text-muted-foreground">{label}</span>
      <span className="text-display-sm font-semibold tabular-nums">{value}</span>
      {hint ? <span className="text-caption text-muted-foreground">{hint}</span> : null}
    </Card>
  );
}
