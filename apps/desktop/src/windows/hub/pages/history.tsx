import { useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import type { RunRecord } from "@comma/shared/ipc";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@multica/ui/components/ui/alert-dialog";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@multica/ui/components/ui/sheet";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { CircleAlert, Copy, History, RotateCcw, Search, Trash2 } from "@multica/ui/icons";
import { cn } from "@multica/ui/lib/utils";
import { formatMs, formatSecs } from "../../../lib/format";
import { useDeleteRun, useRerun, useRun, useRuns } from "../../../lib/history-queries";
import { errorMessage, invoke } from "../../../lib/ipc";
import { detectedLanguageName } from "../../../lib/languages";
import { useSettings } from "../../../lib/queries";
import { EmptyState, Page } from "../page";
import { navigate, useRoute } from "../route";
import { dayKey, dayLabel, formatInt, formatTime, formatTokens, formatUsd, MODE_LABELS, ModeIcon, runText } from "./shared";

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    await invoke("clipboard_copy", { text });
  }
}

function RunRow({ run, active, onOpen }: { run: RunRecord; active: boolean; onOpen: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-current={active ? "true" : undefined}
        className={cn(
          "grid w-full grid-cols-[64px_28px_minmax(0,1fr)_auto] items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          active ? "bg-muted" : "hover:bg-muted/70",
        )}
      >
        <span className="text-caption whitespace-nowrap text-muted-foreground tabular-nums">{formatTime(run.ts)}</span>
        <ModeIcon mode={run.mode} className={cn(!run.ok && "bg-destructive/10 text-destructive")} />
        <span className="flex min-w-0 flex-col">
          <span className={cn("truncate text-body", !run.ok && "text-destructive")}>{runText(run)}</span>
          <span className="truncate text-caption text-muted-foreground">
            {MODE_LABELS[run.mode]}
            {run.app ? ` · ${run.app}` : ""}
          </span>
        </span>
        <span className="text-caption text-muted-foreground tabular-nums">{run.ok ? `${formatInt(run.words)} words` : "Failed"}</span>
      </button>
    </li>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-caption text-muted-foreground">{label}</dt>
      <dd className="truncate text-label">{children}</dd>
    </div>
  );
}

/** STT, then the LLM's first token and the rest of its answer, on one time axis. */
function Waterfall({ run }: { run: RunRecord }) {
  const stt = run.stt_ms ?? 0;
  const ttft = run.llm_ttft_ms ?? 0;
  const llm = run.llm_total_ms ?? 0;
  const rest = Math.max(0, llm - ttft);
  const total = Math.max(run.total_ms ?? 0, stt + llm, 1);
  const rows: { label: string; start: number; ms: number | null; tone: string }[] = [
    { label: "Speech to text", start: 0, ms: run.stt_ms, tone: "bg-brand" },
    { label: "LLM first token", start: stt, ms: run.llm_ttft_ms, tone: "bg-brand/60" },
    { label: "Rest of LLM", start: stt + ttft, ms: run.llm_total_ms != null ? rest : null, tone: "bg-brand/35" },
    { label: "Total", start: 0, ms: run.total_ms, tone: "bg-foreground/25" },
  ];
  return (
    <div className="flex flex-col gap-2" role="table" aria-label="Timing">
      {rows.map((r) => (
        <div key={r.label} role="row" className="grid grid-cols-[112px_minmax(0,1fr)_64px] items-center gap-3">
          <span role="cell" className="text-caption text-muted-foreground">
            {r.label}
          </span>
          <span role="cell" className="relative h-2.5 rounded-full bg-muted">
            {r.ms ? (
              <span
                className={cn("absolute inset-y-0 rounded-full", r.tone)}
                style={{ left: `${(r.start / total) * 100}%`, width: `max(${(r.ms / total) * 100}%, 4px)` }}
              />
            ) : null}
          </span>
          <span role="cell" className="text-right text-caption tabular-nums">
            {r.ms != null ? formatMs(r.ms) : "–"}
          </span>
        </div>
      ))}
    </div>
  );
}

