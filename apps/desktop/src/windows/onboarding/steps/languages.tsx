import { useId } from "react";
import { toast } from "sonner";
import { Switch } from "@multica/ui/components/ui/switch";
import { LanguageChips } from "../../../components/language-chips";
import { errorMessage } from "../../../lib/ipc";
import { LANGUAGES, languageName } from "../../../lib/languages";
import { useSettings, useUpdateSettings } from "../../../lib/queries";
import { useStepControls } from "../flow";
import { LanguagesIllustration } from "../illustrations";
import { Split } from "./layout";

const GLYPH: Record<string, string> = { en: "Aa", zh: "文", ja: "あ", ko: "한", ru: "Я", ar: "ع", hi: "अ", es: "Ñ", fr: "Ç", de: "ß", pt: "Ã", it: "È", nl: "IJ", pl: "Ł", tr: "Ğ", vi: "Ơ" };

export function LanguagesStep() {
  const languages = useSettings().data?.languages;
  const update = useUpdateSettings();
  const switchId = useId();
  useStepControls({});
  if (!languages) return null;

  const save = (patch: { spoken?: string[]; auto_detect?: boolean }) =>
    update.mutate({ languages: patch }, { onError: (e) => toast.error(errorMessage(e)) });

  // The illustration shows the picked languages, the fallback in front; defaults fill the rest.
  const shown = [...languages.spoken, ...LANGUAGES.map((l) => l.tag).filter((t) => !languages.spoken.includes(t))]
    .slice(0, 3)
    .reverse()
    .map((t) => GLYPH[t] ?? t) as [string, string, string];
  const fallback = languages.spoken[0];

  return (
    <Split
      title="Which languages do you speak?"
      lead="Pick them in order. Comma detects the language each time; when it is unsure, it uses the first one."
      art={<LanguagesIllustration glyphs={shown} />}
    >
      <LanguageChips label="Languages you speak" value={languages.spoken} max={10} onChange={(spoken) => save({ spoken })} />
      <div className="flex items-start justify-between gap-4 rounded-xl border border-border bg-surface px-4 py-3">
        <label htmlFor={switchId} className="flex flex-col gap-0.5">
          <span className="text-body font-medium">Detect the language automatically</span>
          <span className="text-label text-muted-foreground">
            {languages.auto_detect
              ? fallback
                ? `Falls back to ${languageName(fallback)} when detection is unsure.`
                : "Pick at least one language to use as the fallback."
              : fallback
                ? `Always transcribes as ${languageName(fallback)}.`
                : "Pick the language to transcribe in."}
          </span>
        </label>
        <Switch id={switchId} checked={languages.auto_detect} onCheckedChange={(auto_detect) => save({ auto_detect })} />
      </div>
    </Split>
  );
}
