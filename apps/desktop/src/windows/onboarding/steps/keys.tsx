import { toast } from "sonner";
import { LlmProviderFields, useLlmDraft } from "../../../components/llm-fields";
import { SttFields } from "../../../components/stt-fields";
import { useStepControls } from "../flow";
import { Panel, Stacked } from "./layout";

export function KeysStep() {
  const llm = useLlmDraft();
  useStepControls({
    // The LLM fields are a draft; keys go to the Keychain as soon as they are saved.
    beforeContinue: async () => {
      if (await llm.save()) return true;
      toast.error(llm.urlError ?? "Check the LLM settings");
      return false;
    },
  });

  return (
    <Stacked
      title="Connect your providers"
      lead="Comma sends your voice to ElevenLabs and the transcript to a language model you choose. You can skip this and add them later in Settings."
    >
      <div className="grid grid-cols-2 items-start gap-4">
        <Panel title="Speech to text" description="ElevenLabs Scribe">
          <SttFields />
        </Panel>
        <Panel title="Rewrite" description="Any OpenAI-compatible model">
          <LlmProviderFields llm={llm} showReasoning={false} />
        </Panel>
      </div>
    </Stacked>
  );
}
