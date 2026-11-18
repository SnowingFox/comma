import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { AppMode } from "@comma/shared/ipc";
import { Tabs, TabsList, TabsTrigger } from "@multica/ui/components/ui/tabs";
import { PermissionList } from "../../../components/permission-list";
import { useSettings } from "../../../lib/queries";
import { useStepControls } from "../flow";
import { Split } from "./layout";

export const DATA_FLOWS: Record<AppMode, { title: string; rows: { what: string; where: string }[] }> = {
  local: {
    title: "With your own keys",
    rows: [
      { what: "Your voice", where: "Sent to ElevenLabs while you hold the shortcut, then dropped. Not saved unless you turn on Keep audio." },
      { what: "The transcript", where: "Sent to the language model you picked, to clean it up." },
      { what: "History and keys", where: "Stay on this Mac: history in a local database, keys in your Keychain." },
    ],
  },
  account: {
    title: "With a Comma account",
    rows: [
      { what: "Your voice", where: "Sent to your Comma server, which passes it to ElevenLabs. Not stored." },
      { what: "The transcript", where: "Rewritten by the server's language model and sent back to this Mac." },
      { what: "History", where: "Stays on this Mac unless you turn on Sync history. The server keeps counts, not text." },
    ],
  },
};

function DataPanel() {
  const mode = useSettings().data?.mode ?? "local";
  const [tab, setTab] = useState<AppMode>(mode);
  const data = DATA_FLOWS[tab];
  return (
    <div className="flex h-full w-full flex-col gap-3.5 self-stretch">
      <div className="flex flex-col gap-2.5">
        <h2 className="text-title-sm font-semibold">Where your data goes</h2>
        <Tabs value={tab} onValueChange={(v) => setTab(v === "account" ? "account" : "local")}>
          <TabsList>
            <TabsTrigger value="local" className="px-2.5">
              Local
            </TabsTrigger>
            <TabsTrigger value="account" className="px-2.5">
              Comma account
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <AnimatePresence mode="wait" initial={false}>
        <motion.dl
          key={tab}
          initial={{ opacity: 0, x: 8 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -8 }}
          transition={{ duration: 0.16 }}
          className="flex flex-col gap-2.5"
        >
          {data.rows.map((r) => (
            <div key={r.what} className="flex flex-col gap-0.5 rounded-xl border border-surface-border bg-surface px-3.5 py-2.5">
              <dt className="text-label font-medium">{r.what}</dt>
              <dd className="text-label text-muted-foreground">{r.where}</dd>
            </div>
          ))}
        </motion.dl>
      </AnimatePresence>
    </div>
  );
}

export function PermissionsStep() {
  useStepControls({});
  return (
    <Split
      title="Three permissions"
      lead="macOS asks once for each. The rows turn green as soon as you allow them."
      art={<DataPanel />}
      artClassName="items-stretch bg-app-shell p-5"
    >
      <PermissionList />
      <p className="text-caption text-muted-foreground">
        Input Monitoring is how macOS lets an app see the Fn key. Comma looks only at its shortcut keys and Esc; every
        other key is ignored the moment it arrives and never stored or sent. Without it, Comma uses ⌥ Space and the
        other ordinary shortcuts instead. You can change these later in System Settings, Privacy & Security.
      </p>
    </Split>
  );
}
