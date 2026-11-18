import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@multica/ui/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@multica/ui/components/ui/select";
import { listMicrophones, Recorder } from "../lib/audio/recorder";
import { errorMessage } from "../lib/ipc";
import { useSettings, useUpdateSettings } from "../lib/queries";

const DEFAULT = "default-device";

/**
 * The microphone runs use, saved as `audio.microphone_id` (empty: the system default). macOS hides
 * device names until the microphone was allowed and opened once; "Show names" opens it for a
 * moment to read them.
 */
export function MicrophonePicker() {
  const saved = useSettings().data?.audio.microphone_id ?? "";
  const update = useUpdateSettings();
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);

  const refresh = useCallback(() => {
    void listMicrophones()
      .then((list) => setDevices(list.filter((d) => d.deviceId && d.deviceId !== "default")))
      .catch(() => setDevices([]));
  }, []);

  useEffect(() => {
    refresh();
    navigator.mediaDevices?.addEventListener?.("devicechange", refresh);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", refresh);
  }, [refresh]);

  const named = devices.some((d) => d.label);
  const items = [
    { value: DEFAULT, label: "System default" },
    ...devices.map((d, i) => ({ value: d.deviceId, label: d.label || `Microphone ${i + 1}` })),
  ];
  const value = saved && devices.some((d) => d.deviceId === saved) ? saved : DEFAULT;

  return (
    <div className="flex items-center gap-2">
      <Select
        items={items}
        value={value}
        onValueChange={(v) => {
          if (typeof v !== "string") return;
          update.mutate({ audio: { microphone_id: v === DEFAULT ? "" : v } }, { onError: (e) => toast.error(errorMessage(e)) });
        }}
      >
        <SelectTrigger className="min-w-0 flex-1" aria-label="Microphone">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {!named && devices.length > 0 ? (
        <Button
          variant="outline"
          onClick={() =>
            void Recorder.open()
              .then((r) => r.close())
              .then(refresh)
              .catch((e: unknown) => toast.error(errorMessage(e)))
          }
        >
          Show names
        </Button>
      ) : null}
    </div>
  );
}
