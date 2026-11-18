import type { ReactNode } from "react";
import { cn } from "@multica/ui/lib/utils";

export function SectionHeader({ title, description }: { title: string; description?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <h2 className="text-title font-semibold tracking-tight">{title}</h2>
      {description ? <p className="text-body text-muted-foreground">{description}</p> : null}
    </div>
  );
}

/** A titled block of settings on a surface card. */
export function Group({
  title,
  description,
  children,
  footer,
  className,
}: {
  title?: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <section className="flex flex-col gap-2.5">
      {title ? (
        <div className="flex flex-col gap-0.5 px-0.5">
          <h3 className="text-label font-semibold">{title}</h3>
          {description ? <p className="text-label text-muted-foreground">{description}</p> : null}
        </div>
      ) : null}
      <div className={cn("overflow-hidden rounded-card border border-surface-border bg-surface shadow-[var(--surface-shadow)]", className)}>
        <div className="flex flex-col gap-5 p-4">{children}</div>
        {footer ? (
          <div className="flex items-center justify-end gap-2 border-t border-surface-border bg-surface-hover/60 px-4 py-2.5">
            {footer}
          </div>
        ) : null}
      </div>
    </section>
  );
}

/** Label and help on the left, control on the right. */
export function Row({ label, description, children }: { label: string; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-body font-medium">{label}</span>
        {description ? <span className="text-label text-muted-foreground">{description}</span> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** Placeholder for settings that ship in a later phase. */
export function Later({ items }: { items: string[] }) {
  return (
    <div className="flex flex-col gap-3 rounded-card border border-dashed border-border p-4">
      <span className="text-label font-medium text-muted-foreground">Coming in a later version</span>
      <ul className="flex flex-col gap-1.5">
        {items.map((item) => (
          <li key={item} className="flex items-center gap-2 text-body text-muted-foreground">
            <span className="size-1 rounded-full bg-faint-foreground" />
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}
