import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@multica/ui/components/ui/card";
import { Clock, Mic } from "@multica/ui/icons";
import { ShortcutList } from "../../../components/shortcut-list";
import { EmptyState, Page } from "../page";

const STATS = [
  { label: "Words today", value: "0", hint: "0 this week" },
  { label: "Runs today", value: "0", hint: "0 this week" },
  { label: "Time saved", value: "0 min", hint: "Against typing at 40 wpm" },
];

export function HomePage() {
  return (
    <Page title="Home">
      <div className="mx-auto flex max-w-4xl flex-col gap-6 px-8 py-7">
        <div className="flex flex-col gap-1">
          <h2 className="text-display-sm font-semibold tracking-tight">Good to see you</h2>
          <p className="text-body text-muted-foreground">Hold ⌥ Space anywhere, speak, and let go. Your text lands at the cursor.</p>
        </div>

        <div className="grid grid-cols-3 gap-3">
          {STATS.map((s) => (
            <Card key={s.label} size="sm" className="gap-1 px-4 py-3.5">
              <span className="text-label text-muted-foreground">{s.label}</span>
              <span className="text-display-sm font-semibold tabular-nums">{s.value}</span>
              <span className="text-caption text-muted-foreground">{s.hint}</span>
            </Card>
          ))}
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] gap-3">
          <Card>
            <CardHeader>
              <CardTitle>Shortcuts</CardTitle>
              <CardDescription>Works in any app with a text field.</CardDescription>
            </CardHeader>
            <CardContent>
              <ShortcutList />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Recent runs</CardTitle>
              <CardDescription>Your latest dictations, newest first.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-1">
              <EmptyState
                icon={Mic}
                title="Nothing dictated yet"
                description="Your first run shows up here with its text and timing."
                className="py-6"
              />
            </CardContent>
          </Card>
        </div>

        <p className="flex items-center gap-1.5 text-caption text-muted-foreground">
          <Clock className="size-3.5" />
          Stats count runs on this Mac only.
        </p>
      </div>
    </Page>
  );
}
