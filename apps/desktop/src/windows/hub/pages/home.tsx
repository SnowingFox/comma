import { DEFAULT_SHORTCUTS } from "@comma/shared/ipc";
import { InputMonitoringNote } from "../../../components/shortcut-notes";
import { Button } from "@multica/ui/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@multica/ui/components/ui/card";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { ChevronRight, Clock, Mic } from "@multica/ui/icons";
import { cn } from "@multica/ui/lib/utils";
import { Keycaps } from "../../../components/keycaps";
import { ShortcutList } from "../../../components/shortcut-list";
import { useRecentRuns, useUsageSummary } from "../../../lib/history-queries";
import { useSettings } from "../../../lib/queries";
import { EmptyState, Page } from "../page";
import { navigate } from "../route";
import { formatInt, formatMinutes, formatTime, minutesSaved, ModeIcon, runText, StatTile } from "./shared";

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Working late";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

function Stats() {
  const today = useUsageSummary("today").data?.totals;
  const week = useUsageSummary("7d").data?.totals;
  if (!today || !week) {
    return (
      <div className="grid grid-cols-3 gap-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-[98px] rounded-card" />
        ))}
      </div>
    );
  }
  return (
    <div className="grid grid-cols-3 gap-3">
      <StatTile label="Words today" value={formatInt(today.words)} hint={`${formatInt(week.words)} this week`} />
      <StatTile label="Runs today" value={formatInt(today.runs)} hint={`${formatInt(week.runs)} this week`} />
      <StatTile
        label="Time saved today"
        value={formatMinutes(minutesSaved(today.words))}
        hint={`${formatMinutes(minutesSaved(week.words))} this week, vs typing at 40 wpm`}
      />
    </div>
  );
}

function RecentRuns() {
  const { data, isPending } = useRecentRuns(5);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent runs</CardTitle>
        <CardDescription>Your latest dictations, newest first.</CardDescription>
        {data?.length ? (
          <CardAction>
            <Button variant="ghost" size="sm" onClick={() => navigate("history")}>
              All history
              <ChevronRight />
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-1 flex-col">
        {isPending ? (
          <div className="flex flex-col gap-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : data && data.length > 0 ? (
          <ul className="-mx-2 flex flex-col">
            {data.map((run) => (
              <li key={run.id}>
                <button
                  type="button"
                  onClick={() => navigate("history", run.id)}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <ModeIcon mode={run.mode} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className={cn("truncate text-body", !run.ok && "text-destructive")}>{runText(run)}</span>
                    <span className="truncate text-caption text-muted-foreground">
                      {formatTime(run.ts)}
                      {run.app ? ` · ${run.app}` : ""}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            icon={Mic}
            title="Nothing dictated yet"
            description="Your first run shows up here with its text and timing."
            className="py-6"
          />
        )}
      </CardContent>
    </Card>
  );
}

export function HomePage() {
  const dictate = useSettings().data?.shortcuts.dictate ?? DEFAULT_SHORTCUTS.dictate;
  return (
    <Page title="Home">
      <div className="mx-auto flex max-w-4xl flex-col gap-6 px-8 py-7">
        <InputMonitoringNote />
        <div className="flex flex-col gap-1.5">
          <h2 className="text-display-sm font-semibold tracking-tight">{greeting()}</h2>
          <p className="flex flex-wrap items-center gap-1.5 text-body text-muted-foreground">
            Hold <Keycaps accel={dictate} size="sm" /> anywhere, speak, and let go. Your text lands at
            the cursor.
          </p>
        </div>

        <Stats />

        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] items-start gap-3">
          <Card>
            <CardHeader>
              <CardTitle>Shortcuts</CardTitle>
              <CardDescription>Works in any app with a text field.</CardDescription>
            </CardHeader>
            <CardContent>
              <ShortcutList />
            </CardContent>
          </Card>
          <RecentRuns />
        </div>

        <p className="flex items-center gap-1.5 text-caption text-muted-foreground">
          <Clock className="size-3.5" />
          Stats count runs on this Mac only.
        </p>
      </div>
    </Page>
  );
}
