import { useEffect, useState } from "react";
import { BarState, RunMode, type BarPreviewPayload } from "@comma/shared/ipc";
import { mountWindow } from "../../components/providers";
import { invoke, listen } from "../../lib/ipc";
import { BarView } from "./bar-view";

/** Dev: `bar.html?state=recording&mode=translate` opens straight into a state. */
function initialState(): BarPreviewPayload {
  if (!import.meta.env.DEV) return { state: "idle" };
  const params = new URLSearchParams(window.location.search);
  return {
    state: BarState.catch("idle").parse(params.get("state")),
    mode: RunMode.catch("dictate").parse(params.get("mode")),
    message: params.get("message") ?? undefined,
  };
}

function BarApp() {
  const [view, setView] = useState<BarPreviewPayload>(initialState);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const unlisten = listen("bar://preview", setView);
    return () => void unlisten.then((off) => off());
  }, []);

  return (
    <BarView
      state={view.state}
      mode={view.mode}
      message={view.message ?? (view.state === "error" ? "Couldn't reach ElevenLabs" : undefined)}
      onDetails={() => void invoke("window_show", { label: "hub" })}
    />
  );
}

mountWindow(<BarApp />, { toaster: false });
