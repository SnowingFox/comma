import { useState } from "react";
import type { UsageDay } from "@comma/shared/ipc";
import { cn } from "@multica/ui/lib/utils";

export type Metric = { id: string; label: string; value: (d: UsageDay) => number; format: (n: number) => string };

/** Up to five round ticks from 0 to at least `max`. */
function ticks(max: number): number[] {
  if (max <= 0) return [0];
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) out.push(Math.round(v * 1e6) / 1e6);
  if (out[out.length - 1]! < max) out.push(out[out.length - 1]! + step);
  return out;
}

function dateLabel(date: string, long = false): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y!, m! - 1, d!).toLocaleDateString("en-GB", long ? { weekday: "short", day: "numeric", month: "short" } : { day: "numeric", month: "short" });
}

/**
 * One series per day as thin bars: rounded data ends on a zero baseline, a recessive grid, sparse
 * date labels, and a hover / focus tooltip per day (the whole column is the hit target). The
 * colour is the validated single-series blue for each theme.
 */
export function DailyChart({ days, metric, height = 180 }: { days: UsageDay[]; metric: Metric; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const values = days.map(metric.value);
  const scale = ticks(Math.max(...values, 0));
  const top = scale[scale.length - 1] || 1;
  const labelEvery = days.length <= 7 ? 1 : days.length <= 31 ? 5 : 15;
  const hovered = hover != null ? days[hover] : undefined;

  return (
    <div className="flex flex-col gap-2">
      <div className="relative flex" style={{ height }}>
        {/* Y axis labels */}
        <div className="relative w-12 shrink-0">
          {scale.map((t) => (
            <span
              key={t}
              className="absolute right-2 -translate-y-1/2 text-micro text-muted-foreground tabular-nums"
              style={{ top: `${100 - (t / top) * 100}%` }}
            >
              {metric.format(t)}
            </span>
          ))}
        </div>
        <div className="relative min-w-0 flex-1" onPointerLeave={() => setHover(null)}>
          {scale.map((t) => (
            <span
              key={t}
              aria-hidden
              className={cn("absolute inset-x-0 border-t", t === 0 ? "border-border" : "border-dashed border-border/60")}
              style={{ top: `${100 - (t / top) * 100}%` }}
            />
          ))}
          <div className="absolute inset-0 flex items-end gap-[2px]" role="list" aria-label={`${metric.label} per day`}>
            {days.map((d, i) => {
              const v = values[i]!;
              return (
                <button
                  key={d.date}
                  type="button"
                  role="listitem"
                  aria-label={`${dateLabel(d.date, true)}: ${metric.format(v)} ${metric.label.toLowerCase()}`}
                  onPointerEnter={() => setHover(i)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                  className="group relative flex h-full min-w-0 flex-1 cursor-default items-end justify-center outline-none"
                >
                  <span
                    className={cn(
                      "w-full max-w-4 rounded-t-[4px] bg-[oklch(0.55_0.16_255)] transition-[filter] dark:bg-[oklch(0.63_0.16_255)]",
                      hover === i && "brightness-110 dark:brightness-125",
                      "group-focus-visible:ring-2 group-focus-visible:ring-ring",
                    )}
                    style={{ height: v > 0 ? `max(${(v / top) * 100}%, 2px)` : 0 }}
                  />
                </button>
              );
            })}
          </div>
          {hovered ? (
            <div
              role="tooltip"
              className="pointer-events-none absolute -top-2 z-10 flex -translate-x-1/2 -translate-y-full flex-col rounded-md border border-border bg-popover px-2.5 py-1.5 whitespace-nowrap shadow-md"
              style={{ left: `${((hover! + 0.5) / days.length) * 100}%` }}
            >
              <span className="text-label font-semibold tabular-nums">{metric.format(metric.value(hovered))}</span>
              <span className="text-caption text-muted-foreground">
                {metric.label}, {dateLabel(hovered.date, true)}
              </span>
            </div>
          ) : null}
        </div>
      </div>
      <div className="flex pl-12">
        {days.map((d, i) => (
          <span key={d.date} className="relative h-4 min-w-0 flex-1">
            {(days.length - 1 - i) % labelEvery === 0 ? (
              <span className="absolute left-1/2 -translate-x-1/2 text-micro whitespace-nowrap text-muted-foreground">{dateLabel(d.date)}</span>
            ) : null}
          </span>
        ))}
      </div>
    </div>
  );
}
