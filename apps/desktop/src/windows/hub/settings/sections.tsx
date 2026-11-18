import { useEffect, useId, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { match } from "ts-pattern";
import { LlmBaseUrl, ThemePreference, type ShortcutSettings } from "@comma/shared/ipc";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Switch } from "@multica/ui/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@multica/ui/components/ui/tabs";
import { Monitor, Moon, Sun } from "@multica/ui/icons";
import { Keycaps } from "../../../components/keycaps";
import { LanguageChips } from "../../../components/language-chips";
import { isMagpieUrl, LlmProviderFields, useLlmDraft } from "../../../components/llm-fields";
import { ModeChoice } from "../../../components/mode-choice";
import { PermissionList } from "../../../components/permission-list";
import { ShortcutRecorder } from "../../../components/shortcut-recorder";
import { StatusDot } from "../../../components/status-dot";
import { SttFields } from "../../../components/stt-fields";
import { errorMessage, invoke } from "../../../lib/ipc";
import { queryKeys, useAccountStatus, useServerCheck, useSettings, useUpdateSettings } from "../../../lib/queries";
import { openSetup } from "../../../lib/setup";
import { Group, Later, Row, SectionHeader } from "./ui";

const THEMES: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

const run = (p: Promise<unknown>) => p.catch((err: unknown) => toast.error(errorMessage(err)));

function AccountGroup() {
  const qc = useQueryClient();
  const settings = useSettings().data;
  const update = useUpdateSettings();
  const status = useAccountStatus();
  const url = settings?.account.server_url ?? "";
  const check = useServerCheck(url, settings?.mode === "account");
  const [draft, setDraft] = useState(url);
  const urlId = useId();
  useEffect(() => setDraft(url), [url]);
  const valid = LlmBaseUrl.safeParse(draft.trim()).success;
  const signedIn = status.data?.signed_in ?? false;

  return (
    <Group
      title="Comma account"
      description="Used when the mode is Comma account. Tokens are kept in your Keychain."
      footer={
        signedIn ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              void run(invoke("account_sign_out").then(() => Promise.all([qc.invalidateQueries({ queryKey: queryKeys.account }), qc.invalidateQueries({ queryKey: queryKeys.settings })])))
            }
          >
            Sign out
          </Button>
        ) : (
          <Button size="sm" onClick={() => void run(update.mutateAsync({ mode: "account" }).then(() => openSetup("account")))}>
            Sign in
          </Button>
        )
      }
    >
      <Row
        label={signedIn ? status.data!.name || status.data!.email : "Not signed in"}
        description={signedIn ? `${status.data!.email}${status.data!.offline ? " · server offline" : ""}` : "Sign in or create an account in setup."}
      >
        <StatusDot tone={signedIn ? (status.data!.offline ? "warn" : "ok") : "off"} />
      </Row>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={urlId} className="flex items-center gap-2 text-label font-medium">
          Server
          {settings?.mode === "account" ? (
            <span className="flex items-center gap-1.5 font-normal text-muted-foreground">
              <StatusDot tone={match(check.status).with("success", () => "ok" as const).with("error", () => "off" as const).otherwise(() => "pending" as const)} />
              {match(check.status).with("success", () => "reachable").with("error", () => "not reachable").otherwise(() => "checking")}
            </span>
          ) : null}
        </label>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) void run(update.mutateAsync({ account: { server_url: draft.trim().replace(/\/+$/, "") } }).then(() => toast.success("Server saved")));
          }}
        >
          <Input id={urlId} value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} className="font-mono" aria-invalid={!valid} />
          <Button type="submit" variant="outline" disabled={!valid || draft.trim() === url}>
            Save
          </Button>
        </form>
        {check.status === "error" && settings?.mode === "account" ? <p className="text-caption text-destructive">{errorMessage(check.error)}</p> : null}
      </div>
    </Group>
  );
}

