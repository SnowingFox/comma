import type { ReactNode } from "react";
import { cn } from "@multica/ui/lib/utils";

/** Text on the left, illustration (or a live widget) on the right. */
export function Split({
  title,
  lead,
  children,
  art,
  artClassName,
}: {
  title: string;
  lead: ReactNode;
  children?: ReactNode;
  art: ReactNode;
  artClassName?: string;
}) {
  return (
    <div className="grid h-full grid-cols-[minmax(0,1fr)_400px] items-center gap-10 px-14 py-6">
      <div className="flex max-w-[400px] flex-col gap-5">
        <StepTitle title={title} lead={lead} />
        {children}
      </div>
      <div
        className={cn(
          "flex h-[400px] items-center justify-center overflow-hidden rounded-3xl border border-surface-border bg-app-shell p-6",
          artClassName,
        )}
      >
        {art}
      </div>
    </div>
  );
}

export function StepTitle({ title, lead, className }: { title: string; lead: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <h1 className="text-display-sm font-semibold tracking-tight text-balance">{title}</h1>
      <p className="text-body-lg text-pretty text-muted-foreground">{lead}</p>
    </div>
  );
}

/** A full-width step: title on top, content below. */
export function Stacked({ title, lead, children, aside }: { title: string; lead: ReactNode; children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex min-h-full flex-col gap-5 px-14 py-6">
      <div className="flex items-end justify-between gap-8">
        <StepTitle title={title} lead={lead} className="max-w-[560px]" />
        {aside}
      </div>
      {children}
    </div>
  );
}

export function Panel({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("flex flex-col gap-4 rounded-2xl border border-surface-border bg-surface p-5 shadow-[var(--surface-shadow)]", className)}>
      <div className="flex flex-col gap-0.5">
        <h2 className="text-title-sm font-semibold">{title}</h2>
        {description ? <p className="text-label text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}
