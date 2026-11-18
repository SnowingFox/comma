// Comma's own onboarding illustrations: plain SVG shapes animated with motion.
import { motion, useReducedMotion, type Transition } from "motion/react";

const loop = (reduced: boolean | null, t: Transition): Transition => (reduced ? { duration: 0 } : t);

/** Welcome: you speak into the pill, finished lines of text appear above the caret. */
export function SpeakToTextIllustration() {
  const reduced = useReducedMotion();
  const lines = [
    { y: 70, w: 188 },
    { y: 92, w: 212 },
    { y: 114, w: 140 },
  ];
  const bars = [10, 18, 26, 16, 30, 22, 12, 24, 14, 8];
  return (
    <svg viewBox="0 0 320 300" className="h-full w-full" aria-hidden>
      {/* window */}
      <rect x="28" y="28" width="264" height="168" rx="16" className="fill-surface stroke-surface-border" strokeWidth="1.5" />
      <circle cx="48" cy="46" r="4" className="fill-border" />
      <circle cx="62" cy="46" r="4" className="fill-border" />
      <circle cx="76" cy="46" r="4" className="fill-border" />
      {lines.map((l, i) => (
        <motion.rect
          key={l.y}
          x="52"
          y={l.y}
          height="10"
          rx="5"
          className="fill-muted-foreground/35"
          initial={{ width: 0 }}
          animate={{ width: l.w }}
          transition={loop(reduced, { duration: 0.5, delay: 0.5 + i * 0.35, ease: [0.16, 1, 0.3, 1], repeat: Infinity, repeatDelay: 3 })}
        />
      ))}
      <motion.rect
        x="52"
        y="136"
        width="2.5"
        height="16"
        rx="1.25"
        className="fill-brand"
        animate={reduced ? undefined : { opacity: [1, 1, 0, 0] }}
        transition={{ duration: 1, repeat: Infinity, times: [0, 0.5, 0.5, 1] }}
      />
      {/* the bar */}
      <rect x="92" y="226" width="136" height="44" rx="22" className="fill-[oklch(0.2_0.006_286)] stroke-white/10" />
      {bars.map((h, i) => (
        <motion.rect
          key={i}
          x={120 + i * 8.6}
          width="4"
          rx="2"
          className="fill-white"
          initial={{ height: 4, y: 246 }}
          animate={reduced ? { height: h * 0.6, y: 248 - (h * 0.6) / 2 } : { height: [4, h, 6, h * 0.7, 4], y: [246, 248 - h / 2, 245, 248 - (h * 0.7) / 2, 246] }}
          transition={loop(reduced, { duration: 1.4, repeat: Infinity, delay: i * 0.07, ease: "easeInOut" })}
        />
      ))}
      {/* sound rising from the bar into the window */}
      <motion.path
        d="M160 222 C 160 210, 160 206, 160 200"
        className="stroke-muted-foreground/40"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray="3 5"
        fill="none"
        animate={reduced ? undefined : { strokeDashoffset: [0, -16] }}
        transition={{ duration: 0.8, repeat: Infinity, ease: "linear" }}
      />
    </svg>
  );
}

/** Permissions: two settings rows whose switches turn on. */
export function PermissionsIllustration() {
  const reduced = useReducedMotion();
  const rows = [
    { y: 74, label: 120, delay: 0.5 },
    { y: 150, label: 96, delay: 1.1 },
  ];
  return (
    <svg viewBox="0 0 320 300" className="h-full w-full" aria-hidden>
      <rect x="36" y="44" width="248" height="200" rx="18" className="fill-surface stroke-surface-border" strokeWidth="1.5" />
      {rows.map((r) => (
        <g key={r.y}>
          <rect x="58" y={r.y} width="40" height="40" rx="11" className="fill-muted" />
          <rect x="112" y={r.y + 8} width={r.label} height="9" rx="4.5" className="fill-muted-foreground/45" />
          <rect x="112" y={r.y + 24} width={r.label - 36} height="7" rx="3.5" className="fill-muted-foreground/25" />
          <rect x="222" y={r.y + 9} width="40" height="22" rx="11" className="fill-input" />
          <motion.rect
            x="222"
            y={r.y + 9}
            width="40"
            height="22"
            rx="11"
            className="fill-success"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={loop(reduced, { duration: 0.25, delay: r.delay, repeat: Infinity, repeatType: "reverse", repeatDelay: 2.4 })}
          />
          <motion.circle
            cy={r.y + 20}
            r="8"
            className="fill-white"
            initial={{ cx: 233 }}
            animate={{ cx: 251 }}
            transition={loop(reduced, { type: "spring", stiffness: 500, damping: 30, delay: r.delay, repeat: Infinity, repeatType: "reverse", repeatDelay: 2.4 })}
          />
        </g>
      ))}
      {/* row icons: a microphone and a cursor */}
      <path d="M78 82a5 5 0 0 1 5 5v8a5 5 0 0 1-10 0v-8a5 5 0 0 1 5-5Zm-9 13a9 9 0 0 0 18 0M78 104v4" className="stroke-muted-foreground" strokeWidth="2" strokeLinecap="round" fill="none" />
      <path d="M72 158l13 5-5.5 2-2 5.5Z" className="fill-muted-foreground" />
      <rect x="112" y="214" width="96" height="8" rx="4" className="fill-muted-foreground/20" />
    </svg>
  );
}

/** Placeholder steps: a calm tile with the step's glyph. */
export function GlyphIllustration({ children }: { children: React.ReactNode }) {
  const reduced = useReducedMotion();
  return (
    <div className="relative flex h-full w-full items-center justify-center">
      <motion.div
        className="absolute size-44 rounded-full bg-brand/8"
        animate={reduced ? undefined : { scale: [1, 1.08, 1] }}
        transition={{ duration: 3.2, repeat: Infinity, ease: "easeInOut" }}
      />
      <div className="relative flex size-24 items-center justify-center rounded-3xl border border-surface-border bg-surface text-muted-foreground shadow-[var(--surface-shadow)] [&_svg]:size-10">
        {children}
      </div>
    </div>
  );
}
