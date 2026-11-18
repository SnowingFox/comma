import type { ReactNode } from "react";

export function Section({ title, children, trailing }: { title: string; children: ReactNode; trailing?: ReactNode }) {
  return (
    <section className="cdt-section">
      <div className="cdt-row" style={{ gridTemplateColumns: "1fr auto" }}>
        <span className="cdt-section-title">{title}</span>
        {trailing}
      </div>
      {children}
    </section>
  );
}

export function Row({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return (
    <div className="cdt-row">
      <span className="cdt-label" title={label}>
        {label}
      </span>
      <span className="cdt-value" title={title} data-testid={`devtool-row-${label}`}>
        {children}
      </span>
    </div>
  );
}

export function DevButton({
  onClick,
  children,
  danger,
  active,
  disabled,
}: {
  onClick: () => void;
  children: ReactNode;
  danger?: boolean;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button type="button" className="cdt-button" data-danger={danger || undefined} data-active={active || undefined} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

export type Tone = "on" | "warn" | "bad" | undefined;

export function Status({ tone, children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className="cdt-status" data-tone={tone}>
      {children}
    </span>
  );
}

export function Note({ tone, children }: { tone?: "warn" | "bad"; children: ReactNode }) {
  return (
    <p className="cdt-note" data-tone={tone}>
      {children}
    </p>
  );
}

export const muted = (text: string) => <span className="cdt-muted">{text}</span>;

/** 21:43:07.912 */
export function clock(ms: number): string {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

export function msText(ms: number | null | undefined): string {
  return ms === null || ms === undefined ? "–" : ms >= 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)}`;
}
