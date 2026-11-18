import { useEffect } from "react";
import { ArrowUpRight } from "@multica/ui/icons";
import { ELEVENLABS_KEYS_URL, openExternal } from "../lib/external";
import { useSecretStatus, useSettings, useSttTest } from "../lib/queries";
import { describeSttTest, ProviderTest } from "./provider-test";
import { SecretField } from "./secret-field";
import { SttModelPicker } from "./stt-model-picker";

/**
 * ElevenLabs key, the model picker, and a Test that sends a generated one-second clip through
 * Speech to Text with the saved model. Used by onboarding and Settings.
 */
export function SttFields({ label = "ElevenLabs API key", showModel = true }: { label?: string; showModel?: boolean }) {
  const secrets = useSecretStatus();
  const modelId = useSettings().data?.stt.model_id;
  const test = useSttTest();
  const hasKey = secrets.data?.elevenlabs ?? false;
  const testReset = test.reset;

  // A new or removed key, or another model, makes the last result stale.
  useEffect(() => testReset(), [hasKey, modelId, testReset]);

  return (
    <div className="flex flex-col gap-3.5">
      <SecretField
        name="elevenlabs"
        label={label}
        description={
          <>
            The key needs the Speech to Text permission.{" "}
            <button
              type="button"
              className="text-foreground underline underline-offset-2"
              onClick={() => openExternal(ELEVENLABS_KEYS_URL)}
            >
              Create a key
              <ArrowUpRight className="ml-0.5 inline size-3" />
            </button>
          </>
        }
      />
      {showModel ? <SttModelPicker /> : null}
      <ProviderTest
        state={test}
        onTest={() => test.mutate()}
        describe={describeSttTest}
        disabled={!hasKey}
        disabledReason="Save a key to test it"
      />
    </div>
  );
}
