import { useState, type ReactNode } from "react";
import { MAGPIE_BASE_URL } from "@comma/shared/ipc";
import { Kbd, KbdGroup } from "@multica/ui/components/ui/kbd";
import { ArrowUpRight, Check, Keyboard, Mic, Sparkles } from "@multica/ui/icons";
import { cn } from "@multica/ui/lib/utils";
import { LlmFields, type LlmDraft } from "../../components/llm-fields";
import { PermissionList } from "../../components/permission-list";
import { SecretField } from "../../components/secret-field";
import { useSettings } from "../../lib/queries";
import { ModeChoice } from "../../components/mode-choice";
import { DEFAULT_SHORTCUTS } from "../../components/shortcut-list";
import { ELEVENLABS_KEYS_URL, openExternal } from "../../lib/external";
import { GlyphIllustration, PermissionsIllustration, SpeakToTextIllustration } from "./illustrations";

/** Text on the left, illustration on the right. */
function Split({ title, lead, children, art }: { title: string; lead: ReactNode; children?: ReactNode; art: ReactNode }) {
  return (
    <div className="grid h-full grid-cols-[minmax(0,1fr)_380px] items-center gap-10 px-14">
      <div className="flex max-w-[400px] flex-col gap-5">
        <div className="flex flex-col gap-2.5">
          <h1 className="text-display-sm font-semibold tracking-tight text-balance">{title}</h1>
          <p className="text-body-lg text-muted-foreground">{lead}</p>
        </div>
        {children}
      </div>
      <div className="flex h-[380px] items-center justify-center rounded-3xl border border-surface-border bg-app-shell p-6">
        {art}
      </div>
    </div>
  );
}

export function WelcomeStep() {
  return (
    <Split
      title="Speak. Comma writes it down."
      lead="Hold a shortcut in any app, say what you mean, and let go. Clean, punctuated text appears at your cursor."
      art={<SpeakToTextIllustration />}
    >
      <ul className="flex flex-col gap-2.5 text-body text-muted-foreground">
        {[
          "Fillers and false starts are removed for you",
          "Works in every app with a text field",
          "Your keys, your providers, kept in your Keychain",
        ].map((t) => (
          <li key={t} className="flex items-center gap-2.5">
            <span className="flex size-5 items-center justify-center rounded-full bg-success/12 text-success">
              <Check className="size-3" />
            </span>
            {t}
          </li>
        ))}
      </ul>
    </Split>
  );
}

function Panel({ title, description, children, className }: { title: string; description: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("flex flex-col gap-4 rounded-2xl border border-surface-border bg-surface p-5 shadow-[var(--surface-shadow)]", className)}>
      <div className="flex flex-col gap-0.5">
        <h2 className="text-title-sm font-semibold">{title}</h2>
        <p className="text-label text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  );
}

