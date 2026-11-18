import { useEffect, useId, useState } from "react";
import { match } from "ts-pattern";
import { LlmBaseUrl, MAGPIE_BASE_URL, ReasoningEffort, type LlmSettings } from "@comma/shared/ipc";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@multica/ui/components/ui/select";
import { RefreshCw } from "@multica/ui/icons";
import { cn } from "@multica/ui/lib/utils";
import { plural } from "../lib/format";
import { errorMessage } from "../lib/ipc";
import { useLlmTest, useModels, useSettings, useUpdateSettings } from "../lib/queries";
import { ModelPicker } from "./model-picker";
import { describeLlmTest, ProviderTest } from "./provider-test";
import { SecretField } from "./secret-field";
import { StatusDot, type DotTone } from "./status-dot";

export const REASONING_LABELS: Record<ReasoningEffort, string> = {
  default: "Model default",
  off: "Off",
  low: "Low",
  medium: "Medium",
  high: "High",
};

const reasoningItems = ReasoningEffort.options.map((value) => ({ value, label: REASONING_LABELS[value] }));

const MODEL_MEMORY = "comma-last-model:";
const CUSTOM_MEMORY = "comma-last-custom-base";

function remembered(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function remember(key: string, value: string) {
  try {
    if (value) localStorage.setItem(key, value);
  } catch {
    // storage unavailable: nothing to remember
  }
}

export const isMagpieUrl = (url: string | undefined) => url?.trim().replace(/\/+$/, "") === MAGPIE_BASE_URL;

/** Local edits to the LLM settings, saved explicitly. Remembers the last model per endpoint. */
export function useLlmDraft() {
  const settings = useSettings();
  const update = useUpdateSettings();
  const saved = settings.data?.llm;
  const [draft, setDraftState] = useState<LlmSettings | undefined>(saved);

  // Take the stored value once it loads, and again after another window changes it.
  useEffect(() => {
    if (saved) setDraftState(saved);
  }, [saved]);

  const urlCheck = draft ? LlmBaseUrl.safeParse(draft.base_url.trim()) : undefined;
  const urlError = urlCheck && !urlCheck.success ? "Enter a full http:// or https:// URL" : undefined;
  const dirty =
    !!draft &&
    !!saved &&
    (draft.base_url.trim() !== saved.base_url ||
      draft.model.trim() !== saved.model ||
      draft.reasoning_effort !== saved.reasoning_effort);

  const setDraft = (patch: Partial<LlmSettings>) =>
    setDraftState((d) => {
      if (!d) return d;
      const next = { ...d, ...patch };
      if (patch.model !== undefined) remember(MODEL_MEMORY + next.base_url.trim(), patch.model.trim());
      return next;
    });

  /** Switches between magpie and a custom endpoint, restoring the model last used with it. */
  const setEndpoint = (kind: "magpie" | "custom") => {
    if (!draft) return;
    if (!isMagpieUrl(draft.base_url)) remember(CUSTOM_MEMORY, draft.base_url.trim());
    const base_url = kind === "magpie" ? MAGPIE_BASE_URL : remembered(CUSTOM_MEMORY) || (isMagpieUrl(saved?.base_url) ? "" : saved?.base_url ?? "");
    setDraftState({ ...draft, base_url, model: remembered(MODEL_MEMORY + base_url) || (base_url === saved?.base_url ? saved.model : "") });
  };

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
    setDraft,
    setEndpoint,
    reset: () => setDraftState(saved),
    urlError,
    dirty,
    saving: update.isPending,
    save,
  };
}

export type LlmDraft = ReturnType<typeof useLlmDraft>;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

type ModelsQuery = ReturnType<typeof useModels>;

