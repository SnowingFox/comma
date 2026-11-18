import { Check } from "@multica/ui/icons";
import { SpeakToTextIllustration } from "../illustrations";
import { useStepControls } from "../flow";
import { Split } from "./layout";

export function WelcomeStep() {
  useStepControls({ primaryLabel: "Get started" });
  return (
    <Split
      title="Speak. Comma writes it down."
      lead="Hold a shortcut in any app, say what you mean, and let go. Clean, punctuated text appears at your cursor."
      art={<SpeakToTextIllustration />}
    >
      <ul className="flex flex-col gap-2.5 text-body text-muted-foreground">
        {["Fillers and false starts are removed for you", "Works in every app with a text field", "Setup takes about three minutes"].map((t) => (
          <li key={t} className="flex items-center gap-2.5">
            <span className="flex size-5 items-center justify-center rounded-full bg-success/12 text-success">
              <Check className="size-3" />
            </span>
            {t}
          </li>
        ))}
      </ul>
    </Split>
  );
}