export function GeneralSection() {
  const { data } = useSettings();
  const update = useUpdateSettings();
  return (
    <>
      <SectionHeader title="General" description="How Comma runs and how it looks." />
      <Group title="Mode" description="You can switch at any time.">
        <ModeChoice />
      </Group>
      <AccountGroup />
      <Group title="Appearance">
        <Row label="Theme" description="System follows your Mac's appearance.">
          <Tabs
            value={data?.theme ?? "system"}
            onValueChange={(value) => {
              const parsed = ThemePreference.safeParse(value);
              if (parsed.success) update.mutate({ theme: parsed.data }, { onError: (e) => toast.error(e.message) });
            }}
          >
            <TabsList>
              {THEMES.map(({ value, label, icon: Icon }) => (
                <TabsTrigger key={value} value={value} className="gap-1.5 px-2.5">
                  <Icon />
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </Row>
      </Group>
      <Group title="Setup">
        <Row label="Run setup again" description="Keys, permissions, languages, the microphone and shortcut tests, and the three modes.">
          <Button variant="outline" onClick={() => void run(openSetup())}>
            Open setup
          </Button>
        </Row>
      </Group>
    </>
  );
}

export function SpeechSection() {
  const languages = useSettings().data?.languages;
  const update = useUpdateSettings();
  const save = (patch: { spoken?: string[]; auto_detect?: boolean }) => void run(update.mutateAsync({ languages: patch }));
  return (
    <>
      <SectionHeader title="Speech to text" description="ElevenLabs Scribe turns your voice into a raw transcript." />
      <Group title="ElevenLabs">
        <SttFields label="API key" />
      </Group>
      {languages ? (
        <Group title="Languages" description="In order. The first one is used when detection is unsure.">
          <LanguageChips label="Languages you speak" value={languages.spoken} max={10} onChange={(spoken) => save({ spoken })} />
          <Row label="Detect the language automatically" description="Off: always transcribe in the first language.">
            <Switch checked={languages.auto_detect} onCheckedChange={(auto_detect) => save({ auto_detect })} />
          </Row>
        </Group>
      ) : null}
      <p className="px-0.5 text-label text-muted-foreground">
        Terms in your Dictionary are sent along as keyterms, so names and jargon come out spelled right.
      </p>
    </>
  );
}

export function LlmSection() {
  const llm = useLlmDraft();
  const save = () =>
    llm.save().then(
      (ok) => ok && toast.success("LLM settings saved"),
      (err: Error) => toast.error(err.message),
    );

  return (
    <>
      <SectionHeader title="LLM" description="The model that removes fillers, fixes punctuation and applies your corrections." />
      <Group
        title="Endpoint"
        description={isMagpieUrl(llm.draft?.base_url) ? "magpie on this Mac needs no key." : "Any OpenAI-compatible provider."}
        footer={
          <>
            <Button variant="ghost" size="sm" disabled={!llm.dirty || llm.saving} onClick={llm.reset}>
              Discard
            </Button>
            <Button size="sm" disabled={!llm.dirty || !!llm.urlError || llm.saving} onClick={() => void save()}>
              Save
            </Button>
          </>
        }
      >
        <LlmProviderFields llm={llm} />
      </Group>
      <Later items={["Temperature, max tokens and extra body JSON"]} />
    </>
  );
}

export function ContextSection() {
  return (
    <>
      <SectionHeader
        title="Context"
        description="What Comma may read, only during a run you start: the focused app's name, and for Ask Anything the selected text."
      />
      <Later items={["Off switch for app context", "Selected text for Ask Anything"]} />
    </>
  );
}

const SHORTCUT_ROWS: { mode: keyof ShortcutSettings; name: string; how: string }[] = [
  { mode: "dictate", name: "Dictate", how: "Hold, speak, release" },
  { mode: "ask", name: "Ask Anything", how: "Tap to start, tap to stop" },
  { mode: "translate", name: "Translate", how: "Hold, speak, release" },
];

export function ShortcutsSection() {
  const shortcuts = useSettings().data?.shortcuts;
  const [editing, setEditing] = useState<keyof ShortcutSettings | null>(null);
  return (
    <>
      <SectionHeader
        title="Shortcuts"
        description="Only these key combinations are registered with macOS. Comma never watches the rest of your keyboard."
      />
      <Group title="Modes">
        {SHORTCUT_ROWS.map((r) => (
          <Row key={r.mode} label={r.name} description={r.how}>
            <div className="flex items-center gap-3">
              {shortcuts ? <Keycaps accel={shortcuts[r.mode]} size="sm" /> : null}
              <Button variant="ghost" size="sm" onClick={() => setEditing(r.mode)}>
                Change
              </Button>
            </div>
          </Row>
        ))}
      </Group>
      <ShortcutRecorder mode={editing ?? "dictate"} open={editing !== null} onOpenChange={(open) => !open && setEditing(null)} />
      <Later items={["Hands-free lock with a double press"]} />
    </>
  );
}

export function SoundsSection() {
  return (
    <>
      <SectionHeader title="Sounds and bar" description="The ticks you hear and the bar you see while dictating." />
      <Later items={["Start and finish sounds", "Show the bar when idle"]} />
    </>
  );
}

export function PrivacySection() {
  return (
    <>
      <SectionHeader
        title="Privacy"
        description="Audio is recorded only while you hold the shortcut and is not kept unless you turn on Keep audio."
      />
      <Later items={["History retention", "Keep audio"]} />
    </>
  );
}

export function PermissionsSection() {
  return (
    <>
      <SectionHeader title="Permissions" description="Comma needs two macOS permissions. Status updates live." />
      <PermissionList />
    </>
  );
}