/** magpie's live status: detecting, running with its model count, or not running. */
export function MagpieStatus({ models, onCustom, className }: { models: ModelsQuery; onCustom?: () => void; className?: string }) {
  const view = match(models)
    .returnType<{ tone: DotTone; title: string; detail: string }>()
    .with({ status: "success" }, ({ data }) => ({
      tone: "ok",
      title: "magpie is running",
      detail: `${plural(data.length, "model")} at 127.0.0.1:3425`,
    }))
    .with({ status: "error" }, () => ({
      tone: "off",
      title: "magpie is not running",
      detail: "Nothing answers at 127.0.0.1:3425. Start it, or use a custom endpoint.",
    }))
    .otherwise(() => ({ tone: "pending", title: "Looking for magpie…", detail: "Checking 127.0.0.1:3425" }));

  return (
    <div className={cn("flex items-center gap-3 rounded-lg border border-border px-3 py-2.5", className)} aria-live="polite">
      <StatusDot tone={view.tone} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-label font-medium">{view.title}</span>
        <span className="text-caption text-muted-foreground">{view.detail}</span>
      </div>
      {models.status === "error" ? (
        <div className="flex shrink-0 flex-col items-end gap-0.5">
          <Button variant="ghost" size="sm" onClick={() => void models.refetch()} disabled={models.isFetching}>
            <RefreshCw className={cn(models.isFetching && "animate-spin")} />
            Retry
          </Button>
          {onCustom ? (
            <Button variant="ghost" size="sm" onClick={onCustom}>
              Use custom
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The rewrite provider: magpie (detected live) or a custom OpenAI-compatible endpoint, a model
 * picker fed by `/models`, and a Test button. Used by onboarding and Settings.
 */
export function LlmProviderFields({
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
  const { draft, setDraft, setEndpoint, urlError } = llm;
  const magpie = isMagpieUrl(draft?.base_url);
  const customUrl = useDebounced(draft && !magpie && !urlError ? draft.base_url.trim() : undefined, 500);
  const magpieModels = useModels(MAGPIE_BASE_URL, { live: magpie, enabled: magpie });
  const customModels = useModels(customUrl, { enabled: !magpie });
  const test = useLlmTest();
  const testReset = test.reset;

  // A result belongs to the endpoint and model it was run with.
  useEffect(() => testReset(), [draft?.base_url, draft?.model, draft?.reasoning_effort, testReset]);

  if (!draft) return null;
  const models = magpie ? magpieModels : customModels;
  const runTest = () =>
    test.mutate({
      base_url: draft.base_url.trim(),
      model: draft.model.trim() || undefined,
      reasoning_effort: draft.reasoning_effort,
    });
  const blocked = match({ magpie, models: models.status, model: draft.model.trim(), urlError })
    .with({ magpie: true, models: "error" }, () => "Start magpie first")
    .with({ magpie: false, urlError: undefined, model: "" }, () => "Enter a model first")
    .with({ magpie: false }, ({ urlError }) => urlError)
    .with({ model: "" }, () => "Pick a model first")
    .otherwise(() => undefined);

  return (
    <div className={cn("flex flex-col gap-3.5", className)}>
      <div role="radiogroup" aria-label="LLM endpoint" className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-[3px]">
        {(
          [
            { kind: "magpie", on: magpie, label: "magpie on this Mac" },
            { kind: "custom", on: !magpie, label: "Custom endpoint" },
          ] as const
        ).map((o) => (
          <button
            key={o.kind}
            type="button"
            role="radio"
            aria-checked={o.on}
            onClick={() => !o.on && setEndpoint(o.kind)}
            className={cn(
              "h-7 rounded-md text-label font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              o.on ? "bg-background text-foreground shadow-sm dark:bg-input/60" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {o.label}
          </button>
        ))}
      </div>

      {magpie ? (
        <MagpieStatus models={magpieModels} onCustom={() => setEndpoint("custom")} />
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={urlId} className="text-label font-medium">
              Base URL
            </label>
            <Input
              id={urlId}
              value={draft.base_url}
              onChange={(e) => setDraft({ base_url: e.target.value })}
              placeholder="https://api.deepseek.com/v1"
              spellCheck={false}
              aria-invalid={!!urlError && draft.base_url.length > 0}
              className="font-mono placeholder:font-sans"
            />
            <p className="text-caption text-muted-foreground">Any OpenAI-compatible endpoint, up to /v1.</p>
          </div>
          <SecretField name="llm" label="API key" placeholder="Leave empty if it needs none" />
        </>
      )}

      <div className={cn("grid gap-3", showReasoning && "grid-cols-[minmax(0,1fr)_auto]")}>
        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor={modelId} className="text-label font-medium">
            Model
          </label>
          <ModelPicker
            id={modelId}
            models={models.data}
            value={draft.model}
            onChange={(model) => setDraft({ model })}
            disabled={magpie && models.status !== "success"}
          />
          {!magpie && customModels.status === "error" ? (
            <p className="text-caption text-muted-foreground">
              Couldn't list its models ({errorMessage(customModels.error)}). Type the model id.
            </p>
          ) : null}
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

      <ProviderTest state={test} onTest={runTest} describe={describeLlmTest} disabled={!!blocked} disabledReason={blocked} />
    </div>
  );
}
