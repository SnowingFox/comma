import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { BarChart3, BookOpenText, Download, History, Plus, Search, Upload } from "@multica/ui/icons";
import { EmptyState, Page } from "../page";

const LATER = "Arrives with dictation in the next version";

export function HistoryPage() {
  return (
    <Page
      title="History"
      actions={
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder="Search runs" className="h-7 w-56 pl-8" disabled title={LATER} />
        </div>
      }
    >
      <EmptyState
        icon={History}
        title="No runs yet"
        description="Every dictation lands here, grouped by day, with the raw transcript, the cleaned-up text and how long each step took."
        className="h-full"
      />
    </Page>
  );
}

export function DictionaryPage() {
  return (
    <Page
      title="Dictionary"
      actions={
        <>
          <Button variant="ghost" size="sm" disabled title={LATER}>
            <Upload />
            Import CSV
          </Button>
          <Button size="sm" disabled title={LATER}>
            <Plus />
            Add term
          </Button>
        </>
      }
    >
      <EmptyState
        icon={BookOpenText}
        title="Your dictionary is empty"
        description="Add names, product terms and jargon. Comma passes them to speech to text and to the rewrite so they come out spelled right."
        className="h-full"
      />
    </Page>
  );
}

export function UsagePage() {
  return (
    <Page
      title="Usage"
      actions={
        <Button variant="ghost" size="sm" disabled title={LATER}>
          <Download />
          Export CSV
        </Button>
      }
    >
      <EmptyState
        icon={BarChart3}
        title="No usage yet"
        description="Runs, audio minutes, speech-to-text cost and tokens per day appear here after your first dictation."
        className="h-full"
      />
    </Page>
  );
}
