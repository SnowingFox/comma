import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { HISTORY_DAYS, isFnAccelerator, type ContextLevel, type ShortcutSettings } from "@comma/shared/ipc";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@multica/ui/components/ui/alert-dialog";
import { Button } from "@multica/ui/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@multica/ui/components/ui/select";
import { Switch } from "@multica/ui/components/ui/switch";
import { AppWindow, Check, CircleAlert, EyeOff, Play, Scan } from "@multica/ui/icons";
import { cn } from "@multica/ui/lib/utils";
import { Keycaps } from "../../../components/keycaps";
import { PermissionList } from "../../../components/permission-list";
import { MODE_NAMES, ShortcutRecorder } from "../../../components/shortcut-recorder";
import { GlobeKeyNote, InputMonitoringNote } from "../../../components/shortcut-notes";
import { historyKeys } from "../../../lib/history-queries";
import { errorMessage, invoke } from "../../../lib/ipc";
import { queryKeys, useSettings, useUpdateSettings } from "../../../lib/queries";
import { acceleratorWords } from "../../../lib/shortcut";
import { useShortcutsStatus } from "../../../lib/shortcut-events";
import { FnKeyTest } from "../../../components/fn-key-test";
import { playTick, type TickKind } from "../../../lib/sounds";
import { DATA_FLOWS } from "../../onboarding/steps/permissions";
import { Group, Row, SectionHeader } from "./ui";

const fail = (err: unknown) => toast.error(errorMessage(err));

// ---- Context ------------------------------------------------------------------------------------

const LEVELS: { value: ContextLevel; title: string; description: string; icon: typeof AppWindow }[] = [
  {
    value: "app_and_selection",
    title: "App name and selected text",
    description: "The rewrite can match the app (a chat, an email). Ask Anything works on the text you selected.",
    icon: Scan,
  },
  {
    value: "app",
    title: "App name only",
    description: "Ask Anything only answers questions; it never reads a selection.",
    icon: AppWindow,
  },
  {
    value: "off",
    title: "Nothing",
    description: "Comma reads nothing from other apps. The rewrite is the same everywhere.",
    icon: EyeOff,
  },
];

export function ContextSection() {
  const settings = useSettings().data;
  const update = useUpdateSettings();
  const level = settings?.context_level;
  return (
    <>
      <SectionHeader
        title="Context"
        description="What Comma may read from the app you are using. Only when you start a run, never in the background, and never any other text on screen."
      />
      <Group title="What a run may read">
        <div role="radiogroup" aria-label="Context" className="flex flex-col gap-2">
          {LEVELS.map(({ value, title, description, icon: Icon }) => {
            const selected = level === value;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => update.mutate({ context_level: value }, { onError: fail })}
                className={cn(
                  "flex items-start gap-3 rounded-lg border p-3 text-left transition-[border-color,background-color] outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                  selected ? "border-foreground/30 bg-surface-selected" : "border-border bg-surface hover:bg-surface-hover",
                )}
              >
                <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-body font-medium">{title}</span>
                  <span className="text-label text-muted-foreground">{description}</span>
                </span>
                <span
                  className={cn(
                    "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors",
                    selected ? "border-foreground bg-foreground text-background" : "border-input",
                  )}
                >
                  {selected ? <Check className="size-3" /> : null}
                </span>
              </button>
            );
          })}
        </div>
      </Group>
      <p className="px-0.5 text-label text-muted-foreground">
        {settings?.mode === "account"
          ? "With a Comma account, the app name and selection are sent to your Comma server only as far as this allows."
          : "With your own keys, the app name and selection go only to your language model, inside a marked data block it is told never to follow."}{" "}
        Reading the selection needs Accessibility.
      </p>
    </>
  );
}

// ---- Shortcuts ------------------------------------------------------------------------------------

const SHORTCUT_ROWS: { mode: keyof ShortcutSettings; how: string }[] = [
  { mode: "dictate", how: "Hold, speak, let go" },
  { mode: "ask", how: "Press once to start, again to stop" },
  { mode: "translate", how: "Hold, speak, let go" },
];

