import { useRef, useState } from "react";
import { toast } from "sonner";
import type { DictionaryEntry } from "@comma/shared/ipc";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { BookOpenText, Check, Cloud, Laptop, Pencil, Plus, Trash2, Upload, X } from "@multica/ui/icons";
import { cn } from "@multica/ui/lib/utils";
import { plural } from "../../../lib/format";
import { useAddTerm, useDeleteTerm, useDictionary, useImportTerms, useUpdateTerm } from "../../../lib/history-queries";
import { errorMessage } from "../../../lib/ipc";
import { useSettings } from "../../../lib/queries";
import { EmptyState, Page } from "../page";

/** ElevenLabs keyterm limits (spec 2.5); longer terms still reach the rewrite prompt. */
function isKeyterm(term: string): boolean {
  return term.length <= 50 && term.trim().split(/\s+/).length <= 5;
}

function TermRow({ entry }: { entry: DictionaryEntry }) {
  const [editing, setEditing] = useState<string | null>(null);
  const update = useUpdateTerm();
  const remove = useDeleteTerm();
  const keyterm = isKeyterm(entry.term);

  if (editing !== null) {
    const save = () => {
      const term = editing.trim();
      if (!term || term === entry.term) return setEditing(null);
      update.mutate({ id: entry.id, term }, { onSuccess: () => setEditing(null), onError: (e) => toast.error(errorMessage(e)) });
    };
    return (
      <li className="flex items-center gap-2 px-3 py-1.5">
        <form
          className="flex flex-1 items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <Input
            autoFocus
            value={editing}
            maxLength={100}
            onChange={(e) => setEditing(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setEditing(null)}
            aria-label="Term"
            className="h-7"
          />
          <Button type="submit" size="icon-sm" variant="ghost" aria-label="Save" disabled={update.isPending}>
            <Check />
          </Button>
          <Button type="button" size="icon-sm" variant="ghost" aria-label="Cancel" onClick={() => setEditing(null)}>
            <X />
          </Button>
        </form>
      </li>
    );
  }

  return (
    <li className="group flex items-center gap-3 px-3 py-2">
      <span className="min-w-0 flex-1 truncate text-body">{entry.term}</span>
      {!keyterm ? (
        <span className="shrink-0 text-caption text-muted-foreground" title="Over 50 characters or 5 words: used by the rewrite, not by speech to text">
          Rewrite only
        </span>
      ) : null}
      <span className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
        <Button size="icon-sm" variant="ghost" aria-label={`Edit ${entry.term}`} onClick={() => setEditing(entry.term)}>
          <Pencil />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`Delete ${entry.term}`}
          className="hover:text-destructive"
          disabled={remove.isPending}
          onClick={() => remove.mutate(entry.id, { onError: (e) => toast.error(errorMessage(e)) })}
        >
          <Trash2 />
        </Button>
      </span>
    </li>
  );
}

export function DictionaryPage() {
  const account = useSettings().data?.mode === "account";
  const { data: terms, isPending, error } = useDictionary();
  const add = useAddTerm();
  const importTerms = useImportTerms();
  const [draft, setDraft] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const input = useRef<HTMLInputElement>(null);

  const submit = () => {
    const term = draft.trim().replace(/\s+/g, " ");
    if (!term) return;
    add.mutate(term, {
      onSuccess: () => setDraft(""),
      onError: (e) => toast.error(errorMessage(e)),
    });
  };

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    try {
      const csv = await f.text();
      const { added, skipped } = await importTerms.mutateAsync(csv);
      toast.success(`${plural(added, "term")} added`, { description: skipped ? `${plural(skipped, "row")} skipped (duplicates or invalid)` : undefined });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      if (file.current) file.current.value = "";
    }
  };

  const Where = account ? Cloud : Laptop;

  return (
    <Page
      title="Dictionary"
      actions={
        <>
          <input ref={file} type="file" accept=".csv,text/csv,text/plain" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
          <Button variant="ghost" size="sm" onClick={() => file.current?.click()} disabled={importTerms.isPending}>
            <Upload />
            Import CSV
          </Button>
          <Button size="sm" onClick={() => input.current?.focus()}>
            <Plus />
            Add term
          </Button>
        </>
      }
    >
      <div className="mx-auto flex max-w-2xl flex-col gap-4 px-8 py-7">
        <div className="flex flex-col gap-1.5">
          <p className="text-body text-muted-foreground">
            Names, product terms and jargon. Comma sends them to ElevenLabs as keyterms and to the rewrite, so they come out
            spelled right. Keyterms add 20% to the speech-to-text price; a term counts as one when it has at most 50
            characters and 5 words, and longer ones still reach the rewrite.
          </p>
          <p className="flex items-center gap-1.5 text-label text-muted-foreground">
            <Where className="size-3.5" />
            {account ? "In your Comma account, on every Mac you sign in on." : "On this Mac."}
            {terms ? <span className="text-faint-foreground">· {plural(terms.length, "term")}</span> : null}
          </p>
        </div>

        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Input
            ref={input}
            value={draft}
            maxLength={100}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add a name or term, e.g. Kubernetes"
            aria-label="New term"
          />
          <Button type="submit" variant="outline" disabled={!draft.trim() || add.isPending}>
            Add
          </Button>
        </form>

        {isPending ? (
          <div className="flex flex-col gap-1.5">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-9" />
            ))}
          </div>
        ) : error ? (
          <p className="text-label text-destructive">{errorMessage(error)}</p>
        ) : terms && terms.length > 0 ? (
          <ul className={cn("flex flex-col divide-y divide-border overflow-hidden rounded-card border border-surface-border bg-surface")}>
            {terms.map((t) => (
              <TermRow key={t.id} entry={t} />
            ))}
          </ul>
        ) : (
          <EmptyState
            icon={BookOpenText}
            title="Your dictionary is empty"
            description="Add the names and words speech to text tends to get wrong. You can also import a CSV with one term per row."
          />
        )}
      </div>
    </Page>
  );
}
