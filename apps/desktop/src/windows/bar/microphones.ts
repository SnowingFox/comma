/**
 * "A clearly better microphone is connected" (spec 2.3.1): a rough rank from the device name.
 * Dedicated USB and studio microphones beat a headset, which beats the built-in one; phones,
 * virtual devices and meeting-app drivers never count.
 */
export function micScore(label: string): number {
  const l = label.toLowerCase();
  if (/iphone|ipad|continuity|virtual|blackhole|loopback|soundflower|zoom|teams|krisp|aggregate/.test(l)) return 0;
  if (/shure|rode|røde|yeti|elgato|focusrite|scarlett|audio-technica|at2020|samson|hyperx|razer seiren|fifine|maono|jabra|sennheiser|usb/.test(l)) return 3;
  if (/airpods|beats|headset|buds|bluetooth/.test(l)) return 2;
  if (/macbook|built-in|internal|imac|studio display/.test(l)) return 1;
  return 1.5;
}

export type Microphone = { id: string; label: string };

/** The connected microphone that is clearly better than `currentLabel`, if any. */
export function betterMicrophone(currentLabel: string, devices: Pick<MediaDeviceInfo, "deviceId" | "label">[]): Microphone | null {
  const current = micScore(currentLabel);
  let best: Microphone | null = null;
  let bestScore = current + 1.5;
  for (const d of devices) {
    if (!d.label || d.deviceId === "default" || d.label === currentLabel) continue;
    const score = micScore(d.label);
    if (score >= bestScore) {
      best = { id: d.deviceId, label: d.label.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)$/i, "") };
      bestScore = score;
    }
  }
  return best;
}
