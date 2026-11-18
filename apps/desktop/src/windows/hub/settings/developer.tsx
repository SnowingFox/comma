import { useState } from "react";
import { toast } from "sonner";
import { BarState, RunMode, type BarPreviewPayload } from "@comma/shared/ipc";
import { Button } from "@multica/ui/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@multica/ui/components/ui/tabs";
import { cn } from "@multica/ui/lib/utils";
import { emitTo, invoke } from "../../../lib/ipc";
import { BarView } from "../../bar/bar-view";
import { Group, Row, SectionHeader } from "./ui";

const STATE_LABELS: Record<BarState, string> = {
  idle: "Idle",
  recording: "Recording",
  processing: "Processing",
  done: "Done",
  empty: "No speech",
  error: "Error",
};

const MODE_LABELS: Record<RunMode, string> = { dictate: "Dictate", ask: "Ask", translate: "Translate" };

const SAMPLE_ERROR = "Couldn't reach ElevenLabs";

/** Dev builds only: preview every bar state inline and in the real bar window. */
export function DeveloperSection() {
  const [preview, setPreview] = useState<BarPreviewPayload>({ state: "recording", mode: "dictate" });
  const [live, setLive] = useState(false);

  const send = (next: BarPreviewPayload) => {
    setPreview(next);
    if (live) void emitTo("bar", "bar://preview", next);
  };

  const toggleLive = async () => {
    try {
      if (live) {
        await invoke("window_hide", { label: "bar" });
      } else {
        await emitTo("bar", "bar://preview", preview);
        await invoke("window_show", { label: "bar" });
      }
      setLive(!live);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <>
      <SectionHeader title="Developer" description="Only in development builds." />
      <Group
        title="Floating bar"
        description="The visual states from the dictation loop. The waveform runs on a fake level signal."
        footer={
          <Button size="sm" variant={live ? "secondary" : "default"} onClick={() => void toggleLive()}>
            {live ? "Hide bar window" : "Show bar window"}
          </Button>
        }
      >
        <div
          className={cn(
            "relative flex h-36 items-end justify-center overflow-hidden rounded-lg border border-border pb-6",
            // A stand-in desktop: the bar is dark in both themes, so the stage is a fixed mid tone.
            "bg-[linear-gradient(120deg,#8ea3ba,#c7b3a2)]",
          )}
        >
          <div className="h-16 w-[360px]">
            <BarView {...preview} message={preview.state === "error" ? SAMPLE_ERROR : undefined} />
          </div>
        </div>
        <Row label="State">
          <Tabs value={preview.state} onValueChange={(v) => send({ ...preview, state: BarState.parse(v) })}>
            <TabsList>
              {BarState.options.map((s) => (
                <TabsTrigger key={s} value={s} className="px-2.5">
                  {STATE_LABELS[s]}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </Row>
        <Row label="Mode" description="Icon shown while recording.">
          <Tabs value={preview.mode ?? "dictate"} onValueChange={(v) => send({ ...preview, mode: RunMode.parse(v) })}>
            <TabsList>
              {RunMode.options.map((m) => (
                <TabsTrigger key={m} value={m} className="px-2.5">
                  {MODE_LABELS[m]}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </Row>
      </Group>
    </>
  );
}
