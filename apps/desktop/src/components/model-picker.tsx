import { useState } from "react";
import { Button } from "@multica/ui/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@multica/ui/components/ui/command";
import { Input } from "@multica/ui/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@multica/ui/components/ui/popover";
import { ChevronsUpDown } from "@multica/ui/icons";
import { cn } from "@multica/ui/lib/utils";

/**
 * A searchable list of the endpoint's models. Without a list (the endpoint has no `/models`, or it
 * failed) the model id is typed instead.
 */
export function ModelPicker({
  id,
  models,
  value,
  onChange,
  disabled,
  className,
}: {
  id?: string;
  models: string[] | undefined;
  value: string;
  onChange: (model: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  if (!models || models.length === 0) {
    return (
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Model id, e.g. deepseek-chat"
        spellCheck={false}
        disabled={disabled}
        className={cn("font-mono placeholder:font-sans", className)}
      />
    );
  }

  const known = models.includes(value);
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
            className={cn("w-full justify-between font-normal", className)}
          />
        }
      >
        <span className={cn("truncate font-mono text-label", !value && "font-sans text-muted-foreground")}>
          {value || `Pick one of ${models.length} models`}
        </span>
        <ChevronsUpDown className="text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-(--anchor-width) min-w-72 p-0">
        <Command>
          <CommandInput placeholder="Search models" />
          <CommandList className="scrollbar-slim max-h-64">
            <CommandEmpty>No model matches</CommandEmpty>
            <CommandGroup>
              {value && !known ? (
                <CommandItem value={value} data-checked onSelect={() => setOpen(false)} className="font-mono text-label">
                  {value}
                  <span className="ml-1 font-sans text-caption text-muted-foreground">not listed</span>
                </CommandItem>
              ) : null}
              {models.map((m) => (
                <CommandItem
                  key={m}
                  value={m}
                  data-checked={m === value ? true : undefined}
                  onSelect={() => {
                    onChange(m);
                    setOpen(false);
                  }}
                  className="font-mono text-label"
                >
                  {m}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