function TextBlock({ label, text, muted }: { label: string; text: string; muted?: boolean }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-caption font-medium text-muted-foreground">{label}</h3>
      <p className={cn("selectable rounded-lg border border-border bg-background px-3 py-2.5 text-body whitespace-pre-wrap", muted && "text-muted-foreground")}>
        {text || <span className="text-muted-foreground">Nothing</span>}
      </p>
    </section>
  );
}

function RunDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { data: run, error, isPending } = useRun(id);
  const mode = useSettings().data?.mode;
  const rerun = useRerun();
  const remove = useDeleteRun();
  const [confirm, setConfirm] = useState(false);

  if (isPending) {
    return (
      <div className="flex flex-col gap-3 p-5">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>
    );
  }
  if (error || !run) {
    return (
      <div className="p-5">
        <EmptyState icon={History} title="This run is gone" description={error ? errorMessage(error) : "It may have been deleted."} />
      </div>
    );
  }

  const tokens = run.prompt_tokens != null || run.completion_tokens != null;
  const rerunBlocked = mode === "account" ? "Rerunning the rewrite needs your own keys (Local mode)" : !run.raw_text ? "There is no transcript to rewrite" : undefined;

  return (
    <>
      <SheetHeader className="border-b border-border px-5 pt-5 pb-4">
        <div className="flex items-center gap-2.5 pr-8">
          <ModeIcon mode={run.mode} />
          <div className="flex min-w-0 flex-col">
            <SheetTitle className="text-title-sm">{MODE_LABELS[run.mode]}</SheetTitle>
            <SheetDescription className="truncate">
              {dayLabel(run.ts)}, {formatTime(run.ts)}
              {run.app ? ` · ${run.app}` : ""}
            </SheetDescription>
          </div>
        </div>
      </SheetHeader>
      <div className="scrollbar-slim flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 pt-4 pb-5">
        {!run.ok ? (
          <p className="flex items-start gap-1.5 rounded-lg bg-destructive/8 px-3 py-2.5 text-label text-destructive">
            <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span className="selectable">{run.error ?? "The run failed"}</span>
          </p>
        ) : null}
        <TextBlock label={run.mode === "ask" ? "Answer" : "Refined"} text={run.refined_text} />
        <TextBlock label={run.mode === "ask" ? "What you asked" : "What you said"} text={run.raw_text} muted />

        <section className="flex flex-col gap-2.5">
          <h3 className="text-caption font-medium text-muted-foreground">Timing</h3>
          <Waterfall run={run} />
        </section>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border border-border px-3.5 py-3">
          <Field label="Provider">{run.provider === "comma" ? "Comma credits" : "Your keys"}</Field>
          <Field label="Model">
            <span className="font-mono text-caption">{run.model ?? "–"}</span>
          </Field>
          <Field label="Audio">{formatSecs(run.audio_secs)}</Field>
          <Field label="Language">{run.language ? detectedLanguageName(run.language) : "–"}</Field>
          <Field label="Tokens">
            {tokens ? `${formatTokens(run.prompt_tokens ?? 0)} in, ${formatTokens(run.completion_tokens ?? 0)} out` : "–"}
          </Field>
          <Field label="Speech to text cost">{run.stt_cost_usd != null ? formatUsd(run.stt_cost_usd) : "–"}</Field>
          <Field label="Words">{formatInt(run.words)}</Field>
          <Field label="Output">
            {run.output === "pasted" ? "Pasted" : run.output === "copied" ? "Copied" : run.output === "answer" ? "Answer card" : "–"}
          </Field>
        </dl>
      </div>
      <div className="flex items-center gap-2 border-t border-border px-5 py-3">
        <Button
          size="sm"
          variant="outline"
          disabled={!run.refined_text}
          onClick={() => void copyText(run.refined_text).then(() => toast.success("Copied"), (e: unknown) => toast.error(errorMessage(e)))}
        >
          <Copy />
          Copy
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!!rerunBlocked || rerun.isPending}
          title={rerunBlocked}
          onClick={() => rerun.mutate(run.id, { onSuccess: () => toast.success("Rewritten again"), onError: (e) => toast.error(errorMessage(e)) })}
        >
          {rerun.isPending ? <Spinner className="size-3.5" /> : <RotateCcw />}
          Rerun rewrite
        </Button>
        <Button size="sm" variant="ghost" className="ml-auto text-destructive hover:text-destructive" onClick={() => setConfirm(true)}>
          <Trash2 />
          Delete
        </Button>
      </div>
      {rerunBlocked && mode === "account" ? (
        <p className="-mt-1 px-5 pb-3 text-caption text-muted-foreground">{rerunBlocked}.</p>
      ) : null}
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this run?</AlertDialogTitle>
            <AlertDialogDescription>Its text and timings are removed from this Mac. Usage totals drop it too.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() =>
                remove.mutate(run.id, {
                  onSuccess: () => {
                    toast.success("Run deleted");
                    onClose();
                  },
                  onError: (e) => toast.error(errorMessage(e)),
                })
              }
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function HistoryPage() {
  const { section: openId } = useRoute();
  const [query, setQuery] = useState("");
  const search = useDebounced(query.trim(), 250);
  const runs = useRuns(search);
  const list = useMemo(() => runs.data?.pages.flat() ?? [], [runs.data]);

  const groups = useMemo(() => {
    const out: { key: string; label: string; runs: RunRecord[] }[] = [];
    for (const run of list) {
      const key = dayKey(run.ts);
      const last = out[out.length - 1];
      if (last?.key === key) last.runs.push(run);
      else out.push({ key, label: dayLabel(run.ts), runs: [run] });
    }
    return out;
  }, [list]);

  const close = () => navigate("history");

  return (
    <Page
      title="History"
      actions={
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search runs" className="h-7 w-56 pl-8" aria-label="Search runs" />
        </div>
      }
    >
      {runs.isPending ? (
        <div className="mx-auto flex max-w-3xl flex-col gap-2 px-6 py-6">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-11" />
          ))}
        </div>
      ) : list.length === 0 ? (
        search ? (
          <EmptyState icon={Search} title="No runs match" description={`Nothing in your history mentions “${search}”.`} className="h-full" />
        ) : (
          <EmptyState
            icon={History}
            title="No runs yet"
            description="Every dictation lands here, grouped by day, with the raw transcript, the cleaned-up text and how long each step took."
            className="h-full"
          />
        )
      ) : (
        <div className="mx-auto flex max-w-3xl flex-col gap-5 px-6 py-5">
          {groups.map((g) => (
            <section key={g.key} className="flex flex-col gap-1">
              <h2 className="sticky top-0 z-10 bg-background/95 px-3 py-1.5 text-caption font-medium text-muted-foreground backdrop-blur-sm">
                {g.label}
                <span className="ml-1.5 text-faint-foreground">{g.runs.length}</span>
              </h2>
              <ul className="flex flex-col">
                {g.runs.map((run) => (
                  <RunRow key={run.id} run={run} active={run.id === openId} onOpen={() => navigate("history", run.id)} />
                ))}
              </ul>
            </section>
          ))}
          {runs.hasNextPage ? (
            <Button variant="ghost" className="self-center" onClick={() => void runs.fetchNextPage()} disabled={runs.isFetchingNextPage}>
              {runs.isFetchingNextPage ? <Spinner className="size-3.5" /> : null}
              Show older runs
            </Button>
          ) : null}
        </div>
      )}

      <Sheet open={!!openId} onOpenChange={(open) => !open && close()}>
        <SheetContent side="right" className="w-[440px] gap-0 p-0 sm:max-w-[440px]">
          {openId ? <RunDetail key={openId} id={openId} onClose={close} /> : null}
        </SheetContent>
      </Sheet>
    </Page>
  );
}
