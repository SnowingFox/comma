import { useEffect, useId, useState } from "react";
import {
  LlmBaseUrl,
  MAGPIE_BASE_URL,
  ReasoningEffort,
  type LlmSettings,
} from "@comma/shared/ipc";
import { Input } from "@multica/ui/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@multica/ui/components/ui/select";
import { cn } from "@multica/ui/lib/utils";
import { useSettings, useUpdateSettings } from "../lib/queries";

export const REASONING_LABELS: Record<ReasoningEffort, string> = {
  default: "Model default",
  off: "Off",
  low: "Low",
  medium: "Medium",
  high: "High",
};

const reasoningItems = ReasoningEffort.options.map((value) => ({ value, label: REASONING_LABELS[value] }));

/** Local edits to the LLM settings, saved explicitly. */
export function useLlmDraft() {
  const settings = useSettings();
  const update = useUpdateSettings();
  const saved = settings.data?.llm;
  const [draft, setDraft] = useState<LlmSettings | undefined>(saved);

  // Take the stored value once it loads, and again after another window changes it.
  useEffect(() => {
    if (saved) setDraft(saved);
  }, [saved]);

  const urlCheck = draft ? LlmBaseUrl.safeParse(draft.base_url.trim()) : undefined;
  const urlError = urlCheck && !urlCheck.success ? "Enter a full http:// or https:// URL" : undefined;
  const dirty =
    !!draft &&
    !!saved &&
    (draft.base_url.trim() !== saved.base_url ||
      draft.model.trim() !== saved.model ||
      draft.reasoning_effort !== saved.reasoning_effort);

  const save = async () => {
    if (!draft || urlError) return false;
    if (!dirty) return true;
    await update.mutateAsync({
      llm: { base_url: draft.base_url.trim(), model: draft.model.trim(), reasoning_effort: draft.reasoning_effort },
    });
    return true;
  };

  return {
    draft,
    setDraft: (patch: Partial<LlmSettings>) => setDraft((d) => (d ? { ...d, ...patch } : d)),
    reset: () => setDraft(saved),
    urlError,
    dirty,
    saving: update.isPending,
    save,
  };
}

export type LlmDraft = ReturnType<typeof useLlmDraft>;

export function LlmFields({
  llm,
  showReasoning = true,
  className,
}: {
  llm: LlmDraft;
  showReasoning?: boolean;
  className?: string;
}) {
  const urlId = useId();
  const modelId = useId();
  const { draft, setDraft, urlError } = llm;
  if (!draft) return null;

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={urlId} className="text-label font-medium">
          Base URL
        </label>
        <Input
          id={urlId}
          value={draft.base_url}
          onChange={(e) => setDraft({ base_url: e.target.value })}
          placeholder={MAGPIE_BASE_URL}
          spellCheck={false}
          aria-invalid={!!urlError}
          className="font-mono placeholder:font-sans"
        />
        <p className={cn("text-caption", urlError ? "text-destructive" : "text-muted-foreground")}>
          {urlError ?? "Any OpenAI-compatible endpoint, up to /v1."}
        </p>
      </div>
      <div className={cn("grid gap-4", showReasoning && "grid-cols-[1fr_auto]")}>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={modelId} className="text-label font-medium">
            Model
          </label>
          <Input
            id={modelId}
            value={draft.model}
            onChange={(e) => setDraft({ model: e.target.value })}
            placeholder="deepseek-chat"
            spellCheck={false}
            className="font-mono placeholder:font-sans"
          />
        </div>
        {showReasoning ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-label font-medium">Reasoning effort</span>
            <Select
              items={reasoningItems}
              value={draft.reasoning_effort}
              onValueChange={(value) => {
                const parsed = ReasoningEffort.safeParse(value);
                if (parsed.success) setDraft({ reasoning_effort: parsed.data });
              }}
            >
              <SelectTrigger className="w-40" aria-label="Reasoning effort">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {reasoningItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
      </div>
    </div>
  );
}