export function ShortcutsSection() {
  const shortcuts = useSettings().data?.shortcuts;
  const status = useShortcutsStatus().data;
  const [editing, setEditing] = useState<keyof ShortcutSettings | null>(null);
  const dictate = shortcuts?.dictate ?? "Fn";
  return (
    <>
      <SectionHeader
        title="Shortcuts"
        description="Comma looks only at these keys and Esc. Every other key is ignored the moment it arrives and never recorded, stored or sent."
      />
      <InputMonitoringNote />
      <GlobeKeyNote />
      <Group title="Modes">
        {SHORTCUT_ROWS.map((r) => {
          const configured = shortcuts?.[r.mode];
          const active = status?.active[r.mode];
          const fallback = configured && active && active !== configured ? active : null;
          const error = status?.errors.find((e) => e.mode === r.mode);
          return (
            <div key={r.mode} className="flex flex-col gap-1.5">
              <Row label={MODE_NAMES[r.mode]} description={r.how}>
                <div className="flex items-center gap-3">
                  {configured ? <Keycaps accel={configured} size="sm" /> : null}
                  <Button variant="ghost" size="sm" onClick={() => setEditing(r.mode)}>
                    Change
                  </Button>
                </div>
              </Row>
              {fallback ? (
                <p className="text-caption text-muted-foreground">Using {acceleratorWords(fallback)} until Input Monitoring is allowed.</p>
              ) : null}
              {error ? (
                <p className="flex items-center gap-1.5 text-caption text-destructive">
                  <CircleAlert className="size-3.5 shrink-0" />
                  {error.message}
                </p>
              ) : null}
            </div>
          );
        })}
      </Group>
      <Group title="While you talk">
        <Row
          label="Hands-free"
          description={`Press ${acceleratorWords(dictate)} twice quickly (within 300 ms) to keep talking without holding it. Press once more to finish.`}
        >
          <span className="flex items-center gap-1">
            <Keycaps accel={dictate} size="sm" />
            <Keycaps accel={dictate} size="sm" />
          </span>
        </Row>
        <Row label="Cancel" description="Stops a recording or a run without inserting anything, and closes the answer card.">
          <Keycaps accel="Escape" size="sm" />
        </Row>
        {isFnAccelerator(dictate) && shortcuts && isFnAccelerator(shortcuts.ask) && isFnAccelerator(shortcuts.translate) ? (
          <Row label="Switch mode" description="Already holding Fn? Add the other key to switch to that mode in the same recording.">
            <span className="text-label text-muted-foreground">Fn, then the key</span>
          </Row>
        ) : null}
      </Group>
      <ShortcutRecorder mode={editing ?? "dictate"} open={editing !== null} onOpenChange={(open) => !open && setEditing(null)} />
    </>
  );
}

// ---- Sounds and bar ---------------------------------------------------------------------------------

const TICKS: { kind: TickKind; label: string }[] = [
  { kind: "start", label: "Start" },
  { kind: "done", label: "Done" },
  { kind: "cancel", label: "Cancel" },
];

export function SoundsSection() {
  const qc = useQueryClient();
  const feedback = useSettings().data?.feedback;
  const update = useUpdateSettings();
  const set = (patch: Partial<NonNullable<typeof feedback>>) => update.mutate({ feedback: patch }, { onError: fail });
  if (!feedback) return <SectionHeader title="Sounds and bar" />;
  return (
    <>
      <SectionHeader title="Sounds and bar" description="What you hear and see while you dictate." />
      <Group title="Sounds">
        <Row label="Play sounds" description="A soft tick when recording starts, a higher one when the text lands, a low one on cancel.">
          <Switch checked={feedback.sounds} onCheckedChange={(sounds) => set({ sounds })} aria-label="Play sounds" />
        </Row>
        <div className="flex items-center gap-1.5">
          <span className="mr-1 text-label text-muted-foreground">Listen</span>
          {TICKS.map((t) => (
            <Button key={t.kind} variant="outline" size="sm" onClick={() => playTick(t.kind)}>
              <Play />
              {t.label}
            </Button>
          ))}
        </div>
        <Row label="Lower other audio while recording" description="Music and videos get quieter while you talk, and come back when you let go.">
          <Switch checked={feedback.duck_audio} onCheckedChange={(duck_audio) => set({ duck_audio })} aria-label="Lower other audio while recording" />
        </Row>
      </Group>
      <Group title="Bar">
        <Row label="Show the bar when idle" description="A small dot at the bottom of the screen, so you always know Comma is ready.">
          <Switch checked={feedback.show_idle_bar} onCheckedChange={(show_idle_bar) => set({ show_idle_bar })} aria-label="Show the bar when idle" />
        </Row>
        <Row label="Hints" description="Short tips next to the bar while you learn the shortcuts. Each shows a few times, then stops.">
          <Switch checked={feedback.hints} onCheckedChange={(hints) => set({ hints })} aria-label="Hints" />
        </Row>
        <Row label="Show hints again" description="Start the count over for every tip.">
          <Button
            variant="outline"
            size="sm"
            disabled={!feedback.hints}
            onClick={() =>
              void invoke("hints_reset")
                .then(() => qc.invalidateQueries({ queryKey: queryKeys.settings }))
                .then(() => toast.success("Hints will show again"))
                .catch(fail)
            }
          >
            Reset
          </Button>
        </Row>
      </Group>
    </>
  );
}

