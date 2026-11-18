import { ShortcutList } from "../../../components/shortcut-list";
import { useStepControls } from "../flow";
import { DoneIllustration } from "../illustrations";
import { Split } from "./layout";

export function DoneStep() {
  useStepControls({ primaryLabel: "Open Comma" });
  return (
    <Split title="You're set" lead="Comma waits in the menu bar. These shortcuts work in any app." art={<DoneIllustration />}>
      <div className="rounded-xl border border-surface-border bg-surface px-4 py-3">
        <ShortcutList />
      </div>
    </Split>
  );
}
