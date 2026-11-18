// Comma's own onboarding illustrations: plain SVG shapes animated with motion.
import { motion, useReducedMotion, type Transition } from "motion/react";
import type { AppMode } from "@comma/shared/ipc";
import { cn } from "@multica/ui/lib/utils";
import { COMMA_GLYPH } from "../../components/brand";

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

/**
 * How Comma runs: the Mac at the bottom, the two providers at the top. Local sends straight from
 * the Mac; the account path goes through the Comma server in the middle.
 */
export function ModeIllustration({ mode }: { mode: AppMode }) {
  const reduced = useReducedMotion();
  const account = mode === "account";
  const flow = (delay: number): Transition => (reduced ? { duration: 0 } : { duration: 1.2, repeat: Infinity, ease: "linear", delay });
  const direct = ["M150 236 C 110 200, 90 160, 84 104", "M190 236 C 230 200, 250 160, 256 104"];
  const viaServer = ["M170 236 L 170 200", "M150 150 C 120 136, 96 124, 84 104", "M190 150 C 220 136, 244 124, 256 104"];
  return (
    <svg viewBox="0 0 340 340" className="h-full w-full" aria-hidden>
      {/* providers */}
      {[
        { x: 40, label: "speech" },
        { x: 212, label: "text" },
      ].map((p, i) => (
        <g key={p.label}>
          <rect x={p.x} y="44" width="88" height="60" rx="14" className="fill-surface stroke-surface-border" strokeWidth="1.5" />
          {i === 0
            ? [8, 16, 24, 14, 20, 10].map((h, j) => (
                <rect key={j} x={p.x + 22 + j * 8} y={74 - h / 2} width="4" height={h} rx="2" className="fill-muted-foreground/60" />
              ))
            : [0, 1, 2].map((j) => (
                <rect key={j} x={p.x + 18} y={62 + j * 10} width={[52, 40, 46][j]} height="5" rx="2.5" className="fill-muted-foreground/50" />
              ))}
        </g>
      ))}
      {/* server */}
      <motion.g initial={false} animate={{ opacity: account ? 1 : 0.18 }} transition={{ duration: 0.25 }}>
        <rect x="126" y="140" width="88" height="56" rx="12" className="fill-surface stroke-surface-border" strokeWidth="1.5" />
        {[0, 1].map((j) => (
          <g key={j}>
            <rect x="140" y={152 + j * 18} width="60" height="12" rx="4" className="fill-muted" />
            <circle cx="190" cy={158 + j * 18} r="2.2" className={account ? "fill-success" : "fill-muted-foreground/40"} />
          </g>
        ))}
      </motion.g>
      {/* paths */}
      {(account ? viaServer : direct).map((d, i) => (
        <g key={`${mode}-${i}`}>
          <path d={d} fill="none" className="stroke-border" strokeWidth="2" strokeLinecap="round" />
          <motion.path
            d={d}
            fill="none"
            className="stroke-brand"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray="4 10"
            initial={{ strokeDashoffset: 0, opacity: 0 }}
            animate={{ strokeDashoffset: reduced ? 0 : -28, opacity: 1 }}
            transition={{ strokeDashoffset: flow(i * 0.15), opacity: { duration: 0.2 } }}
          />
        </g>
      ))}
      {/* the Mac */}
      <rect x="110" y="236" width="120" height="74" rx="10" className="fill-surface stroke-surface-border" strokeWidth="1.5" />
      <rect x="96" y="304" width="148" height="8" rx="4" className="fill-muted-foreground/30" />
      <g transform="translate(150 252) scale(1.7)">
        <rect width="24" height="24" rx="6.5" className="fill-foreground" />
        <path d={COMMA_GLYPH} className="fill-background" />
      </g>
      {/* a key on the Mac (local) or a person (account) */}
      <motion.g key={mode} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}>
        {account ? (
          <path d="M262 266a8 8 0 1 1 0 .1M248 298c2-9 8-14 14-14s12 5 14 14" className="stroke-muted-foreground" strokeWidth="2" fill="none" strokeLinecap="round" />
        ) : (
          <path d="M256 270a7 7 0 1 1 7 7l-1 1v4h-4v4h-4v4h-6v-6l9-9a7 7 0 0 1-1-5Z" className="stroke-muted-foreground" strokeWidth="2" fill="none" strokeLinejoin="round" />
        )}
      </motion.g>
    </svg>
  );
}

/** Languages: three bubbles in different scripts; the fallback language sits in front. */
export function LanguagesIllustration({ glyphs }: { glyphs: [string, string, string] }) {
  const reduced = useReducedMotion();
  const bubbles = [
    { x: 64, y: 70, w: 150, rot: -4, delay: 0 },
    { x: 140, y: 150, w: 150, rot: 3, delay: 0.4 },
    { x: 54, y: 228, w: 170, rot: -2, delay: 0.8 },
  ];
  return (
    <svg viewBox="0 0 340 340" className="h-full w-full" aria-hidden>
      {bubbles.map((b, i) => (
        <motion.g
          key={i}
          animate={reduced ? undefined : { y: [0, -5, 0] }}
          transition={{ duration: 3, repeat: Infinity, ease: "easeInOut", delay: b.delay }}
        >
          <g transform={`rotate(${b.rot} ${b.x + b.w / 2} ${b.y + 30})`}>
            <rect x={b.x} y={b.y} width={b.w} height="60" rx="20" className={i === 2 ? "fill-foreground" : "fill-surface stroke-surface-border"} strokeWidth="1.5" />
            <path d={`M${b.x + 26} ${b.y + 58} l-6 14 l18 -12`} className={i === 2 ? "fill-foreground" : "fill-surface"} />
            <text
              x={b.x + 24}
              y={b.y + 39}
              className={cn("text-[24px] font-semibold", i === 2 ? "fill-background" : "fill-foreground")}
            >
              {glyphs[i]}
            </text>
            {[0, 1].map((j) => (
              <rect
                key={j}
                x={b.x + 64}
                y={b.y + 22 + j * 12}
                width={b.w - 88 - j * 20}
                height="6"
                rx="3"
                className={i === 2 ? "fill-background/40" : "fill-muted-foreground/30"}
              />
            ))}
          </g>
        </motion.g>
      ))}
    </svg>
  );
}

