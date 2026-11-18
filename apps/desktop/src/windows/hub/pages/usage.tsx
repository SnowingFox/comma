import { useState } from "react";
import { toast } from "sonner";
import { RunMode, UsageRange, type UsageBreakdown } from "@comma/shared/ipc";
import { Button } from "@multica/ui/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@multica/ui/components/ui/card";
import { Progress } from "@multica/ui/components/ui/progress";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@multica/ui/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@multica/ui/components/ui/tabs";
import { BarChart3, Download } from "@multica/ui/icons";
import { formatMs } from "../../../lib/format";
import { useCredits, useUsageDaily, useUsageSummary } from "../../../lib/history-queries";
import { errorMessage, inTauri, invoke } from "../../../lib/ipc";
import { useSettings } from "../../../lib/queries";
import { EmptyState, Page } from "../page";
import { formatInt, formatTokens, formatUsd, MODE_LABELS, StatTile } from "./shared";
import { DailyChart, type Metric } from "./usage-chart";

const RANGE_LABELS: Record<UsageRange, string> = { today: "Today", "7d": "7 days", "30d": "30 days", "90d": "90 days" };

const METRICS: Metric[] = [
  { id: "runs", label: "Runs", value: (d) => d.runs, format: (n) => formatInt(Math.round(n)) },
  { id: "words", label: "Words", value: (d) => d.words, format: (n) => formatTokens(Math.round(n)) },
  { id: "audio", label: "Audio minutes", value: (d) => d.audio_secs / 60, format: (n) => (n < 10 ? n.toFixed(1).replace(/\.0$/, "") : String(Math.round(n))) },
  { id: "cost", label: "STT cost", value: (d) => d.stt_cost_usd, format: (n) => (n === 0 ? "$0" : `$${n < 0.1 ? n.toFixed(3) : n.toFixed(2)}`) },
  { id: "tokens", label: "Tokens", value: (d) => d.prompt_tokens + d.completion_tokens, format: (n) => formatTokens(Math.round(n)) },
];

const minutes = (secs: number) => (secs / 60 < 10 ? (secs / 60).toFixed(1) : String(Math.round(secs / 60)));

async function reveal(path: string) {
  try {
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    await revealItemInDir(path);
  } catch (err) {
    toast.error(errorMessage(err));
  }
}

