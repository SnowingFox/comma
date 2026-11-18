import { useEffect } from "react";
import { ArrowUpRight } from "@multica/ui/icons";
import { ELEVENLABS_KEYS_URL, openExternal } from "../lib/external";
import { useSecretStatus, useSttTest } from "../lib/queries";
import { describeSttTest, ProviderTest } from "./provider-test";
import { SecretField } from "./secret-field";

/** ElevenLabs key plus a Test that sends a generated one-second clip through Speech to Text. */
export function SttFields({ label = "ElevenLabs API key" }: { label?: string }) {
  const secrets = useSecretStatus();
  const test = useSttTest();
  const hasKey = secrets.data?.elevenlabs ?? false;
  const testReset = test.reset;

  // A new or removed key makes the last result stale.
  useEffect(() => testReset(), [hasKey, testReset]);

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