type KeyDef = { id: string; label: string; w?: number };

const ROWS: KeyDef[][] = [
  [..."`1234567890-=".split("").map((c, i) => ({ id: ["Backquote", "1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "Minus", "Equal"][i]!, label: c })), { id: "Backspace", label: "⌫", w: 1.5 }],
  [{ id: "Tab", label: "⇥", w: 1.5 }, ..."QWERTYUIOP".split("").map((c) => ({ id: c, label: c })), { id: "BracketLeft", label: "[" }, { id: "BracketRight", label: "]" }, { id: "Backslash", label: "\\" }],
  [{ id: "Caps", label: "⇪", w: 1.75 }, ..."ASDFGHJKL".split("").map((c) => ({ id: c, label: c })), { id: "Semicolon", label: ";" }, { id: "Quote", label: "'" }, { id: "Enter", label: "↩", w: 1.75 }],
  [{ id: "ShiftLeft", label: "⇧", w: 2.25 }, ..."ZXCVBNM".split("").map((c) => ({ id: c, label: c })), { id: "Comma", label: "," }, { id: "Period", label: "." }, { id: "Slash", label: "/" }, { id: "ShiftRight", label: "⇧", w: 2.25 }],
  [
    { id: "Fn", label: "fn" },
    { id: "ControlLeft", label: "⌃" },
    { id: "AltLeft", label: "⌥" },
    { id: "MetaLeft", label: "⌘", w: 1.25 },
    { id: "Space", label: "", w: 5 },
    { id: "MetaRight", label: "⌘", w: 1.25 },
    { id: "AltRight", label: "⌥" },
    { id: "Left", label: "←" },
    { id: "Up", label: "↕" },
    { id: "Right", label: "→" },
  ],
];

const GENERIC: Record<string, string> = {
  ShiftLeft: "Shift",
  ShiftRight: "Shift",
  ControlLeft: "Control",
  AltLeft: "Alt",
  AltRight: "Alt",
  MetaLeft: "Super",
  MetaRight: "Super",
};

/**
 * A laptop keyboard. Keys in `target` are outlined; keys in `held` press down and fill with the
 * accent (scale 0.96, 120 ms), like the keycaps elsewhere.
 */
export function KeyboardIllustration({ target, held }: { target: ReadonlySet<string>; held: ReadonlySet<string> }) {
  const u = 30;
  const gap = 4;
  const width = 14.5 * u;
  return (
    <svg viewBox={`-10 -10 ${width + 20} ${5 * u + 20}`} className="w-full" aria-hidden>
      <rect x="-10" y="-10" width={width + 20} height={5 * u + 20} rx="16" className="fill-surface stroke-surface-border" strokeWidth="1.5" />
      {ROWS.map((row, r) => {
        let x = 0;
        return row.map((key, k) => {
          const w = (key.w ?? 1) * u - gap;
          const kx = x;
          x += (key.w ?? 1) * u;
          // `Shift` in an ordinary shortcut means either side; `ShiftLeft` in an Fn one means that key.
          const generic = GENERIC[key.id];
          const lit = held.has(key.id) || (generic !== undefined && held.has(generic));
          const wanted = target.has(key.id) || (generic !== undefined && target.has(generic));
          return (
            <motion.g
              key={`${r}-${k}`}
              animate={{ scale: lit ? 0.96 : 1 }}
              transition={{ duration: 0.12, ease: "easeOut" }}
            >
              <rect
                x={kx}
                y={r * u}
                width={w}
                height={u - gap}
                rx="5"
                className={cn(
                  "transition-[fill,stroke] duration-[120ms]",
                  lit ? "fill-brand stroke-brand" : wanted ? "fill-background stroke-brand/70" : "fill-background stroke-border",
                )}
                strokeWidth={wanted ? 1.5 : 1}
              />
              {key.label ? (
                <text
                  x={kx + w / 2}
                  y={r * u + (u - gap) / 2 + 4}
                  textAnchor="middle"
                  className={cn("text-[11px] font-medium", lit ? "fill-brand-foreground" : wanted ? "fill-foreground" : "fill-muted-foreground/70")}
                >
                  {key.label}
                </text>
              ) : null}
            </motion.g>
          );
        });
      })}
    </svg>
  );
}

/** Done: the comma mark draws in, with three soft rings for the three modes. */
export function DoneIllustration() {
  const reduced = useReducedMotion();
  return (
    <svg viewBox="0 0 340 340" className="h-full w-full" aria-hidden>
      {[120, 90, 60].map((r, i) => (
        <motion.circle
          key={r}
          cx="170"
          cy="170"
          r={r}
          fill="none"
          className="stroke-brand"
          strokeWidth="1.5"
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: reduced ? 0.2 : [0, 0.28, 0.12], scale: 1 }}
          transition={{ duration: 1.2, delay: 0.2 + i * 0.15, ease: "easeOut" }}
        />
      ))}
      <motion.g
        initial={{ scale: 0.6, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", stiffness: 260, damping: 18, delay: 0.1 }}
      >
        <g transform="translate(122 122) scale(4)">
          <rect width="24" height="24" rx="6.5" className="fill-foreground" />
          <path d={COMMA_GLYPH} className="fill-background" />
        </g>
      </motion.g>
    </svg>
  );
}
