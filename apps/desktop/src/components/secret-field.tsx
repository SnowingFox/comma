import { useId, useState, type ReactNode } from "react";
import { toast } from "sonner";
import type { SecretName } from "@comma/shared/ipc";
import { Badge } from "@multica/ui/components/ui/badge";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { CheckIcon } from "@multica/ui/icons";
import { cn } from "@multica/ui/lib/utils";
import { useSecretStatus, useSetSecret } from "../lib/queries";

/**
 * A write-only key field. The value goes to the Keychain and is never read back:
 * the UI only knows whether a key is set.
 */
export function SecretField({
  name,
  label,
  description,
  placeholder = "Paste your key",
  className,
}: {
  name: SecretName;
  label: string;
  description?: ReactNode;
  placeholder?: string;
  className?: string;
}) {
  const id = useId();
  const [value, setValue] = useState("");
  const status = useSecretStatus();
  const setSecret = useSetSecret();
  const isSet = status.data?.[name] ?? false;

  const save = (next: string) =>
    setSecret.mutate(
      { name, value: next },
      {
        onSuccess: () => {
          setValue("");
          toast.success(next ? `${label} saved to your Keychain` : `${label} removed`);
        },
        onError: (err) => toast.error(err.message),
      },
    );

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-label font-medium">
          {label}
        </label>
        {status.isPending ? null : isSet ? (
          <Badge variant="secondary" className="gap-1 text-success">
            <CheckIcon />
            Set
          </Badge>
        ) : (
          <Badge variant="outline" className="text-muted-foreground">
            Not set
          </Badge>
        )}
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) save(value);
        }}
      >
        <Input
          id={id}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={isSet ? "Paste a new key to replace it" : placeholder}
          className="font-mono placeholder:font-sans"
        />
        <Button type="submit" variant="outline" disabled={!value.trim() || setSecret.isPending}>
          Save
        </Button>
        {isSet ? (
          <Button type="button" variant="ghost" disabled={setSecret.isPending} onClick={() => save("")}>
            Remove
          </Button>
        ) : null}
      </form>
      {description ? <p className="text-caption text-muted-foreground">{description}</p> : null}
    </div>
  );
}