export function KeysStep({ llm }: { llm: LlmDraft }) {
  const mode = useSettings().data?.mode;
  const [custom, setCustom] = useState(() => !!llm.draft && llm.draft.base_url !== MAGPIE_BASE_URL);
  const useMagpie = () => {
    setCustom(false);
    llm.setDraft({ base_url: MAGPIE_BASE_URL });
  };

  return (
    <div className="flex h-full flex-col gap-5 px-14 pt-2">
      <div className="flex items-end justify-between gap-8">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-display-sm font-semibold tracking-tight">Connect your providers</h1>
          <p className="text-body-lg text-muted-foreground">
            Comma sends your voice to ElevenLabs and the transcript to a language model of your choice.
          </p>
        </div>
      </div>
      <ModeChoice className="[&>button]:py-2.5" />
      {mode === "account" ? (
        <div className="flex flex-1 items-start">
          <p className="rounded-xl border border-dashed border-border p-4 text-body text-muted-foreground">
            Signing in to a Comma server arrives in a later version. You can continue now and switch in Settings
            whenever you like.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4">
          <Panel title="Speech to text" description="ElevenLabs Scribe">
            <SecretField
              name="elevenlabs"
              label="ElevenLabs API key"
              description={
                <>
                  Needs the Speech to Text permission.{" "}
                  <button type="button" className="text-foreground underline underline-offset-2" onClick={() => openExternal(ELEVENLABS_KEYS_URL)}>
                    Create a key
                    <ArrowUpRight className="ml-0.5 inline size-3" />
                  </button>
                </>
              }
            />
          </Panel>
          <Panel title="Rewrite" description="Any OpenAI-compatible model">
            <div role="radiogroup" aria-label="LLM endpoint" className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-[3px]">
              {[
                { on: !custom, label: "Magpie on this Mac", click: useMagpie },
                { on: custom, label: "Custom endpoint", click: () => setCustom(true) },
              ].map((o) => (
                <button
                  key={o.label}
                  type="button"
                  role="radio"
                  aria-checked={o.on}
                  onClick={o.click}
                  className={cn(
                    "h-7 rounded-md text-label font-medium transition-colors",
                    o.on ? "bg-background text-foreground shadow-sm dark:bg-input/60" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {o.label}
                </button>
              ))}
            </div>
            {custom ? (
              <>
                <LlmFields llm={llm} showReasoning={false} className="gap-3" />
                <SecretField name="llm" label="API key" placeholder="Leave empty if not needed" />
              </>
            ) : (
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-2.5 rounded-lg border border-border px-3 py-2.5">
                  <span className="size-2 rounded-full bg-muted-foreground/50" />
                  <div className="flex flex-col">
                    <span className="text-label font-medium">Local gateway</span>
                    <span className="font-mono text-caption text-muted-foreground">{MAGPIE_BASE_URL}</span>
                  </div>
                </div>
                <p className="text-caption text-muted-foreground">
                  No key needed. A live check and a test button come in a later version.
                </p>
              </div>
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}

export function PermissionsStep() {
  return (
    <Split
      title="Two permissions"
      lead="macOS asks you to allow these once. The status below updates by itself."
      art={<PermissionsIllustration />}
    >
      <PermissionList className="bg-surface" />
      <p className="text-caption text-muted-foreground">You can change these later in System Settings &gt; Privacy & Security.</p>
    </Split>
  );
}

export function PlaceholderStep({ title, lead, icon }: { title: string; lead: string; icon: ReactNode }) {
  return (
    <Split title={title} lead={lead} art={<GlyphIllustration>{icon}</GlyphIllustration>}>
      <span className="w-fit rounded-full border border-dashed border-border px-3 py-1 text-caption text-muted-foreground">
        This step arrives in a later version
      </span>
    </Split>
  );
}

export const PLACEHOLDERS = {
  shortcut: {
    title: "Try the shortcut",
    lead: "Press and hold your Dictate shortcut. The keys light up while you hold them.",
    icon: <Keyboard />,
  },
  microphone: {
    title: "Check your microphone",
    lead: "Pick a microphone, say a sentence, and see the raw transcript.",
    icon: <Mic />,
  },
  try: {
    title: "Try it",
    lead: "Hold the shortcut over the sample field and watch the cleaned-up text arrive.",
    icon: <Sparkles />,
  },
} as const;

export function DoneStep() {
  return (
    <Split
      title="You're set"
      lead="Comma lives in your menu bar. These shortcuts work in any app."
      art={
        <GlyphIllustration>
          <Check className="text-success" />
        </GlyphIllustration>
      }
    >
      <ul className="flex flex-col divide-y divide-border rounded-xl border border-surface-border bg-surface px-4">
        {DEFAULT_SHORTCUTS.map((s) => (
          <li key={s.mode} className="flex items-center justify-between py-3">
            <span className="text-body font-medium">{s.mode}</span>
            <KbdGroup>
              {s.keys.map((k) => (
                <Kbd key={k} className="h-6 min-w-6 px-1.5 text-label">
                  {k}
                </Kbd>
              ))}
            </KbdGroup>
          </li>
        ))}
      </ul>
    </Split>
  );
}
