import { toast } from "sonner";
import { MAGPIE_BASE_URL, ThemePreference } from "@comma/shared/ipc";
import { Button } from "@multica/ui/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@multica/ui/components/ui/tabs";
import { ArrowUpRight, Monitor, Moon, Sun } from "@multica/ui/icons";
import { LlmFields, useLlmDraft } from "../../../components/llm-fields";
import { PermissionList } from "../../../components/permission-list";
import { SecretField } from "../../../components/secret-field";
import { ModeChoice } from "../../../components/mode-choice";
import { ShortcutList } from "../../../components/shortcut-list";
import { ELEVENLABS_KEYS_URL, openExternal } from "../../../lib/external";
import { invoke } from "../../../lib/ipc";
import { useSettings, useUpdateSettings } from "../../../lib/queries";
import { Group, Later, Row, SectionHeader } from "./ui";

const THEMES: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

export function GeneralSection() {
  const { data } = useSettings();
  const update = useUpdateSettings();
  return (
    <>
      <SectionHeader title="General" description="How Comma runs and how it looks." />
      <Group title="Mode" description="You can switch at any time.">
        <ModeChoice />
      </Group>
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
        <Row label="Run setup again" description="Walk through keys, permissions and the shortcut test.">
          <Button variant="outline" onClick={() => void invoke("window_show", { label: "onboarding" })}>
            Open setup
          </Button>
        </Row>
      </Group>
    </>
  );
}

export function SpeechSection() {
  const { data } = useSettings();
  return (
    <>
      <SectionHeader title="Speech to text" description="ElevenLabs Scribe turns your voice into a raw transcript." />
      <Group
        title="ElevenLabs"
        footer={
          <Button variant="ghost" size="sm" onClick={() => openExternal(ELEVENLABS_KEYS_URL)}>
            Create a key
            <ArrowUpRight />
          </Button>
        }
      >
        <SecretField
          name="elevenlabs"
          label="API key"
          description="The key needs the Speech to Text permission. It is stored in your Keychain and never shown again."
        />
        <Row label="Model" description="Used for every run.">
          <code className="rounded-md bg-muted px-2 py-1 font-mono text-label">{data?.stt.model_id ?? "…"}</code>
        </Row>
      </Group>
      <Later items={["Preferred languages and automatic retry", "Keyterms from your dictionary"]} />
    </>
  );
}

export function LlmSection() {
  const llm = useLlmDraft();
  const isMagpie = llm.draft?.base_url.trim() === MAGPIE_BASE_URL;
  const save = () =>
    llm.save().then(
      (ok) => ok && toast.success("LLM settings saved"),
      (err: Error) => toast.error(err.message),
    );

  return (
    <>
      <SectionHeader
        title="LLM"
        description="The model that removes fillers, fixes punctuation and applies your corrections."
      />
      <Group
        title="Endpoint"
        description="Magpie on this Mac by default, or any OpenAI-compatible provider."
        footer={
          <>
            {!isMagpie ? (
              <Button variant="ghost" size="sm" className="mr-auto" onClick={() => llm.setDraft({ base_url: MAGPIE_BASE_URL })}>
                Use Magpie
              </Button>
            ) : null}
            <Button variant="ghost" size="sm" disabled={!llm.dirty || llm.saving} onClick={llm.reset}>
              Discard
            </Button>
            <Button size="sm" disabled={!llm.dirty || !!llm.urlError || llm.saving} onClick={() => void save()}>
              Save
            </Button>
          </>
        }
      >
        <LlmFields llm={llm} />
      </Group>
      <Group title="Key">
        <SecretField
          name="llm"
          label="API key"
          description="Leave empty for endpoints that need no key, such as Magpie."
        />
      </Group>
      <Later items={["Model picker from /models", "Temperature, max tokens and extra body JSON", "Connection test with latency"]} />
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

export function ShortcutsSection() {
  return (
    <>
      <SectionHeader
        title="Shortcuts"
        description="Only these key combinations are registered with macOS. Comma never watches the rest of your keyboard."
      />
      <Group title="Defaults">
        <ShortcutList />
      </Group>
      <Later items={["Change a shortcut with the recorder", "Hands-free lock with a double press"]} />
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