function Breakdown({ title, rows, label }: { title: string; rows: UsageBreakdown; label: (key: string) => string }) {
  const max = Math.max(...rows.map((r) => r.runs), 1);
  return (
    <Card size="sm" className="gap-2">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="px-1">
        {rows.length === 0 ? (
          <p className="px-2 py-3 text-label text-muted-foreground">No runs in this range.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-7 text-caption">{title.replace("By ", "").replace(/^\w/, (c) => c.toUpperCase())}</TableHead>
                <TableHead className="h-7 w-[72px] text-right text-caption">Runs</TableHead>
                <TableHead className="h-7 w-[72px] text-right text-caption">Audio min</TableHead>
                <TableHead className="h-7 w-[72px] text-right text-caption">Tokens</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.slice(0, 6).map((r) => (
                <TableRow key={r.key}>
                  <TableCell className="max-w-0 py-1.5">
                    <div className="flex flex-col gap-1">
                      <span className="truncate text-label" title={r.key}>
                        {label(r.key)}
                      </span>
                      <span className="h-1 rounded-full bg-muted">
                        <span className="block h-full rounded-full bg-[oklch(0.55_0.16_255)] dark:bg-[oklch(0.63_0.16_255)]" style={{ width: `${(r.runs / max) * 100}%` }} />
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="py-1.5 text-right text-label tabular-nums">{formatInt(r.runs)}</TableCell>
                  <TableCell className="py-1.5 text-right text-label tabular-nums">{minutes(r.audio_secs)}</TableCell>
                  <TableCell className="py-1.5 text-right text-label tabular-nums">{formatTokens(r.prompt_tokens + r.completion_tokens)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function CreditsCard() {
  const credits = useCredits(true);
  if (credits.isPending) return <Skeleton className="h-[92px] rounded-card" />;
  if (credits.error || !credits.data) {
    return (
      <Card size="sm" className="px-4 py-3.5">
        <span className="text-label text-muted-foreground">Comma credits</span>
        <span className="text-label">{credits.error ? errorMessage(credits.error) : "Not available"}</span>
      </Card>
    );
  }
  const { used_seconds, limit_seconds, period_end, plan } = credits.data;
  const used = Math.min(100, limit_seconds ? (used_seconds / limit_seconds) * 100 : 0);
  const resets = new Date(period_end).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  return (
    <Card size="sm" className="gap-2.5 px-4 py-3.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-label text-muted-foreground">Comma credits this week</span>
        <span className="text-caption text-muted-foreground capitalize">{plan} plan</span>
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className="text-title font-semibold tabular-nums">{minutes(used_seconds)}</span>
        <span className="text-label text-muted-foreground">of {minutes(limit_seconds)} audio minutes used</span>
      </div>
      <Progress value={used} aria-label="Credits used" />
      <span className="text-caption text-muted-foreground">Resets {resets}.</span>
    </Card>
  );
}

export function UsagePage() {
  const [range, setRange] = useState<UsageRange>("30d");
  const [metricId, setMetricId] = useState("runs");
  const account = useSettings().data?.mode === "account";
  const summary = useUsageSummary(range);
  const daily = useUsageDaily(range);
  const metric = METRICS.find((m) => m.id === metricId) ?? METRICS[0]!;
  const [exporting, setExporting] = useState(false);

  const exportCsv = async () => {
    setExporting(true);
    try {
      const { path } = await invoke("usage_export_csv", { range });
      toast.success("Usage exported", {
        description: path.replace(/^\/Users\/[^/]+/, "~"),
        action: inTauri ? { label: "Show", onClick: () => void reveal(path) } : undefined,
      });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setExporting(false);
    }
  };

  const t = summary.data?.totals;
  const empty = t && t.runs === 0 && t.errors === 0;

  return (
    <Page
      title="Usage"
      actions={
        <>
          <Tabs value={range} onValueChange={(v) => setRange(UsageRange.catch("30d").parse(v))}>
            <TabsList className="h-7">
              {UsageRange.options.map((r) => (
                <TabsTrigger key={r} value={r} className="px-2 text-caption">
                  {RANGE_LABELS[r]}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <Button variant="ghost" size="sm" onClick={() => void exportCsv()} disabled={exporting}>
            <Download />
            Export CSV
          </Button>
        </>
      }
    >
      <div className="mx-auto flex max-w-4xl flex-col gap-4 px-8 py-7">
        {account ? <CreditsCard /> : null}

        {!t ? (
          <div className="grid grid-cols-4 gap-3">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-[98px] rounded-card" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-4 gap-3">
            <StatTile label="Runs" value={formatInt(t.runs)} hint={t.errors ? `${formatInt(t.errors)} failed` : "None failed"} />
            <StatTile label="Audio minutes" value={minutes(t.audio_secs)} hint={`${formatInt(t.words)} words`} />
            <StatTile label="Speech to text cost" value={formatUsd(t.stt_cost_usd)} hint="ElevenLabs list price" />
            <StatTile
              label="Tokens"
              value={formatTokens(t.prompt_tokens + t.completion_tokens)}
              hint={`${formatTokens(t.prompt_tokens)} in, ${formatTokens(t.completion_tokens)} out`}
            />
          </div>
        )}

        {empty ? (
          <EmptyState
            icon={BarChart3}
            title="No usage in this range"
            description="Runs, audio minutes, speech-to-text cost and tokens per day appear here after you dictate."
          />
        ) : (
          <>
            {range !== "today" ? (
              <Card>
                <CardHeader>
                  <CardTitle>{metric.label} per day</CardTitle>
                  <CardDescription>Local days on this Mac.</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                  <Tabs value={metricId} onValueChange={(v) => setMetricId(String(v))}>
                    <TabsList className="h-7">
                      {METRICS.map((m) => (
                        <TabsTrigger key={m.id} value={m.id} className="px-2 text-caption">
                          {m.label}
                        </TabsTrigger>
                      ))}
                    </TabsList>
                  </Tabs>
                  {daily.data ? <DailyChart days={daily.data} metric={metric} /> : <Skeleton className="h-[200px]" />}
                </CardContent>
              </Card>
            ) : null}

            {summary.data ? (
              <>
                <div className="grid grid-cols-2 items-start gap-3">
                  <Breakdown title="By mode" rows={summary.data.by_mode} label={(k) => MODE_LABELS[RunMode.catch("dictate").parse(k)]} />
                  <Breakdown title="By model" rows={summary.data.by_model} label={(k) => k.slice(k.indexOf("/") + 1)} />
                  <Breakdown title="By app" rows={summary.data.by_app} label={(k) => k} />
                  <Card size="sm" className="gap-2">
                    <CardHeader>
                      <CardTitle>Speed per stage</CardTitle>
                      <CardDescription>Half the runs beat p50; 95 in 100 beat p95.</CardDescription>
                    </CardHeader>
                    <CardContent className="px-1">
                      <Table>
                        <TableHeader>
                          <TableRow className="hover:bg-transparent">
                            <TableHead className="h-7 text-caption">Stage</TableHead>
                            <TableHead className="h-7 text-right text-caption">p50</TableHead>
                            <TableHead className="h-7 text-right text-caption">p95</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {(
                            [
                              ["Speech to text", summary.data.stages.stt],
                              ["LLM first token", summary.data.stages.llm_ttft],
                              ["LLM total", summary.data.stages.llm_total],
                              ["Whole run", summary.data.stages.total],
                            ] as const
                          ).map(([label, p]) => (
                            <TableRow key={label}>
                              <TableCell className="py-1.5 text-label">{label}</TableCell>
                              <TableCell className="py-1.5 text-right text-label tabular-nums">{p.p50 != null ? formatMs(p.p50) : "–"}</TableCell>
                              <TableCell className="py-1.5 text-right text-label tabular-nums">{p.p95 != null ? formatMs(p.p95) : "–"}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </CardContent>
                  </Card>
                </div>
              </>
            ) : null}
          </>
        )}
      </div>
    </Page>
  );
}
