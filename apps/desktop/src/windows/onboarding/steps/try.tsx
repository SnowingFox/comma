import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { DEFAULT_SHORTCUTS } from "@comma/shared/ipc";
import { Button } from "@multica/ui/components/ui/button";
import { Check, Copy, Send, X } from "@multica/ui/icons";
import { cn } from "@multica/ui/lib/utils";
import { LanguageChips } from "../../../components/language-chips";
import { errorMessage } from "../../../lib/ipc";
import { languageName } from "../../../lib/languages";
import { useSettings, useUpdateSettings } from "../../../lib/queries";
import { useVoiceRun } from "../../../lib/use-voice-run";
import { useStepControls } from "../flow";
import { Stacked } from "./layout";
import { NeedsKeys, RawToggle, RunStatus, Sweep, useTryReady } from "./try-parts";

// ---- Dictate --------------------------------------------------------------------------------------

const CHAT = [
  { from: "them", text: "Morning! Are we still meeting this week?" },
  { from: "them", text: "And can you bring the slides from Monday?" },
] as const;

export function TryDictateStep() {
  const accel = useSettings().data?.shortcuts.dictate ?? DEFAULT_SHORTCUTS.dictate;
  const { ready, missing } = useTryReady();
  const run = useVoiceRun({ mode: "dictate", accel, enabled: ready });
  const [view, setView] = useState<"refined" | "raw">("refined");
  const [sent, setSent] = useState<string[]>([]);
  const { phase } = run;
  useStepControls({});

  const shown = phase.kind === "done" ? (view === "raw" ? phase.raw.text : phase.refined.text) : "";

  return (
    <Stacked title="Dictate" lead="Hold the shortcut, say a reply, and let go. Comma removes the fillers and fixes the punctuation.">
      {!ready && missing ? (
        <NeedsKeys missing={missing} />
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex h-[300px] flex-col overflow-hidden rounded-2xl border border-surface-border bg-surface shadow-[var(--surface-shadow)]">
            <div className="flex items-center gap-2.5 border-b border-surface-border px-4 py-2.5">
              <span className="flex size-7 items-center justify-center rounded-full bg-brand/15 text-caption font-semibold text-brand">SL</span>
              <span className="text-label font-medium">Sam Lee</span>
              <span className="text-caption text-muted-foreground">sample chat</span>
            </div>
            <div className="scrollbar-slim flex flex-1 flex-col justify-end gap-2 overflow-y-auto px-4 py-3">
              {CHAT.map((m) => (
                <p key={m.text} className="max-w-[70%] self-start rounded-2xl rounded-bl-md bg-muted px-3.5 py-2 text-body">
                  {m.text}
                </p>
              ))}
              <AnimatePresence initial={false}>
                {sent.map((text, i) => (
                  <motion.p
                    key={i}
                    initial={{ opacity: 0, y: 8, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    className="max-w-[70%] self-end rounded-2xl rounded-br-md bg-brand px-3.5 py-2 text-body text-brand-foreground"
                  >
                    {text}
                  </motion.p>
                ))}
              </AnimatePresence>
            </div>
            <div className="flex items-end gap-2 border-t border-surface-border p-3">
              <div
                className={cn(
                  "selectable min-h-10 flex-1 rounded-xl border px-3.5 py-2 text-body transition-colors",
                  phase.kind === "recording" ? "border-brand/60 bg-brand/5" : "border-border bg-background",
                )}
              >
                {shown ? (
                  <Sweep id={`${view}-${shown}`}>{shown}</Sweep>
                ) : (
                  <span className="text-muted-foreground">{phase.kind === "recording" ? "Listening…" : "Message"}</span>
                )}
              </div>
              <Button
                size="icon"
                aria-label="Send"
                disabled={phase.kind !== "done"}
                onClick={() => {
                  if (phase.kind !== "done") return;
                  setSent((s) => [...s, phase.refined.text]);
                  run.reset();
                  setView("refined");
                }}
              >
                <Send />
              </Button>
            </div>
          </div>
          <div className="flex items-center justify-between gap-4">
            <RunStatus phase={phase} level={run.level} accel={accel} />
            {phase.kind === "done" ? <RawToggle value={view} onChange={setView} /> : null}
          </div>
        </div>
      )}
    </Stacked>
  );
}

// ---- Ask Anything ---------------------------------------------------------------------------------

const PARAGRAPH =
  "Comma is a small app that listens while you hold a shortcut and then writes what you said into whatever app you are using at that moment. It takes out the ums and the false starts, adds the punctuation for you, and keeps your own words, so that a quick spoken note ends up reading like something you sat down and typed with care.";

type Edit = { before: string; inserted: string; after: string; n: number };

/** Character offsets of the selection inside `root`, or null when nothing in it is selected. */
function selectionIn(root: HTMLElement | null): { start: number; end: number } | null {
  const sel = window.getSelection();
  if (!root || !sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;
  const pre = document.createRange();
  pre.selectNodeContents(root);
  pre.setEnd(range.startContainer, range.startOffset);
  const start = pre.toString().length;
  return { start, end: start + range.toString().length };
}

export function TryAskStep() {
  const accel = useSettings().data?.shortcuts.ask ?? DEFAULT_SHORTCUTS.ask;
  const { ready, missing } = useTryReady();
  const paragraphRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState<Edit>({ before: PARAGRAPH, inserted: "", after: "", n: 0 });
  const [answer, setAnswer] = useState<string | null>(null);
  const [done, setDone] = useState({ rewrite: false, question: false });
  const range = useRef<{ start: number; end: number } | null>(null);
  const full = text.before + text.inserted + text.after;

  const run = useVoiceRun({
    mode: "ask",
    accel,
    toggle: true,
    enabled: ready,
    context: () => {
      range.current = selectionIn(paragraphRef.current);
      return range.current ? { selected_text: full.slice(range.current.start, range.current.end) } : {};
    },
  });
  const { phase } = run;
  useStepControls({});

  // Apply each finished run once: inline answers replace the selection, others open the card.
  const applied = useRef<unknown>(null);
  useEffect(() => {
    if (phase.kind !== "done" || applied.current === phase) return;
    applied.current = phase;
    const sel = range.current;
    if (sel && phase.refined.delivery !== "external") {
      setText((t) => ({ before: full.slice(0, sel.start), inserted: phase.refined.text, after: full.slice(sel.end), n: t.n + 1 }));
      window.getSelection()?.removeAllRanges();
      setDone((d) => ({ ...d, rewrite: true }));
    } else {
      setAnswer(phase.refined.text);
      setDone((d) => ({ ...d, question: true }));
    }
  }, [phase, full]);

  const tasks = [
    { key: "rewrite", label: "Select some of the paragraph, then ask for a change, such as “make it shorter”.", done: done.rewrite },
    { key: "question", label: "Click away so nothing is selected, then ask a question.", done: done.question },
  ];

  return (
    <Stacked title="Ask Anything" lead="Tap the shortcut, say what you want, and tap again. With text selected, Comma changes it. With nothing selected, it answers.">
      {!ready && missing ? (
        <NeedsKeys missing={missing} />
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)_260px] gap-5">
          <div className="flex flex-col gap-3">
            <div
              ref={paragraphRef}
              data-sample="paragraph"
              className="selectable rounded-2xl border border-surface-border bg-surface p-5 text-body-lg leading-relaxed shadow-[var(--surface-shadow)] selection:bg-brand/25"
            >
              {text.before}
              {text.inserted ? <Sweep id={text.n}>{text.inserted}</Sweep> : null}
              {text.after}
            </div>
            <AnimatePresence>
              {answer ? (
                <motion.div
                  initial={{ opacity: 0, y: 10, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 6 }}
                  transition={{ type: "spring", stiffness: 420, damping: 32 }}
                  className="flex flex-col gap-2 rounded-2xl bg-[oklch(0.2_0.006_286)] p-4 text-white shadow-xl ring-1 ring-white/10"
                  role="dialog"
                  aria-label="Answer"
                >
                  <p className="selectable max-h-32 overflow-y-auto text-body">{answer}</p>
                  <div className="flex justify-end gap-1.5">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-white hover:bg-white/10 hover:text-white"
                      onClick={() =>
                        void navigator.clipboard.writeText(answer).then(
                          () => toast.success("Copied"),
                          (e: unknown) => toast.error(errorMessage(e)),
                        )
                      }
                    >
                      <Copy /> Copy
                    </Button>
                    <Button size="sm" variant="ghost" className="text-white hover:bg-white/10 hover:text-white" onClick={() => setAnswer(null)}>
                      <X /> Close
                    </Button>
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>
            <RunStatus phase={phase} level={run.level} accel={accel} hold={false} />
          </div>
          <ol className="flex flex-col gap-2.5">
            {tasks.map((t, i) => (
              <li key={t.key} className="flex gap-2.5 rounded-xl border border-border bg-surface p-3">
                <motion.span
                  key={String(t.done)}
                  initial={t.done ? { scale: 0.6 } : false}
                  animate={{ scale: 1 }}
                  transition={{ type: "spring", stiffness: 500, damping: 16 }}
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded-full text-micro font-semibold",
                    t.done ? "bg-success text-white" : "bg-muted text-muted-foreground",
                  )}
                >
                  {t.done ? <Check className="size-3" /> : i + 1}
                </motion.span>
                <span className={cn("text-label", t.done && "text-muted-foreground")}>{t.label}</span>
              </li>
            ))}
            {text.inserted ? (
              <Button variant="ghost" size="sm" className="self-start" onClick={() => setText({ before: PARAGRAPH, inserted: "", after: "", n: 0 })}>
                Restore the paragraph
              </Button>
            ) : null}
          </ol>
        </div>
      )}
    </Stacked>
  );
}

// ---- Translate ------------------------------------------------------------------------------------

export function TryTranslateStep() {
  const settings = useSettings().data;
  const update = useUpdateSettings();
  const accel = settings?.shortcuts.translate ?? DEFAULT_SHORTCUTS.translate;
  const targets = settings?.languages.translate_targets ?? [];
  const target = targets[0];
  const { ready, missing } = useTryReady();
  const run = useVoiceRun({ mode: "translate", accel, enabled: ready && !!target, context: () => ({ target_language: target }) });
  const [view, setView] = useState<"refined" | "raw">("refined");
  const { phase } = run;
  useStepControls({});

  const shown = phase.kind === "done" ? (view === "raw" ? phase.raw.text : phase.refined.text) : "";

  return (
    <Stacked title="Translate" lead="Speak in your language and Comma writes it in another. Pick up to three targets; the first is used.">
      {!ready && missing ? (
        <NeedsKeys missing={missing} />
      ) : (
        <div className="flex flex-col gap-4">
          <LanguageChips
            label="Translate into"
            value={targets}
            max={3}
            onChange={(next) => update.mutate({ languages: { translate_targets: next } }, { onError: (e) => toast.error(errorMessage(e)) })}
          />
          <div
            className={cn(
              "flex min-h-[132px] flex-col gap-2 rounded-2xl border bg-surface p-5 shadow-[var(--surface-shadow)] transition-colors",
              phase.kind === "recording" ? "border-brand/60" : "border-surface-border",
            )}
          >
            <span className="text-caption font-medium text-muted-foreground uppercase">
              {target ? (view === "raw" && shown ? "What you said" : languageName(target)) : "Pick a language above"}
            </span>
            <p className="selectable text-body-lg">
              {shown ? <Sweep id={`${view}-${shown}`}>{shown}</Sweep> : <span className="text-muted-foreground">The translation appears here.</span>}
            </p>
          </div>
          <div className="flex items-center justify-between gap-4">
            {target ? <RunStatus phase={phase} level={run.level} accel={accel} idle={`and speak, then let go. Comma writes it in ${languageName(target)}.`} /> : <span />}
            {phase.kind === "done" ? <RawToggle value={view} onChange={setView} /> : null}
          </div>
        </div>
      )}
    </Stacked>
  );
}