// ---- Privacy ----------------------------------------------------------------------------------------

const RETENTION: Record<(typeof HISTORY_DAYS)[number], string> = { 0: "Forever", 7: "7 days", 30: "30 days", 90: "90 days" };

export function PrivacySection() {
  const qc = useQueryClient();
  const settings = useSettings().data;
  const update = useUpdateSettings();
  const [confirm, setConfirm] = useState(false);
  const privacy = settings?.privacy;
  const items = HISTORY_DAYS.map((d) => ({ value: String(d), label: RETENTION[d] }));
  const flows = DATA_FLOWS[settings?.mode ?? "local"];

  return (
    <>
      <SectionHeader
        title="Privacy"
        description="Audio is recorded only while you hold the shortcut, or until you stop a hands-free run."
      />
      {privacy ? (
        <Group title="On this Mac">
          <Row label="Keep history" description="Older runs are deleted, with their audio.">
            <Select
              items={items}
              value={String(privacy.history_days)}
              onValueChange={(v) => typeof v === "string" && update.mutate({ privacy: { history_days: Number(v) } }, { onError: fail })}
            >
              <SelectTrigger className="w-32" aria-label="Keep history">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {items.map((i) => (
                  <SelectItem key={i.value} value={i.value}>
                    {i.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
          <Row label="Keep audio" description="Saves each recording next to its history entry, so you can listen again. Off by default.">
            <Switch checked={privacy.keep_audio} onCheckedChange={(keep_audio) => update.mutate({ privacy: { keep_audio } }, { onError: fail })} aria-label="Keep audio" />
          </Row>
          <Row label="Delete all history" description="Every run, its text and any kept audio. Usage totals go too.">
            <Button variant="outline" size="sm" className="text-destructive" onClick={() => setConfirm(true)}>
              Delete…
            </Button>
          </Row>
        </Group>
      ) : null}
      <Group title={`Where your data goes: ${flows.title.toLowerCase()}`}>
        <dl className="flex flex-col gap-3">
          {flows.rows.map((r) => (
            <div key={r.what} className="flex flex-col gap-0.5">
              <dt className="text-body font-medium">{r.what}</dt>
              <dd className="text-label text-muted-foreground">{r.where}</dd>
            </div>
          ))}
          <div className="flex flex-col gap-0.5">
            <dt className="text-body font-medium">Your keyboard</dt>
            <dd className="text-label text-muted-foreground">Comma reacts only to its shortcut keys and Esc. Nothing you type is recorded.</dd>
          </div>
        </dl>
      </Group>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete all history?</AlertDialogTitle>
            <AlertDialogDescription>Every run on this Mac and any kept audio. This can't be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={() =>
                void invoke("runs_clear")
                  .then(() => qc.invalidateQueries({ queryKey: historyKeys.all }))
                  .then(() => {
                    setConfirm(false);
                    toast.success("History deleted");
                  })
                  .catch(fail)
              }
            >
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ---- Permissions ----------------------------------------------------------------------------------

export function PermissionsSection() {
  return (
    <>
      <SectionHeader title="Permissions" description="What macOS lets Comma do. Status updates every second; Check again asks macOS now, and each button opens the right pane in System Settings." />
      <PermissionList recheck />
      <FnKeyTest />
      <p className="px-0.5 text-label text-muted-foreground">
        Without Accessibility, Comma copies the text and you paste it with ⌘V. Without Input Monitoring, the Fn shortcuts
        fall back to ordinary ones such as ⌥ Space.
      </p>
    </>
  );
}
