import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "@multica/ui/components/ui/button";
import { Command, CommandGroup, CommandItem, CommandList } from "@multica/ui/components/ui/command";
import { Input } from "@multica/ui/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@multica/ui/components/ui/popover";
import { ChevronsUpDown, Pencil } from "@multica/ui/icons";
import { cn } from "@multica/ui/lib/utils";
import { errorMessage } from "../lib/ipc";
import { DEFAULT_STT_MODEL, formatUsdPerHour, STT_MODELS, sttModel, type SttModel } from "../lib/models";
import { useSettings, useUpdateSettings } from "../lib/queries";
import { ModelTagBadge } from "./model-picker";

const OTHER = "__other__";

function SttOption({ model }: { model: SttModel }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5 py-0.5">
      <span className="flex items-center gap-1.5">
        <span className="text-label font-medium">{model.name}</span>
        <span className="font-mono text-caption text-muted-foreground">{model.id}</span>
        {model.recommended ? <ModelTagBadge tag="recommended" /> : null}
        <span className="ml-auto pl-2 text-caption text-muted-foreground tabular-nums">{formatUsdPerHour(model.usdPerHour)}</span>
      </span>
      <span className="text-caption text-muted-foreground">
        {model.description}
        {model.id === DEFAULT_STT_MODEL ? " Default." : ""}
      </span>
    </span>
  );
}

/**
 * The ElevenLabs model: a curated list with descriptions and prices, or any other model id.
 * Saves to `stt.model_id` as soon as one is picked. Used by Settings and onboarding.
 */
export function SttModelPicker({ className, defaultOpen = false }: { className?: string; defaultOpen?: boolean }) {
  const saved = useSettings().data?.stt.model_id ?? DEFAULT_STT_MODEL;
  const update = useUpdateSettings();
  const [open, setOpen] = useState(defaultOpen);
  const [custom, setCustom] = useState<string | null>(null);
  const labelId = useId();
  const current = sttModel(saved);

  useEffect(() => setCustom(null), [saved]);

  const save = (model_id: string) =>
    update.mutate(
      { stt: { model_id } },
      { onSuccess: () => toast.success("Speech to text model saved"), onError: (e) => toast.error(errorMessage(e)) },
    );

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <span id={labelId} className="text-label font-medium">
        Model
      </span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              variant="outline"
              role="combobox"
              aria-expanded={open}
              aria-labelledby={labelId}
              className="h-auto min-h-8 w-full justify-between py-1.5 font-normal"
            />
          }
        >
          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
            {current ? (
              <>
                <span className="text-label font-medium">{current.name}</span>
                <span className="truncate text-caption text-muted-foreground">
                  {current.description} {formatUsdPerHour(current.usdPerHour)}
                </span>
              </>
            ) : (
              <>
                <span className="truncate font-mono text-label">{saved}</span>
                <span className="text-caption text-muted-foreground">Custom model id</span>
              </>
            )}
          </span>
          <ChevronsUpDown className="text-muted-foreground" />
        </PopoverTrigger>
        <PopoverContent align="start" className="w-(--anchor-width) min-w-96 p-0">
          <Command>
            <CommandList>
              <CommandGroup heading="ElevenLabs Scribe">
                {STT_MODELS.map((m) => (
                  <CommandItem
                    key={m.id}
                    value={m.id}
                    data-checked={m.id === saved ? true : undefined}
                    // cmdk marks every other item data-selected="false"; the vendored styles match on presence.
                    className="data-[selected=false]:bg-transparent"
                    onSelect={() => {
                      setOpen(false);
                      if (m.id !== saved) save(m.id);
                    }}
                  >
                    <SttOption model={m} />
                  </CommandItem>
                ))}
              </CommandGroup>
              <CommandGroup>
                <CommandItem
                  value={OTHER}
                  data-checked={!current ? true : undefined}
                  className="data-[selected=false]:bg-transparent"
                  onSelect={() => {
                    setOpen(false);
                    setCustom(current ? "" : saved);
                  }}
                >
                  <Pencil className="text-muted-foreground" />
                  <span className="flex flex-col">
                    <span className="text-label font-medium">Other model id</span>
                    <span className="text-caption text-muted-foreground">Any model ElevenLabs offers for speech to text.</span>
                  </span>
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {custom !== null ? (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const id = custom.trim();
            if (id && id !== saved) save(id);
          }}
        >
          <Input
            autoFocus
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            placeholder="Model id"
            spellCheck={false}
            className="font-mono placeholder:font-sans"
            aria-label="Model id"
          />
          <Button type="submit" variant="outline" disabled={!custom.trim() || custom.trim() === saved || update.isPending}>
            Save
          </Button>
          <Button type="button" variant="ghost" onClick={() => setCustom(null)}>
            Cancel
          </Button>
        </form>
      ) : null}
      <p className="text-caption text-muted-foreground">Prices are ElevenLabs list prices. Dictionary terms add 20%.</p>
    </div>
  );
}
