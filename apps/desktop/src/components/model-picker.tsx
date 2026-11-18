import { useState, useSyncExternalStore } from "react";
import { Button } from "@multica/ui/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@multica/ui/components/ui/command";
import { Input } from "@multica/ui/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@multica/ui/components/ui/popover";
import { ChevronsUpDown } from "@multica/ui/icons";
import { cn } from "@multica/ui/lib/utils";
import { formatMs } from "../lib/format";
import { groupModels, LATENCY_STORAGE_KEY, latencyFor, modelInfo, TAG_LABELS, type ModelTag } from "../lib/models";

/** Re-renders when a Test in any window records a new latency. */
function useLatencyVersion(): number {
  return useSyncExternalStore(
    (onChange) => {
      const handler = (e: StorageEvent) => {
        if (e.key === null || e.key === LATENCY_STORAGE_KEY) onChange();
      };
      window.addEventListener("storage", handler);
      return () => window.removeEventListener("storage", handler);
    },
    () => localStorage.getItem(LATENCY_STORAGE_KEY)?.length ?? 0,
  );
}

export function ModelTagBadge({ tag }: { tag: ModelTag }) {
  return (
    <span
      className={cn(
        "inline-flex h-[18px] items-center rounded-[5px] px-1.5 font-sans text-micro font-medium whitespace-nowrap",
        tag === "recommended" ? "bg-brand/12 text-brand" : "bg-muted text-muted-foreground",
      )}
    >
      {TAG_LABELS[tag]}
    </span>
  );
}

/** Id, curated description and tags, and the last measured first token. */
function ModelRow({ id, baseUrl }: { id: string; baseUrl?: string }) {
  const info = modelInfo(id);
  const latency = baseUrl ? latencyFor(baseUrl, id) : undefined;
  const bare = id.slice(id.indexOf("/") + 1);
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5 py-0.5">
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="truncate font-mono text-label">{bare}</span>
        {info?.tags.map((t) => <ModelTagBadge key={t} tag={t} />)}
        {latency ? (
          <span className="ml-auto shrink-0 pl-2 font-sans text-caption text-muted-foreground tabular-nums" title="First token, last Test">
            {formatMs(latency.ttft_ms)}
          </span>
        ) : null}
      </span>
      {info ? <span className="truncate font-sans text-caption text-muted-foreground">{info.description}</span> : null}
    </span>
  );
}

/**
 * A searchable list of the endpoint's models, grouped by provider prefix, with curated
 * descriptions and tags. Without a list (the endpoint has no `/models`, or it failed) the model
 * id is typed instead.
 */
export function ModelPicker({
  id,
  models,
  value,
  onChange,
  baseUrl,
  disabled,
  className,
  defaultOpen = false,
}: {
  id?: string;
  models: string[] | undefined;
  value: string;
  onChange: (model: string) => void;
  /** For the remembered latencies. */
  baseUrl?: string;
  disabled?: boolean;
  className?: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  useLatencyVersion();

  if (!models || models.length === 0) {
    return (
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Model id, e.g. deepseek-v4-flash"
        spellCheck={false}
        disabled={disabled}
        className={cn("font-mono placeholder:font-sans", className)}
      />
    );
  }

  const known = models.includes(value);
  const info = value ? modelInfo(value) : undefined;
  const latency = value && baseUrl ? latencyFor(baseUrl, value) : undefined;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            id={id}
            variant="outline"
            role="combobox"
            aria-expanded={open}
            disabled={disabled}
            className={cn("h-auto min-h-8 w-full justify-between py-1 font-normal", className)}
          />
        }
      >
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          <span className={cn("truncate font-mono text-label", !value && "font-sans text-muted-foreground")}>
            {value || `Pick one of ${models.length} models`}
          </span>
          {info?.tags.includes("recommended") ? <ModelTagBadge tag="recommended" /> : null}
          {latency ? <span className="shrink-0 text-caption text-muted-foreground tabular-nums">{formatMs(latency.ttft_ms)}</span> : null}
        </span>
        <ChevronsUpDown className="text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-(--anchor-width) min-w-96 p-0">
        <Command>
          <CommandInput placeholder="Search models" />
          <CommandList className="scrollbar-slim max-h-80">
            <CommandEmpty>No model matches</CommandEmpty>
            {value && !known ? (
              <CommandGroup heading="Current">
                <CommandItem value={value} data-checked onSelect={() => setOpen(false)} className="data-[selected=false]:bg-transparent">
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-mono text-label">{value}</span>
                    <span className="text-caption text-muted-foreground">Not listed by this endpoint</span>
                  </span>
                </CommandItem>
              </CommandGroup>
            ) : null}
            {groupModels(models).map((group) => (
              <CommandGroup key={group.provider} heading={group.provider}>
                {group.models.map((m) => {
                  const mi = modelInfo(m);
                  return (
                    <CommandItem
                      key={m}
                      value={m}
                      keywords={mi ? [mi.description, ...mi.tags.map((t) => TAG_LABELS[t])] : undefined}
                      data-checked={m === value ? true : undefined}
                      // cmdk marks every other item data-selected="false"; the vendored styles match on presence.
                      className="data-[selected=false]:bg-transparent"
                      onSelect={() => {
                        onChange(m);
                        setOpen(false);
                      }}
                    >
                      <ModelRow id={m} baseUrl={baseUrl} />
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
