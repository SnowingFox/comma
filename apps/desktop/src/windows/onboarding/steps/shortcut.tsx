import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { DEFAULT_SHORTCUTS } from "@comma/shared/ipc";
import { Check } from "@multica/ui/icons";
import { Keycaps } from "../../../components/keycaps";
import { ShortcutRecorder } from "../../../components/shortcut-recorder";
import { useSettings } from "../../../lib/queries";
import { parseAccelerator, useShortcutHold } from "../../../lib/shortcut";
import { useStepControls } from "../flow";
import { KeyboardIllustration } from "../illustrations";
import { Split } from "./layout";

export function ShortcutStep() {
  const accel = useSettings().data?.shortcuts.dictate ?? DEFAULT_SHORTCUTS.dictate;
  const [pressed, setPressed] = useState(false);
  const [recorderOpen, setRecorderOpen] = useState(false);
  // Keys are read only while this window is focused and the recorder is closed.
  const held = useShortcutHold(accel, { enabled: !recorderOpen, onDown: () => setPressed(true) });
  const target = new Set(parseAccelerator(accel).map((c) => c.id));

  useStepControls({
    primaryLabel: "Yes, they do",
    canContinue: pressed,
    secondary: { label: "No", onClick: () => setRecorderOpen(true) },
  });

  return (
    <Split
      title="Try the Dictate shortcut"
      lead="Press and hold these keys. Do they light up?"
      art={<KeyboardIllustration target={target} held={held} />}
      artClassName="p-5"
    >
      <div className="flex flex-col items-start gap-4">
        <Keycaps accel={accel} held={held} size="lg" />
        <div className="h-6" aria-live="polite">
          <AnimatePresence mode="wait" initial={false}>
            {pressed ? (
              <motion.p
                key="ok"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex items-center gap-1.5 text-body text-success"
              >
                <Check className="size-4" /> Comma saw the whole shortcut.
              </motion.p>
            ) : (
              <motion.p key="wait" exit={{ opacity: 0 }} className="text-body text-muted-foreground">
                Waiting for you to hold all of them at once.
              </motion.p>
            )}
          </AnimatePresence>
        </div>
        <p className="text-label text-muted-foreground">
          If some keys stay dark, another app may be using them. Choose No to pick different keys.
        </p>
      </div>
      <ShortcutRecorder
        mode="dictate"
        open={recorderOpen}
        onOpenChange={(open) => {
          setRecorderOpen(open);
          if (!open) setPressed(false);
        }}
      />
    </Split>
  );
}
